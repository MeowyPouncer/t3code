// FORK: the night mode. The user leaves agents working; one overseer thread watches every
// top-level session, and T3 runs what the user queued for the end of the night.
import * as Schema from "effect/Schema";

import { AgentLaunch, AgentQueue, AgentQueueMaxRunning } from "./agentQueue.ts";
import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode } from "./providerPolicy.ts";

export const NightPlan = Schema.Struct({
  overseer: Schema.Struct({
    projectId: ProjectId,
    modelSelection: ModelSelection,
    runtimeMode: RuntimeMode,
  }),
  /** How long the briefing waits for "I'm leaving" before the night starts on its own. */
  briefingMinutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 240 })),
  end: Schema.Struct({
    /** Started once nothing works any more, such as agents for TODO cards. */
    agents: Schema.Array(AgentLaunch),
    /** How many of those agents work at once; all of them when absent. */
    maxAgents: Schema.optional(AgentQueueMaxRunning),
    /** Then started one at a time, each once nothing works any more. */
    queue: Schema.Array(AgentLaunch),
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

/**
 * The work that runs while nobody watches: the night and the agent queues. One stream serves both,
 * one item on subscribe and one after every change.
 */
export const UnattendedStreamItem = Schema.Struct({
  night: Schema.NullOr(NightState),
  /** Queues that still have launches waiting. */
  agentQueues: Schema.Array(AgentQueue),
});
export type UnattendedStreamItem = typeof UnattendedStreamItem.Type;

export class NightError extends Schema.TaggedError<NightError>()("NightError", {
  operation: Schema.Literals(["start", "leave", "stop", "persist"]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
