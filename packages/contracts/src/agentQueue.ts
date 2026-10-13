// FORK: threads T3 starts a few at a time, each once an earlier one stops working, so a batch of
// card agents cannot swamp the machine.
import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationV2ThreadInstructions } from "./orchestrationV2.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

/** A thread T3 starts in its project's checkout, as the client composed it. */
export const AgentLaunch = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString,
  instructions: Schema.optional(OrchestrationV2ThreadInstructions),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type AgentLaunch = typeof AgentLaunch.Type;

export const AgentQueueMaxRunning = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }));

export const AgentQueue = Schema.Struct({
  id: TrimmedNonEmptyString,
  /** What the queue is for, as the user sees it. */
  label: TrimmedNonEmptyString,
  maxRunning: AgentQueueMaxRunning,
  /** Threads started so far, in order. */
  started: Schema.Array(Schema.Struct({ threadId: ThreadId, title: Schema.String })),
  /** Launches waiting for a free slot, in order. */
  waiting: Schema.Array(AgentLaunch),
  /** Launches T3 could not start. */
  failed: Schema.Array(Schema.Struct({ title: Schema.String, reason: Schema.String })),
  createdAt: Schema.String,
});
export type AgentQueue = typeof AgentQueue.Type;

export const AgentQueueStartInput = Schema.Struct({
  label: TrimmedNonEmptyString,
  maxRunning: AgentQueueMaxRunning,
  launches: Schema.Array(AgentLaunch).check(Schema.isMinLength(1)),
});
export type AgentQueueStartInput = typeof AgentQueueStartInput.Type;

export class AgentQueueError extends Schema.TaggedError<AgentQueueError>()("AgentQueueError", {
  operation: Schema.Literals(["start", "cancel", "persist"]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
