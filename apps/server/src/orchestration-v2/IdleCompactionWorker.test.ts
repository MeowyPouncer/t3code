import { assert, describe, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import {
  IDLE_COMPACTION_AFTER_MS,
  IDLE_COMPACTION_LATE_MS,
  idleCompactionCandidate,
  idleCompactionContextSkip,
  idleCompactionThreadSkip,
  latestIdleCompactionContext,
  makeIdleCompactionWorker,
  type IdleCompactionCandidate,
  type IdleCompactionThread,
} from "./IdleCompactionWorker.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const threadId = ThreadId.make("thread-idle");
const runId = RunId.make("run-1");
const modelSelection = { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus-5-5" };
const HOUR_MS = 60 * 60_000;

const run = (overrides: Partial<OrchestrationV2Run> = {}) =>
  ({
    id: runId,
    threadId,
    status: "completed",
    completedAt: DateTime.makeUnsafe(0),
    modelSelection,
    ...overrides,
  }) as OrchestrationV2Run;

const candidate: IdleCompactionCandidate = {
  threadId,
  runId,
  completedAtMs: 0,
  modelSelection,
};

const idleThread: IdleCompactionThread = {
  modelSelection,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  latestRunId: runId,
  activeRunId: null,
  activityRunStatus: null,
  pendingRuntimeRequest: null,
  pendingBackgroundTasks: [],
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
} as unknown as IdleCompactionThread;

const report = (usedTokens: number, updatedAtMs: number, promptCacheTtlMs?: number) => ({
  tokenUsage: {
    usedTokens,
    updatedAt: DateTime.formatIso(DateTime.makeUnsafe(updatedAtMs)),
    ...(promptCacheTtlMs === undefined ? {} : { promptCacheTtlMs }),
  },
});

describe("idle compaction decisions", () => {
  it("makes a thread due when a run leaves it idle, never after a failure or its own compaction", () => {
    assert.deepEqual(idleCompactionCandidate(run()), candidate);
    assert.deepEqual(idleCompactionCandidate(run({ status: "interrupted" }))?.runId, runId);
    assert.isNull(idleCompactionCandidate(run({ status: "failed" })));
    assert.isNull(idleCompactionCandidate(run({ status: "cancelled" })));
    assert.isNull(idleCompactionCandidate(run({ status: "running", completedAt: null })));
    assert.isNull(idleCompactionCandidate(run({ idleCompactionOfRunId: RunId.make("run-0") })));
  });

  it("leaves a thread alone unless it still sits idle where it was", () => {
    const skip = (thread: Partial<IdleCompactionThread>, nowMs = IDLE_COMPACTION_AFTER_MS) =>
      idleCompactionThreadSkip({ candidate, thread: { ...idleThread, ...thread }, nowMs });
    assert.isNull(skip({}));
    // Shelved threads are compacted: the user comes back to them later.
    assert.isNull(skip({ shelvedAt: DateTime.makeUnsafe(0) } as Partial<IdleCompactionThread>));
    assert.equal(skip({}, IDLE_COMPACTION_LATE_MS + 1), "late");
    assert.equal(skip({ archivedAt: DateTime.makeUnsafe(0) }), "archived");
    assert.equal(skip({ settledOverride: "settled" }), "settled");
    assert.equal(skip({ settledAt: DateTime.makeUnsafe(0) }), "settled");
    assert.equal(
      skip({
        lineage: {
          parentThreadId: ThreadId.make("parent"),
          relationshipToParent: "subagent",
          rootThreadId: ThreadId.make("parent"),
        },
      } as Partial<IdleCompactionThread>),
      "subagent",
    );
    assert.equal(skip({ snoozedUntil: DateTime.makeUnsafe(2 * HOUR_MS) }), "snoozed");
    assert.isNull(skip({ snoozedUntil: DateTime.makeUnsafe(1) }));
    assert.equal(skip({ latestRunId: RunId.make("run-2") }), "busy");
    assert.equal(skip({ activityRunStatus: "running" }), "busy");
    assert.equal(
      skip({ pendingRuntimeRequest: {} } as unknown as Partial<IdleCompactionThread>),
      "busy",
    );
    assert.equal(
      skip({ modelSelection: { ...modelSelection, model: "claude-sonnet-5-5" } }),
      "model_changed",
    );
  });

  it("reads the size from the latest report and the cache lifetime from the latest that wrote one", () => {
    assert.isNull(latestIdleCompactionContext([{}]));
    assert.deepEqual(
      latestIdleCompactionContext([report(100_000, 1, HOUR_MS), report(320_000, 3), {}]),
      { usedTokens: 320_000, promptCacheTtlMs: HOUR_MS },
    );
    assert.deepEqual(latestIdleCompactionContext([report(320_000, 3)]), {
      usedTokens: 320_000,
      promptCacheTtlMs: null,
    });
  });

  it("compacts only a one-hour cache holding at least the instance's threshold", () => {
    const policy = { minTokens: 200_000 };
    const context = { usedTokens: 320_000, promptCacheTtlMs: HOUR_MS };
    assert.isNull(idleCompactionContextSkip({ policy, context }));
    assert.equal(idleCompactionContextSkip({ policy: null, context }), "provider_off");
    assert.equal(idleCompactionContextSkip({ policy, context: null }), "no_context");
    assert.equal(
      idleCompactionContextSkip({ policy, context: { ...context, promptCacheTtlMs: 300_000 } }),
      "short_cache",
    );
    assert.equal(
      idleCompactionContextSkip({ policy, context: { ...context, promptCacheTtlMs: null } }),
      "short_cache",
    );
    assert.equal(
      idleCompactionContextSkip({ policy, context: { ...context, usedTokens: 150_000 } }),
      "small",
    );
  });
});

const makeHarness = Effect.gen(function* () {
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const shell = yield* Ref.make<OrchestrationV2ThreadShell | null>(null);
  const lastVisitedAt = yield* Ref.make<DateTime.Utc | null>(null);
  const layer = Layer.mergeAll(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: () => Ref.get(shell),
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return {} as Effect.Success<
            ReturnType<ThreadManagement.ThreadManagementServiceShape["dispatch"]>
          >;
        }),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getShellSnapshot: () =>
        Effect.succeed({
          schemaVersion: 1,
          snapshotSequence: 0,
          threads: [],
          archivedThreads: [],
        } as unknown as Effect.Success<
          ReturnType<ProjectionStore.ProjectionStoreV2Shape["getShellSnapshot"]>
        >),
      getThreadRecords: (_threadId, fields) =>
        Ref.get(lastVisitedAt).pipe(
          Effect.map(
            (visitedAt) =>
              ({
                thread: { lastVisitedAt: visitedAt },
                providerTurns: fields.includes("providerTurns" as never)
                  ? [report(320_000, 0, HOUR_MS)]
                  : [],
                runs: [run()],
              }) as never,
          ),
        ),
    }),
    Layer.succeed(
      ProviderInstanceRegistry,
      ProviderInstanceRegistry.of({
        getInstance: () =>
          Effect.succeed({
            idleCompaction: Effect.succeed({ minTokens: 200_000 }),
          } as unknown as ProviderInstance),
      } as unknown as ProviderInstanceRegistry["Service"]),
    ),
  );
  const worker = yield* makeIdleCompactionWorker.pipe(Effect.provide(layer));
  return { worker, dispatched, shell, lastVisitedAt };
});

