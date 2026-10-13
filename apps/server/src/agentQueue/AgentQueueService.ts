// FORK: starts a batch of agent threads a few at a time, each once an earlier one stops working, so
// twenty cards cannot start twenty agents at once. Tasks and the night's end-of-night agents use it.
import {
  AgentQueue,
  AgentQueueError,
  CommandId,
  MessageId,
  type AgentLaunch,
  type AgentQueueStartInput,
  type ThreadId,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import { nightSessions } from "../night/nightLogic.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import { launchesToStart } from "./agentQueueLogic.ts";

/** How often T3 looks for free slots while launches wait. */
const CHECK_INTERVAL_MS = 15_000;

export class AgentQueueService extends Context.Service<
  AgentQueueService,
  {
    /** Starts the first launches at once and the rest as slots free up. */
    readonly start: (input: AgentQueueStartInput) => Effect.Effect<AgentQueue, AgentQueueError>;
    /** Drops a queue's waiting launches; the threads it started keep working. */
    readonly cancel: (id: string) => Effect.Effect<void, AgentQueueError>;
    /** Queues with launches waiting, on subscribe and after every change. */
    readonly subscribe: () => Stream.Stream<ReadonlyArray<AgentQueue>>;
    /** Whether any launch still waits for a slot. */
    readonly hasWaiting: Effect.Effect<boolean>;
  }
>()("t3/agentQueue/AgentQueueService") {}

const QueuesJson = Schema.fromJsonString(Schema.Array(AgentQueue));
const decodeQueues = Schema.decodeUnknownEffect(QueuesJson);
const encodeQueues = Schema.encodeEffect(QueuesJson);

const errorDetail = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threadLaunch = yield* ThreadLaunch.ThreadLaunchService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const scheduler = yield* Scheduler.Scheduler;

  const statePath = path.join(config.stateDir, "agent-queues.json");
  const saved = yield* fs
    .readFileString(statePath)
    .pipe(Effect.flatMap(decodeQueues), Effect.option);
  const queuesRef = yield* Ref.make<ReadonlyArray<AgentQueue>>(
    saved._tag === "Some" ? saved.value : [],
  );
  const changes = yield* PubSub.sliding<ReadonlyArray<AgentQueue>>(1);
  const lock = yield* Semaphore.make(1);
  const locked = lock.withPermits(1);
  let lastCheckAtMs = 0;

  const setQueues = (queues: ReadonlyArray<AgentQueue>) =>
    Effect.gen(function* () {
      // Only queues with launches left are kept; the rest have done their work.
      const kept = queues.filter((queue) => queue.waiting.length > 0);
      yield* (
        kept.length === 0
          ? fs.remove(statePath, { force: true })
          : encodeQueues(kept).pipe(
              Effect.flatMap((contents) =>
                writeFileStringAtomically({ filePath: statePath, contents: `${contents}\n` }),
              ),
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
            )
      ).pipe(
        Effect.mapError(
          (cause) =>
            new AgentQueueError({
              operation: "persist",
              detail: `Could not save the agent queue: ${errorDetail(cause)}`,
            }),
        ),
      );
      yield* Ref.set(queuesRef, kept);
      yield* PubSub.publish(changes, kept);
    });

  const launch = (queue: AgentQueue, ordinal: number, launch: AgentLaunch) =>
    threadLaunch
      .launch({
        // Keyed by the launch's place in the queue, so a retry starts it once.
        commandId: CommandId.make(`agent-queue:${queue.id}:${ordinal}`),
        projectId: launch.projectId,
        title: launch.title,
        modelSelection: launch.modelSelection,
        runtimeMode: launch.runtimeMode,
        interactionMode: launch.interactionMode,
        workspaceStrategy: { type: "root" },
        initialMessage: {
          messageId: MessageId.make(`agent-queue:${queue.id}:${ordinal}`),
          text: launch.text,
          attachments: [],
        },
        createdBy: "user",
        creationSource: "server",
        ...(launch.instructions === undefined ? {} : { instructions: launch.instructions }),
      })
      .pipe(Effect.result);

  /** Starts as many waiting launches as the queue has free slots, in order. */
  const fill = (queue: AgentQueue, works: (threadId: ThreadId) => boolean) =>
    Effect.gen(function* () {
      const count = launchesToStart(queue, works);
      if (count === 0) return queue;
      const started = [...queue.started];
      const failed = [...queue.failed];
      for (const item of queue.waiting.slice(0, count)) {
        const result = yield* launch(queue, started.length + failed.length, item);
        if (result._tag === "Success") {
          started.push({ threadId: result.success.threadId, title: item.title });
        } else {
          failed.push({ title: item.title, reason: errorDetail(result.failure) });
        }
      }
      return { ...queue, started, failed, waiting: queue.waiting.slice(count) };
    });

  const runDueWork = locked(
    Effect.gen(function* () {
      const queues = yield* Ref.get(queuesRef);
      if (queues.length === 0) return;
      const nowMs = yield* Clock.currentTimeMillis;
      if (nowMs - lastCheckAtMs < CHECK_INTERVAL_MS) return;
      lastCheckAtMs = nowMs;
      const snapshot = yield* orchestrator.getShellSnapshot({
        location: "active",
        // A settled thread works for nobody; skipping them keeps the look cheap.
        unsettledOnly: true,
      });
      const settings = yield* serverSettings.getSettings;
      const working = new Set(
        nightSessions(snapshot.threads, null, nowMs, settings.autoResumeLimitedThreads)
          .filter((session) => session.works)
          .map((session) => session.thread.id),
      );
      const filled = yield* Effect.forEach(queues, (queue) =>
        fill(queue, (threadId) => working.has(threadId)),
      );
      if (filled.some((queue, index) => queue !== queues[index])) yield* setQueues(filled);
    }),
  ).pipe(Effect.catchCause((cause) => Effect.logWarning("agent-queue.check-failed", { cause })));

  const start = (input: AgentQueueStartInput) =>
    locked(
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        const queues = yield* Ref.get(queuesRef);
        const created: AgentQueue = {
          id: `${nowMs.toString(36)}-${queues.length}`,
          label: input.label,
          maxRunning: input.maxRunning,
          started: [],
          waiting: input.launches,
          failed: [],
          createdAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
        };
        const queue = yield* fill(created, () => false);
        if (queue.started.length === 0 && queue.waiting.length === 0) {
          return yield* new AgentQueueError({
            operation: "start",
            detail: queue.failed[0]?.reason ?? "No agent could be started.",
          });
        }
        yield* setQueues([...queues, queue]);
        return queue;
      }),
    );

  const cancel = (id: string) =>
    locked(
      Ref.get(queuesRef).pipe(
        Effect.flatMap((queues) => setQueues(queues.filter((queue) => queue.id !== id))),
      ),
    );

  const subscribe = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe first so a change between the two is not lost.
        const subscription = yield* PubSub.subscribe(changes);
        const current = yield* Ref.get(queuesRef);
        return Stream.concat(Stream.make(current), Stream.fromSubscription(subscription));
      }),
    );

  yield* scheduler.register("agent-queue", runDueWork);

  return AgentQueueService.of({
    start,
    cancel,
    subscribe,
    hasWaiting: Ref.get(queuesRef).pipe(
      Effect.map((queues) => queues.some((queue) => queue.waiting.length > 0)),
    ),
  });
});

export const layer = Layer.effect(AgentQueueService, make);
