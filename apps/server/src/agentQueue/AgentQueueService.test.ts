import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentQueue from "./AgentQueueService.ts";

const projectId = ProjectId.make("project-queue");
const modelSelection = {
  instanceId: ProviderInstanceId.make("claude"),
  model: "claude-opus-5-5",
} satisfies ModelSelection;

const launch = (title: string) => ({
  projectId,
  title,
  text: `/take-card ${title}`,
  modelSelection,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
});

/** A launched thread as the shell snapshot shows it: working, or waiting for an answer. */
const shell = (id: string, state: "working" | "asking") =>
  ({
    id: ThreadId.make(id),
    title: id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
    archivedAt: null,
    settledOverride: null,
    status: "running",
    activityRunStatus: "running",
    pendingRuntimeRequest:
      state === "asking"
        ? {
            id: RuntimeRequestId.make(`request-${id}`),
            kind: "user_input",
            createdAt: DateTime.makeUnsafe(0),
          }
        : null,
    pendingBackgroundTasks: [],
    latestUserMessageAt: null,
    latestRunId: RunId.make(`run-${id}`),
    latestRunRequestedAt: DateTime.makeUnsafe(0),
    latestRunStartedAt: DateTime.makeUnsafe(0),
    latestRunCompletedAt: null,
  }) as unknown as OrchestrationV2ThreadShell;

const makeHarness = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agent-queue-" });
  const launched: Array<string> = [];
  const shells = yield* Ref.make<ReadonlyArray<OrchestrationV2ThreadShell>>([]);
  const due: Array<Effect.Effect<void>> = [];
  const register = <E, R>(_name: string, work: Effect.Effect<void, E, R>) =>
    Effect.context<R>().pipe(
      Effect.map((context) => {
        due.push(work.pipe(Effect.provideContext(context), Effect.ignore));
      }),
    );
  const service = yield* AgentQueue.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(Scheduler.Scheduler, Scheduler.Scheduler.of({ register })),
        Layer.mock(Orchestrator.OrchestratorV2)({
          getShellSnapshot: () =>
            Ref.get(shells).pipe(
              Effect.map((threads) => ({
                schemaVersion: 1,
                snapshotSequence: 0,
                threads,
                archivedThreads: [],
              })),
            ),
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: (input) =>
            Effect.sync(() => {
              launched.push(input.title);
              return {
                threadId: ThreadId.make(`thread-${launched.length}`),
                resumed: false,
              } as unknown as ThreadLaunch.ThreadLaunchResult;
            }),
        }),
        ServerSettings.layerTest(),
        ServerConfig.layerTest(process.cwd(), baseDir),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  );
  return {
    service,
    launched,
    shells,
    tick: TestClock.adjust("16 seconds").pipe(
      Effect.andThen(Effect.forEach(due, (work) => work, { discard: true })),
    ),
  };
});

const waitingCounts = (service: AgentQueue.AgentQueueService["Service"]) =>
  service.subscribe().pipe(
    Stream.runHead,
    Effect.map((queues) =>
      queues._tag === "Some" ? queues.value.map((queue) => queue.waiting.length) : [],
    ),
  );

describe("AgentQueueService", () => {
  it.effect("starts two at once and the next one when a slot frees up", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const queue = yield* harness.service.start({
          label: "Cards",
          maxRunning: 2,
          launches: ["A", "B", "C", "D"].map(launch),
        });
        assert.deepEqual(harness.launched, ["A", "B"]);
        assert.deepEqual(
          queue.started.map((thread) => thread.threadId),
          ["thread-1", "thread-2"],
        );
        assert.isTrue(yield* harness.service.hasWaiting);

        // Both work: nothing starts.
        yield* Ref.set(harness.shells, [
          shell("thread-1", "working"),
          shell("thread-2", "working"),
        ]);
        yield* harness.tick;
        assert.deepEqual(harness.launched, ["A", "B"]);

        // One waits for an answer: its slot goes to C.
        yield* Ref.set(harness.shells, [shell("thread-1", "asking"), shell("thread-2", "working")]);
        yield* harness.tick;
        assert.deepEqual(harness.launched, ["A", "B", "C"]);
        assert.deepEqual(yield* waitingCounts(harness.service), [1]);

        // All of them are done: D starts and the queue is gone.
        yield* Ref.set(harness.shells, []);
        yield* harness.tick;
        assert.deepEqual(harness.launched, ["A", "B", "C", "D"]);
        assert.deepEqual(yield* waitingCounts(harness.service), []);
        assert.isFalse(yield* harness.service.hasWaiting);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("cancelling drops the waiting launches and keeps the started ones", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        const queue = yield* harness.service.start({
          label: "Cards",
          maxRunning: 1,
          launches: ["A", "B", "C"].map(launch),
        });
        yield* harness.service.cancel(queue.id);
        assert.isFalse(yield* harness.service.hasWaiting);
        yield* harness.tick;
        assert.deepEqual(harness.launched, ["A"]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
