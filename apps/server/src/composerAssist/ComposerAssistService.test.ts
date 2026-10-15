import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderComposerAssist } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";

import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ComposerAssist from "./ComposerAssistService.ts";

const proton = ProviderInstanceId.make("ClaudeProton");
const catz = ProviderInstanceId.make("ClaudeCatz");
const codex = ProviderInstanceId.make("codex");
const threadId = ThreadId.make("thread-1");
const fakeAssist = {} as ProviderComposerAssist;

describe("composer assist choices", () => {
  const instances = [
    { instanceId: proton, enabled: true, composerAssist: fakeAssist },
    { instanceId: catz, enabled: true, composerAssist: fakeAssist },
    { instanceId: codex, enabled: true },
  ];

  it("answers on the thread's own Claude account, else the first Claude", () => {
    const pick = (configured: string, preferred?: ProviderInstanceId) =>
      ComposerAssist.pickComposerAssistInstance(instances, configured, preferred)?.instanceId;
    assert.equal(pick("", catz), catz);
    assert.equal(pick("", codex), proton);
    assert.equal(pick(""), proton);
    assert.equal(pick("ClaudeCatz", proton), catz);
    assert.isUndefined(pick("missing", proton));
    assert.isNull(
      ComposerAssist.pickComposerAssistInstance(
        [{ instanceId: proton, enabled: false, composerAssist: fakeAssist }],
        "",
        proton,
      ),
    );
  });

  it("keeps the newest messages that fit, oldest first, each cut to its end", () => {
    const transcript = ComposerAssist.renderTranscript([
      { role: "user", text: "a".repeat(10_000) },
      ...Array.from({ length: 6 }, () => ({ role: "agent" as const, text: "b".repeat(5_000) })),
      { role: "user", text: "Release only after I approve." },
    ]);
    const lines = transcript.split("\n\n");
    assert.equal(lines.length, 6);
    assert.equal(lines[0], `AGENT: ${"b".repeat(4_000)}`);
    assert.equal(lines.at(-1), "USER: Release only after I approve.");
    assert.notInclude(transcript, "a".repeat(10));
  });
});

interface Harness {
  readonly service: ComposerAssist.ComposerAssistService["Service"];
  /** Every task Claude was given, in order, by instance; `taken` drains it. */
  readonly calls: Array<{ readonly instanceId: ProviderInstanceId; readonly task: string }>;
  /** The same tasks as they arrive, to wait for one run in the background. */
  readonly arrivals: Queue.Queue<{
    readonly instanceId: ProviderInstanceId;
    readonly task: string;
  }>;
  readonly setRunId: (runId: string) => Effect.Effect<void>;
  readonly setRoom: (room: boolean) => Effect.Effect<void>;
  readonly statePath: string;
}

const reply = (task: string) => {
  if (task.includes("<verdict>"))
    return "<verdict>REWRITE</verdict>\n<text>Fix the crash in ⟦1⟧.</text>";
  if (task.includes('{"decisions"')) return '{"decisions":["Push only to mp/main"]}';
  if (task.includes('{"rules"')) return '{"rules":["Never push to origin/main"]}';
  return JSON.stringify({
    cues: [
      {
        kind: "contradiction",
        quote: "push to origin/main",
        note: "Push only to mp/main",
        alternatives: ["push to mp/main"],
      },
    ],
  });
};

const makeHarness = (settings: Parameters<typeof ServerSettings.layerTest>[0] = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-composer-assist-" });
    const root = path.join(baseDir, "project");
    yield* fs.makeDirectory(root, { recursive: true });
    yield* fs.writeFileString(path.join(root, "AGENTS.md"), "# Rules\n- Push only to mp/main.\n");
    const calls: Array<{ instanceId: ProviderInstanceId; task: string }> = [];
    const arrivals = yield* Queue.unbounded<{ instanceId: ProviderInstanceId; task: string }>();
    const runId = yield* Ref.make("run-1");
    const room = yield* Ref.make(true);
    const assistFor = (instanceId: ProviderInstanceId): ProviderComposerAssist => ({
      complete: ({ task }) =>
        Effect.sync(() => calls.push({ instanceId, task })).pipe(
          Effect.andThen(Queue.offer(arrivals, { instanceId, task })),
          Effect.as(reply(task)),
        ),
      roomForBackground: Ref.get(room),
    });
    const shell = (latestRunId: string) =>
      ({
        id: threadId,
        projectId: ProjectId.make("project-1"),
        title: "Release flow",
        modelSelection: { instanceId: catz, model: "claude-opus-5-5" },
        providerInstanceId: catz,
        worktreePath: root,
        latestRunId: RunId.make(latestRunId),
      }) as unknown as OrchestrationV2ThreadShell;
    const timelineItems = [
      { type: "user_message", text: "Push only to mp/main from now on." },
      { type: "user_message", text: "/compact" },
      { type: "assistant_message", text: "Understood.", streaming: false },
    ].map((item, position) => ({ position, item }));
    const service = yield* ComposerAssist.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () => Ref.get(runId).pipe(Effect.map(shell)),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getTimelinePage: (_threadId, options) =>
              Effect.succeed({
                items: options.limit === 0 ? [] : timelineItems,
                totalItems: timelineItems.length,
                hasMore: false,
              } as never),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: () => Effect.succeed(Option.some({ workspaceRoot: root }) as never),
          }),
          Layer.succeed(
            ProviderInstanceRegistry,
            ProviderInstanceRegistry.of({
              listInstances: Effect.succeed([
                { instanceId: proton, enabled: true, composerAssist: assistFor(proton) },
                { instanceId: catz, enabled: true, composerAssist: assistFor(catz) },
                { instanceId: codex, enabled: true },
              ]),
            } as unknown as ProviderInstanceRegistry["Service"]),
          ),
          ServerSettings.layerTest(settings),
          ServerConfig.layerTest(process.cwd(), baseDir),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
    const config = yield* ServerConfig.ServerConfig.pipe(
      Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
    );
    return {
      service,
      calls,
      arrivals,
      setRunId: (value: string) => Ref.set(runId, value),
      setRoom: (value: boolean) => Ref.set(room, value),
      statePath: path.join(config.stateDir, "composer-assist-rules.json"),
    } satisfies Harness;
  }).pipe(Effect.provide(NodeServices.layer));

