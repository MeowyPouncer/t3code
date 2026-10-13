import { assert, it } from "@effect/vitest";
import {
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  ServerSettingsError,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as NightRules from "../night/NightRules.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

const projectId = ProjectId.make("project:runtime-policy");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.5",
} satisfies ModelSelection;

function makeThread(input: {
  readonly now: DateTime.Utc;
  readonly worktreePath: string | null;
  readonly runtimeMode?: RuntimeMode;
}): OrchestrationV2AppThread {
  const threadId = ThreadId.make("thread:runtime-policy");
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Runtime policy",
    providerInstanceId,
    modelSelection,
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: input.worktreePath,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

// Grok's instance offers no Auto-accept edits; the Codex instance advertises no
// restriction.
const grokInstanceId = ProviderInstanceId.make("grok");
const supportedRuntimeModesByInstance = new Map<ProviderInstanceId, ReadonlyArray<RuntimeMode>>([
  [grokInstanceId, ["approval-required", "auto", "full-access"]],
]);
const providerInstanceFor = (instanceId: ProviderInstanceId) =>
  ({
    snapshot: {
      getSnapshot: Effect.succeed({
        supportedRuntimeModes: supportedRuntimeModesByInstance.get(instanceId),
      } as ServerProvider),
    },
  }) as ProviderInstance;

const projectRow = {
  projectId,
  title: "Project",
  workspaceRoot: "/project-root",
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  createdAt: "2026-06-21T00:00:00.000Z",
  updatedAt: "2026-06-21T00:00:00.000Z",
  deletedAt: null,
};

const layerWithProjectGet = (get: ProjectStore.ProjectStoreV2["Service"]["get"]) =>
  RuntimePolicy.layerFromProjectStore.pipe(
    Layer.provide(
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: (instanceId) => Effect.succeed(providerInstanceFor(instanceId)),
        listInstances: Effect.succeed([]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      }),
    ),
    Layer.provide(Layer.mock(ProjectStore.ProjectStoreV2)({ get })),
  );

const layerTest = layerWithProjectGet(() => Effect.succeed(Option.some(projectRow)));

// FORK: the night mode's rules, set and cleared the way NightService does.
it.layer(layerTest.pipe(Layer.provideMerge(NightRules.layer)))("RuntimePolicyV2 at night", (it) => {
  it.effect(
    "adds the night rules to a session's instructions, not the overseer's or a subagent's",
    () =>
      Effect.gen(function* () {
        const policy = yield* RuntimePolicy.RuntimePolicyV2;
        const rules = yield* NightRules.NightRules;
        const now = yield* DateTime.now;
        const thread = { ...makeThread({ now, worktreePath: null }), instructions: "Orchestrate." };
        const overseer = { ...thread, id: ThreadId.make("thread:overseer") };
        const subagent = {
          ...thread,
          lineage: { ...thread.lineage, relationshipToParent: "subagent" as const },
        };
        const instructionsOf = (input: OrchestrationV2AppThread) =>
          policy
            .resolve({ thread: input, modelSelection })
            .pipe(Effect.map((resolved) => resolved.instructions));

        yield* rules.set({ rules: "Nobody answers tonight.", overseerThreadId: overseer.id });
        assert.equal(
          yield* instructionsOf(thread),
          "Orchestrate.\n\n<night_rules>\nNobody answers tonight.\n</night_rules>",
        );
        assert.equal(yield* instructionsOf(overseer), "Orchestrate.");
        assert.equal(yield* instructionsOf(subagent), "Orchestrate.");

        yield* rules.set(null);
        assert.equal(yield* instructionsOf(thread), "Orchestrate.");
      }),
  );
});

it.layer(layerTest)("RuntimePolicyV2", (it) => {
  it.effect("uses the project root for local-checkout threads", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: null }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/project-root");
      // FORK: the root checkout also reaches the provider's hooks as T3CODE_PROJECT_ROOT.
      assert.equal(resolved.projectRoot, "/project-root");
    }),
  );

  it.effect("hands the thread's own instructions to the adapter", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const thread = makeThread({ now, worktreePath: null });
      const plain = yield* policy.resolve({ thread, modelSelection });
      assert.isUndefined(plain.instructions);
      const resolved = yield* policy.resolve({
        thread: { ...thread, instructions: "Orchestrate the selected cards." },
        modelSelection,
      });
      assert.equal(resolved.instructions, "Orchestrate the selected cards.");
    }),
  );

  it.effect("prefers a provisioned worktree over the project root", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: "/project-worktree" }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/project-worktree");
      // FORK: a worktree thread still names the project's root checkout, not its worktree.
      assert.equal(resolved.projectRoot, "/project-root");
    }),
  );

  it.effect("runs a mode the provider does not offer in Supervised", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const modeFor = (instanceId: ProviderInstanceId, runtimeMode: RuntimeMode) =>
        policy
          .resolve({
            thread: makeThread({ now, worktreePath: null, runtimeMode }),
            modelSelection: { instanceId, model: "test-model" },
          })
          .pipe(Effect.map((resolved) => resolved.runtimeMode));

      assert.equal(yield* modeFor(grokInstanceId, "auto-accept-edits"), "approval-required");
      assert.equal(yield* modeFor(grokInstanceId, "auto"), "auto");
      assert.equal(yield* modeFor(grokInstanceId, "full-access"), "full-access");
      // A provider that advertises no restriction runs every mode as stored.
      assert.equal(yield* modeFor(providerInstanceId, "auto-accept-edits"), "auto-accept-edits");
    }),
  );
});

