import { CommandId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import {
  readProviderInstanceHardCap,
  shouldAutoDeclineRuntimeRequest,
} from "../provider/ProviderInstanceHardCap.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/**
 * Declines file-change approvals on provider instances whose hard cap sets
 * `declineFileChanges`, without asking the user. It sends the command the
 * user's own Decline sends, so the thread shows the request declined and the
 * provider carries on as after a user's decline. The command id is derived
 * from the request, so a replayed event cannot answer twice.
 */
export const declineCommandFor = (
  event: Extract<OrchestrationV2DomainEvent, { readonly type: "runtime-request.updated" }>,
) =>
  ({
    type: "runtime-request.respond",
    commandId: CommandId.make(`hard-cap-decline:${event.payload.id}`),
    threadId: event.threadId,
    requestId: event.payload.id,
    decision: "decline",
  }) as const;

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const declineIfCapped = (event: OrchestrationV2DomainEvent) =>
    event.type !== "runtime-request.updated" ||
    event.payload.status !== "pending" ||
    event.payload.kind !== "file-change"
      ? Effect.void
      : Effect.gen(function* () {
          const instanceId =
            event.providerInstanceId ??
            (yield* threads.getThreadShell(event.threadId))?.modelSelection.instanceId;
          if (instanceId === undefined) return;
          const settings = yield* serverSettings.getSettings;
          const cap = readProviderInstanceHardCap(settings.providerInstances, instanceId);
          if (!shouldAutoDeclineRuntimeRequest(cap, event.payload)) return;
          yield* threads.dispatch(declineCommandFor(event));
          yield* Effect.logInfo("orchestration-v2.hard-cap.file-change-declined", {
            threadId: event.threadId,
            requestId: event.payload.id,
            instanceId,
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.hard-cap.file-change-decline-failed", {
              threadId: event.threadId,
              requestId: event.payload.id,
              cause,
            }),
          ),
        );

  return { declineIfCapped };
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const { declineIfCapped } = yield* make;
    yield* forkParked(Stream.runForEach(threads.streamDomainEvents, declineIfCapped));
  }),
);
