import { assert, it } from "@effect/vitest";
import {
  EventId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadShell,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ServerSettings from "../serverSettings.ts";
import * as FileChangeAutoDecline from "./FileChangeAutoDecline.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const threadId = ThreadId.make("thread:hard-cap-decline");
const antigravity = ProviderInstanceId.make("antigravity");
const codex = ProviderInstanceId.make("codex");

const requestEvent = (input: {
  readonly kind: OrchestrationV2RuntimeRequest["kind"];
  readonly status?: OrchestrationV2RuntimeRequest["status"];
  readonly providerInstanceId?: ProviderInstanceId;
  readonly suffix: string;
}): OrchestrationV2DomainEvent => {
  const now = DateTime.makeUnsafe("2026-10-09T00:00:00.000Z");
  return {
    id: EventId.make(`event:hard-cap-${input.suffix}`),
    type: "runtime-request.updated",
    threadId,
    ...(input.providerInstanceId === undefined
      ? {}
      : { providerInstanceId: input.providerInstanceId }),
    occurredAt: now,
    payload: {
      id: RuntimeRequestId.make(`request:hard-cap-${input.suffix}`),
      nodeId: NodeId.make(`node:hard-cap-${input.suffix}`),
      providerTurnId: null,
      nativeRequestRef: null,
      kind: input.kind,
      status: input.status ?? "pending",
      responseCapability: {
        type: "live",
        providerSessionId: ProviderSessionId.make("provider-session:hard-cap"),
      },
      createdAt: now,
      resolvedAt: null,
    },
  };
};

const runDecline = (events: ReadonlyArray<OrchestrationV2DomainEvent>, shellInstance = codex) =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
    yield* Effect.gen(function* () {
      const { declineIfCapped } = yield* FileChangeAutoDecline.make;
      for (const event of events) yield* declineIfCapped(event);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: () =>
              Effect.succeed({
                modelSelection: { instanceId: shellInstance, model: "m" },
              } as unknown as OrchestrationV2ThreadShell),
            dispatch: (command) =>
              Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                Effect.as({ sequence: 1, storedEvents: [] } as never),
              ),
          }),
          ServerSettings.layerTest({
            providerInstances: {
              [antigravity]: {
                driver: ProviderDriverKind.make("antigravity"),
                hardCap: { maxRuntimeMode: "approval-required", declineFileChanges: true },
              },
            },
          }).pipe(Layer.orDie),
        ),
      ),
    );
    return yield* Ref.get(dispatched);
  });

it.effect("declines a pending file change on a declining instance through respond", () =>
  Effect.gen(function* () {
    const dispatched = yield* runDecline([
      requestEvent({ kind: "file-change", providerInstanceId: antigravity, suffix: "edit" }),
    ]);
    assert.deepEqual(dispatched, [
      {
        type: "runtime-request.respond",
        commandId: "hard-cap-decline:request:hard-cap-edit",
        threadId,
        requestId: "request:hard-cap-edit",
        decision: "decline",
      },
    ]);
  }),
);

it.effect("falls back to the thread's instance when the event names none", () =>
  Effect.gen(function* () {
    const dispatched = yield* runDecline(
      [requestEvent({ kind: "file-change", suffix: "shell" })],
      antigravity,
    );
    assert.equal(dispatched.length, 1);
  }),
);

it.effect("leaves commands, answered requests and uncapped instances to the user", () =>
  Effect.gen(function* () {
    const dispatched = yield* runDecline([
      requestEvent({ kind: "command", providerInstanceId: antigravity, suffix: "command" }),
      requestEvent({
        kind: "file-change",
        status: "resolved",
        providerInstanceId: antigravity,
        suffix: "resolved",
      }),
      requestEvent({ kind: "file-change", providerInstanceId: codex, suffix: "codex" }),
    ]);
    assert.deepEqual(dispatched, []);
  }),
);
