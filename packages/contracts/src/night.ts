// FORK: the night mode. The user leaves agents working; one overseer thread watches every
// top-level session, and T3 runs what the user queued for the end of the night.
import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationV2ThreadInstructions } from "./orchestrationV2.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

/** A thread T3 starts at the end of the night, as the client composed it when the night began. */
export const NightLaunch = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString,
  instructions: Schema.optional(OrchestrationV2ThreadInstructions),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type NightLaunch = typeof NightLaunch.Type;

export const NightPlan = Schema.Struct({
  overseer: Schema.Struct({
    projectId: ProjectId,
    modelSelection: ModelSelection,
    runtimeMode: RuntimeMode,
  }),
  /** How long the briefing waits for "I'm leaving" before the night starts on its own. */
  briefingMinutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 240 })),
  end: Schema.Struct({
    /** Started together once nothing works any more, such as agents for TODO cards. */
    agents: Schema.Array(NightLaunch),
    /** Then started one at a time, each once nothing works any more. */
    queue: Schema.Array(NightLaunch),
    /** Power the computer off after the morning report, when nothing works. */
    powerOff: Schema.Boolean,
  }),
});
export type NightPlan = typeof NightPlan.Type;

/**
 * briefing: the user is still here and answers one batch of questions.
 * night: the user is gone; questions that are theirs wait for the morning.
 * ending: the queued agents and prompts run.
 * report: the overseer writes the morning report.
 * done: nothing is left; the computer powers off if the plan says so.
 */
export const NightPhase = Schema.Literals(["briefing", "night", "ending", "report", "done"]);
export type NightPhase = typeof NightPhase.Type;

export const NightState = Schema.Struct({
  id: TrimmedNonEmptyString,
  phase: NightPhase,
  plan: NightPlan,
  overseerThreadId: ThreadId,
  startedAt: Schema.String,
  /** When the briefing ends on its own. */
  briefingEndsAt: Schema.String,
  nightStartedAt: Schema.NullOr(Schema.String),
  /** Whether the end-of-night agents were started. */
  agentsStarted: Schema.Boolean,
  /** How many queued prompts were started. */
  queueStarted: NonNegativeInt,
  /** Threads T3 started at the end of the night. */
  endThreadIds: Schema.Array(ThreadId),
  reportRequestedAt: Schema.NullOr(Schema.String),
  doneAt: Schema.NullOr(Schema.String),
  /**
   * When T3 powers the computer off: a minute after the report, and later while anything works.
   * Ending the night cancels it.
   */
  poweringOffAt: Schema.NullOr(Schema.String),
  /** When T3 told the computer to power off. */
  poweredOffAt: Schema.NullOr(Schema.String),
  /** Why the computer will not, or did not, power off. */
  powerOffError: Schema.NullOr(Schema.String),
});
export type NightState = typeof NightState.Type;

export const NightStreamItem = Schema.Struct({ state: Schema.NullOr(NightState) });
export type NightStreamItem = typeof NightStreamItem.Type;

export class NightError extends Schema.TaggedError<NightError>()("NightError", {
  operation: Schema.Literals(["start", "leave", "stop", "persist"]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
