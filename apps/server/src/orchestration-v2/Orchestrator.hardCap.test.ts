import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed to answer a request"),
} as ProviderAdapterV2Shape;
const declining = {
  providerInstances: {
    [instanceId]: { driver, hardCap: { declineFileChanges: true } },
  },
};

const layerFor = (settings: Parameters<typeof ServerSettings.layerTest>[0]) => {
  const layerDatabase = SqlitePersistence.layerMemory;
  return Layer.mergeAll(
    ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
    ProviderReplayHarness.layerWithRegistry(
      { name: "hard-cap-respond" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { databaseLayer: layerDatabase, runEffectWorker: false },
    ),
  ).pipe(Layer.provideMerge(ServerSettings.layerTest(settings).pipe(Layer.orDie)));
};

/** A thread on the codex instance with one pending file-change approval. */
const pendingFileChange = (suffix: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make(`thread:hard-cap-${suffix}`);
    const sessionId = ProviderSessionId.make(`session:hard-cap-${suffix}`);
    const requestId = RuntimeRequestId.make(`request:hard-cap-${suffix}`);
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${suffix}`),
      threadId,
      projectId: ProjectId.make("project:hard-cap"),
      title: "Hard cap",
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* projections.apply({
      id: EventId.make(`attach:${suffix}`),
      type: "provider-session.attached",
      threadId,
      occurredAt: now,
      payload: {
        id: sessionId,
        driver,
        providerInstanceId: instanceId,
        status: "ready",
        cwd: "/repo",
        model: "gpt-5.1-codex",
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    });
    yield* projections.apply({
      id: EventId.make(`request:${suffix}`),
      type: "runtime-request.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: requestId,
        nodeId: NodeId.make(`node:${suffix}`),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "file-change",
        status: "pending",
        responseCapability: { type: "live", providerSessionId: sessionId },
        createdAt: now,
        resolvedAt: null,
      },
    });
    const respond = (decision: "accept" | "acceptForSession" | "decline") =>
      orchestrator
        .dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make(`respond:${suffix}:${decision}`),
          threadId,
          requestId,
          decision,
        })
        .pipe(Effect.exit);
    const status = projections
      .getRuntimeRequest(threadId, requestId)
      .pipe(Effect.map((request) => request?.status));
    return { respond, status };
  });

it.effect("refuses an Accept of a declining instance's file change and takes the Decline", () =>
  Effect.gen(function* () {
    const request = yield* pendingFileChange("declining");
    // The user's Accept may land before FileChangeAutoDecline's Decline.
    assert.isTrue(Exit.isFailure(yield* request.respond("accept")));
    assert.isTrue(Exit.isFailure(yield* request.respond("acceptForSession")));
    assert.equal(yield* request.status, "pending");
    assert.isTrue(Exit.isSuccess(yield* request.respond("decline")));
    assert.equal(yield* request.status, "resolved");
  }).pipe(Effect.provide(layerFor(declining))),
);

it.effect("refuses an Accept of a file change that was pending before the cap", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const before = yield* pendingFileChange("before-cap");
    const uncapped = yield* pendingFileChange("uncapped");
    // Without a cap the same request takes an Accept.
    assert.isTrue(Exit.isSuccess(yield* uncapped.respond("accept")));
    yield* settings.updateSettings(declining);
    assert.isTrue(Exit.isFailure(yield* before.respond("accept")));
    assert.equal(yield* before.status, "pending");
    assert.isTrue(Exit.isSuccess(yield* before.respond("decline")));
  }).pipe(Effect.provide(layerFor({}))),
);