/** The tasks since the last call, oldest first. */
const taken = (harness: Harness) => harness.calls.splice(0);

describe("ComposerAssistService", () => {
  it.effect("rewrites a blank on the thread's account with its recent messages", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.service.blank({
        threadId,
        text: "fix the crash in ⟦1⟧ make it short _",
      });
      assert.deepEqual(result, { _tag: "rewrite", text: "Fix the crash in ⟦1⟧." });
      const [call] = taken(harness);
      assert.equal(call?.instanceId, catz);
      assert.include(call?.task, "AGENT: Understood.");
      assert.notInclude(call?.task, "/compact");
    }),
  );

  it.effect("refuses blanks the settings turned off, without asking Claude", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ composerAssist: { blanks: false } });
      const result = yield* harness.service.blank({ threadId, text: "shorter _" });
      assert.equal(result._tag, "none");
      assert.deepEqual(taken(harness), []);
    }),
  );

  it.effect("says why a blank with nothing before it does nothing, without asking Claude", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.service.blank({ threadId, text: "  _ " });
      assert.isTrue(result._tag === "none" && (result.reason?.length ?? 0) > 0);
      assert.deepEqual(taken(harness), []);
    }),
  );

  it.effect("asks for the rewrite in the language from the settings", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ composerAssist: { language: "English" } });
      yield* harness.service.blank({ threadId, text: "почини падение в ⟦1⟧ _" });
      assert.include(taken(harness)[0]?.task, "Write a REWRITE in English");

      const plain = yield* makeHarness();
      yield* plain.service.blank({ threadId, text: "почини падение в ⟦1⟧ _" });
      assert.include(taken(plain)[0]?.task, "Keep the draft's language");
    }),
  );

  it.effect("checks a draft against the thread's decisions and AGENTS.md, distilled once", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const text = "Now push to origin/main please.";
      const first = yield* harness.service.cues({ threadId, text });
      assert.deepEqual(
        first.cues.map((cue) => [cue.kind, text.slice(cue.start, cue.end)]),
        [["contradiction", "push to origin/main"]],
      );
      const firstTasks = taken(harness).map((call) => call.task);
      assert.equal(firstTasks.length, 3);
      const cuesTask = firstTasks.at(-1) ?? "";
      assert.include(cuesTask, "- Push only to mp/main");
      assert.include(cuesTask, "- Never push to origin/main");

      // Same run, same AGENTS.md: only the cue check runs again.
      yield* harness.service.cues({ threadId, text });
      assert.equal(taken(harness).length, 1);

      // A new turn: the old decisions serve while new ones are read in the background.
      yield* harness.setRunId("run-2");
      yield* Queue.clear(harness.arrivals);
      yield* harness.service.cues({ threadId, text });
      const later = [yield* Queue.take(harness.arrivals), yield* Queue.take(harness.arrivals)];
      assert.isTrue(later.some((call) => call.task.includes('{"decisions"')));

      const saved = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.readFileString(harness.statePath)),
        Effect.provide(NodeServices.layer),
      );
      assert.include(saved, "Never push to origin/main");
    }),
  );

  it.effect("stays quiet near a usage limit", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.setRoom(false);
      const result = yield* harness.service.cues({
        threadId,
        text: "Now push to origin/main please.",
      });
      assert.deepEqual(result, { cues: [] });
      assert.deepEqual(taken(harness), []);
    }),
  );
});
