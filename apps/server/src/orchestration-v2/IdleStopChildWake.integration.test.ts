// FORK (T3MIG-FORK-014): a Claude parent whose session was stopped for
// idleness is woken by a delegated child's result and resumes the same native
// session (same transcript) through the same provider session.
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as ClaudeAdapterV2 from "./Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

const sessionId = "idle-stop-child-wake-session";
const settings = Schema.decodeSync(ClaudeSettings)({});
const modelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-4-6",
};

function frame(value: unknown): SDKMessage {
  return value as SDKMessage;
}

const result = (uuid: string) =>
  frame({
    type: "result",
    subtype: "success",
    uuid,
    session_id: sessionId,
    is_error: false,
    num_turns: 1,
    result: "Done.",
    stop_reason: "end_turn",
    terminal_reason: "completed",
    permission_denials: [],
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
  });

/** The CLI runs its Stop hooks, here reporting no crons, before a turn's result. */
const withStopHooks = (
  options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions,
  messages: Stream.Stream<SDKMessage>,
) =>
  messages.pipe(
    Stream.mapEffect((message): Effect.Effect<SDKMessage> =>
      message.type !== "result"
        ? Effect.succeed(message)
        : Effect.promise(async (): Promise<SDKMessage> => {
            for (const matcher of options.hooks?.Stop ?? []) {
              for (const hook of matcher.hooks) {
                await hook(
                  {
                    hook_event_name: "Stop",
                    session_id: sessionId,
                    transcript_path: "/tmp/idle-stop-child-wake.jsonl",
                    cwd: "/tmp",
                    stop_hook_active: false,
                    session_crons: [],
                  },
                  undefined,
                  { signal: AbortSignal.timeout(10_000) },
                );
              }
            }
            return message;
          }),
    ),
  );