const runEvent = (
  type: "run.created" | "run.updated",
  payload: OrchestrationV2Run,
): OrchestrationV2DomainEvent =>
  ({ type, threadId: payload.threadId, payload }) as unknown as OrchestrationV2DomainEvent;

describe("IdleCompactionWorker", () => {
  it.effect("compacts a thread 50 minutes after its turn and keeps it seen", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.shell, {
        ...idleThread,
        id: threadId,
        providerInstanceId: modelSelection.instanceId,
      } as unknown as OrchestrationV2ThreadShell);
      yield* harness.worker.onEvent(runEvent("run.updated", run()));

      yield* TestClock.adjust(IDLE_COMPACTION_AFTER_MS - 60_000);
      yield* harness.worker.runDueWork;
      assert.lengthOf(harness.dispatched, 0);

      yield* TestClock.adjust(60_000);
      yield* harness.worker.runDueWork;
      const compact = harness.dispatched[0];
      assert.equal(compact?.type, "message.dispatch");
      if (compact?.type !== "message.dispatch") return;
      assert.equal(compact.text, "/compact");
      assert.equal(compact.idleCompactionOfRunId, runId);
      assert.equal(compact.createdBy, "system");
      assert.deepEqual(compact.dispatchMode, { type: "start_immediately" });

      // Once due, a thread is not compacted twice for the same turn.
      yield* harness.worker.runDueWork;
      assert.lengthOf(harness.dispatched, 1);

      // The user had seen the thread before it went idle, so the compaction stays seen.
      yield* Ref.set(harness.lastVisitedAt, DateTime.makeUnsafe(1));
      const compactedAt = DateTime.makeUnsafe(IDLE_COMPACTION_AFTER_MS + 90_000);
      yield* harness.worker.onEvent(
        runEvent(
          "run.updated",
          run({
            id: RunId.make("run-compact"),
            idleCompactionOfRunId: runId,
            completedAt: compactedAt,
          }),
        ),
      );
      const visit = harness.dispatched[1];
      assert.equal(visit?.type, "thread.visit");
      if (visit?.type !== "thread.visit") return;
      assert.equal(visit.visitedAt, DateTime.formatIso(compactedAt));
    }),
  );

  it.effect("drops a thread that started another run before it was due", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* harness.worker.onEvent(runEvent("run.updated", run()));
      yield* harness.worker.onEvent(runEvent("run.created", run({ id: RunId.make("run-2") })));
      yield* TestClock.adjust(IDLE_COMPACTION_AFTER_MS);
      yield* harness.worker.runDueWork;
      assert.lengthOf(harness.dispatched, 0);
    }),
  );

  it.effect("leaves an unseen thread unseen after its compaction", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      // Visited before the turn it went idle after ended.
      yield* Ref.set(harness.lastVisitedAt, DateTime.makeUnsafe(-1));
      yield* harness.worker.onEvent(
        runEvent(
          "run.updated",
          run({
            id: RunId.make("run-compact"),
            idleCompactionOfRunId: runId,
            completedAt: DateTime.makeUnsafe(IDLE_COMPACTION_AFTER_MS),
          }),
        ),
      );
      assert.lengthOf(harness.dispatched, 0);
    }),
  );
});