it.layer(
  layerWithProjectGet(() =>
    Effect.fail(new ProjectStore.ProjectStoreV2Error({ operation: "get", cause: "offline" })),
  ),
)("RuntimePolicyV2 with an unreadable project", (it) => {
  it.effect("keeps a worktree thread running without its project root", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now, worktreePath: "/project-worktree" }),
        modelSelection,
      });
      assert.equal(resolved.cwd, "/project-worktree");
      assert.isUndefined(resolved.projectRoot);
    }),
  );

  it.effect("still fails a local-checkout thread, which has no other cwd", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const error = yield* policy
        .resolve({ thread: makeThread({ now, worktreePath: null }), modelSelection })
        .pipe(Effect.flip);
      assert.equal(error._tag, "RuntimePolicyResolveError");
    }),
  );
});

const antigravityInstanceId = ProviderInstanceId.make("antigravity");
const layerCappedTest = layerTest.pipe(
  Layer.provide(
    ServerSettings.layerTest({
      providerInstances: {
        [antigravityInstanceId]: {
          driver: ProviderDriverKind.make("antigravity"),
          hardCap: { maxRuntimeMode: "approval-required", declineFileChanges: true },
        },
        // Capped at a mode Grok does not offer: the cap applies first, then
        // the provider's own fallback.
        [grokInstanceId]: {
          driver: ProviderDriverKind.make("grok"),
          hardCap: { maxRuntimeMode: "auto-accept-edits" },
        },
      },
    }).pipe(Layer.orDie),
  ),
);

it.layer(layerCappedTest)("RuntimePolicyV2 hard cap", (it) => {
  it.effect("runs every thread on a capped instance within its cap, whatever it stores", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const modeFor = (instanceId: ProviderInstanceId, runtimeMode: RuntimeMode) =>
        policy
          .resolve({
            thread: makeThread({ now, worktreePath: null, runtimeMode }),
            modelSelection: { instanceId, model: "test-model" },
          })
          .pipe(Effect.map((resolved) => resolved.runtimeMode));

      // A thread stored as full access (the composer, t3_thread_send, a
      // schedule, or created before the cap) still runs Supervised on agy.
      assert.equal(yield* modeFor(antigravityInstanceId, "full-access"), "approval-required");
      assert.equal(yield* modeFor(antigravityInstanceId, "auto"), "approval-required");
      assert.equal(yield* modeFor(antigravityInstanceId, "approval-required"), "approval-required");
      assert.equal(yield* modeFor(grokInstanceId, "full-access"), "approval-required");
      // An uncapped instance runs as stored.
      assert.equal(yield* modeFor(providerInstanceId, "full-access"), "full-access");
    }),
  );

  it.effect("tells the adapter when the instance declines file changes", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const declineFor = (instanceId: ProviderInstanceId) =>
        policy
          .resolve({
            thread: makeThread({ now, worktreePath: null }),
            modelSelection: { instanceId, model: "test-model" },
          })
          .pipe(Effect.map((resolved) => resolved.declineFileChanges));
      assert.isTrue(yield* declineFor(antigravityInstanceId));
      assert.isUndefined(yield* declineFor(grokInstanceId));
      assert.isUndefined(yield* declineFor(providerInstanceId));
    }),
  );
});

const layerUnreadableTest = layerTest.pipe(
  Layer.provide(
    Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Effect.fail(
        new ServerSettingsError({ settingsPath: "/settings.json", operation: "read-file" }),
      ),
    }),
  ),
);

it.layer(layerUnreadableTest)("RuntimePolicyV2 without readable caps", (it) => {
  it.effect("runs Supervised with file changes declined", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const resolved = yield* policy.resolve({
        thread: makeThread({ now: yield* DateTime.now, worktreePath: null }),
        modelSelection,
      });
      assert.equal(resolved.runtimeMode, "approval-required");
      assert.isTrue(resolved.declineFileChanges);
    }),
  );
});