it.effect("FORK: a parent stopped while idle resumes its session on a child's result", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("idle-stop-child-wake");
      const processes: Array<{
        readonly options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions;
        readonly messages: Queue.Queue<SDKMessage>;
        closed: boolean;
      }> = [];
      const offers: SDKUserMessage[] = [];
      const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
        instanceId: modelSelection.instanceId,
        settings,
        environment: {},
        attachmentsDir: cwd,
        fileSystem: yield* FileSystem.FileSystem,
        path: yield* Path.Path,
        crypto: yield* Crypto.Crypto,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        queryRunner: {
          allocateSessionId: Effect.succeed(sessionId),
          open: (input) =>
            Effect.gen(function* () {
              const messages = yield* Queue.unbounded<SDKMessage>();
              const process = { options: input.options, messages, closed: false };
              processes.push(process);
              return {
                messages: withStopHooks(input.options, Stream.fromQueue(messages)),
                offer: (message) =>
                  Effect.sync(() => {
                    offers.push(message);
                  }),
                setModel: () => Effect.void,
                setPermissionMode: () => Effect.void,
                stopTask: () => Effect.void,
                interrupt: Effect.void,
                close: Effect.sync(() => {
                  process.closed = true;
                }).pipe(Effect.andThen(Queue.shutdown(messages))),
              };
            }),
          forkSession: () => Effect.die("unused"),
          subagentLaunchToolUseId: () => Effect.succeed(null),
          assertComplete: Effect.void,
        },
      });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make("thread:idle-stop-child-wake");
        const projectId = ProjectId.make("project:idle-stop-child-wake");
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId,
          title: "Idle stop and child wake",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });

        // 1. The parent's turn delegates and ends.
        const running = yield* watch(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("first"),
          threadId,
          messageId: MessageId.make("first"),
          text: "Delegate the review and wait for it.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        yield* Fiber.join(running);
        // The run waits for its finalization, which the effect worker runs.
        const settled = yield* watch(
          (event) => event.type === "run.updated" && event.payload.status === "waiting",
        );
        yield* Queue.offer(processes[0]!.messages, result("first-result"));
        yield* Fiber.join(settled);
        yield* worker.drain();
        const firstProjection = yield* orchestrator.getThreadProjection(threadId);
        const parent = firstProjection.runs[0]!;
        const firstSession = firstProjection.providerSessions.at(-1)!;
        assert.equal(processes.length, 1);
        assert.equal(processes[0]!.options.sessionId, sessionId);

        // 2. Idle for longer than the window: the session and its process stop.
        const stopped = yield* watch(
          (event) =>
            event.type === "provider-session.updated" &&
            event.payload.id === firstSession.id &&
            event.payload.status === "stopped",
        );
        yield* TestClock.adjust("31 minutes");
        yield* Fiber.join(stopped);
        assert.isTrue(processes[0]!.closed);

        // 3. The delegated child finishes; its result wakes the parent.
        const taskId = NodeId.make("idle-stop-child");
        const messageId = MessageId.make("idle-stop-child-result");
        const now = yield* DateTime.now;
        if (parent.rootNodeId === null) return yield* Effect.die("parent has no root node");
        yield* sink.write({
          events: [
            {
              id: EventId.make("idle-stop-cohort"),
              type: "run.updated",
              threadId,
              runId: parent.id,
              occurredAt: now,
              payload: {
                ...parent,
                delegatedCompletion: {
                  disposition: "open",
                  nextGeneration: 2,
                  delivery: { generation: 1, messageId, taskIds: [taskId] },
                },
              },
            },
            {
              id: EventId.make("idle-stop-child"),
              type: "subagent.updated",
              threadId,
              runId: parent.id,
              nodeId: taskId,
              occurredAt: now,
              payload: {
                id: taskId,
                threadId,
                runId: parent.id,
                parentNodeId: parent.rootNodeId,
                origin: "app_owned",
                createdBy: "agent",
                driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
                providerInstanceId: modelSelection.instanceId,
                providerThreadId: null,
                childThreadId: null,
                nativeTaskRef: null,
                prompt: "Review the change",
                title: "Review",
                model: null,
                completionWake: "always",
                completionDelivery: { state: "claimed", observedByRunId: null },
                status: "completed",
                result: "Looks good.",
                startedAt: now,
                completedAt: now,
                updatedAt: now,
              },
            },
          ],
        });
        const woken = yield* watch(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("child-result"),
          threadId,
          messageId,
          text: "Child completed",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
          delegatedCompletion: { parentRunId: parent.id, generation: 1, taskIds: [taskId] },
        });
        yield* worker.drain();
        yield* orchestrator.resumeQueuedRuns;
        yield* worker.drain();
        yield* Fiber.join(woken);

        // 4. A new process resumes the same native session under the same provider session.
        assert.equal(processes.length, 2);
        assert.equal(processes[1]!.options.resume, sessionId);
        assert.isUndefined(processes[1]!.options.sessionId);
        assert.equal(offers.length, 2);
        const wake = offers[1]!.message.content;
        assert.include(
          typeof wake === "string" ? wake : JSON.stringify(wake),
          "Use task_status with taskId idle-stop-child",
        );
        const delivered = yield* watch(
          (event) =>
            event.type === "subagent.updated" &&
            event.payload.completionDelivery?.state === "delivered",
        );
        const finished = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id !== parent.id &&
            event.payload.status === "waiting",
        );
        yield* Queue.offer(processes[1]!.messages, result("wake-result"));
        yield* Fiber.join(finished);
        yield* worker.drain();
        yield* Fiber.join(delivered);
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(after.runs.length, 2);
        const resumedSessionIds = new Set(
          after.providerThreads.map((providerThread) => providerThread.providerSessionId),
        );
        assert.deepEqual([...resumedSessionIds], [firstSession.id]);
        assert.equal(after.providerSessions.at(-1)?.id, firstSession.id);
        assert.equal(after.providerSessions.at(-1)?.status, "ready");
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "idle-stop-child-wake" },
            ProviderAdapterRegistry.layerSingle(adapter),
            { runEffectWorker: false },
          ),
        ),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  ),
);
