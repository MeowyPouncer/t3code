// FORK: the night mode's decisions, kept pure for tests. NightService does the I/O.
import type {
  NightState,
  OrchestrationV2ProviderTurnTokenUsage,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";

import { threadHasQueuedTurnStart } from "../orchestration-v2/ThreadSettlementService.ts";

export type NightThread = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "title"
  | "lineage"
  | "launchedByThreadId"
  | "archivedAt"
  | "settledOverride"
  | "status"
  | "activityRunStatus"
  | "pendingRuntimeRequest"
  | "pendingBackgroundTasks"
  | "latestUserMessageAt"
  | "latestRunId"
  | "latestRunRequestedAt"
  | "latestRunStartedAt"
  | "latestRunCompletedAt"
  | "lastErrorClass"
  | "usageLimitResetAt"
  | "limitRecovery"
>;

/** A limit that resets this soon after it hit is a session window, worth waiting for. */
const LIMIT_WAIT_MAX_MS = 6 * 60 * 60_000;
/** A resume that has not come this long after the reset is not coming. */
const LIMIT_RESUME_GRACE_MS = 15 * 60_000;

export const CONTEXT_WARN_RATIO = 0.8;
/** Below this, a compacted session can be reported again. */
export const CONTEXT_REARM_RATIO = 0.5;

/** Whether T3 will resume a thread that hit a usage limit, soon enough to wait for it. */
export function awaitsLimitResume(
  thread: NightThread,
  nowMs: number,
  autoResumeLimited: boolean,
): boolean {
  if (thread.status !== "failed" || thread.lastErrorClass !== "usage_limit") return false;
  if (thread.settledOverride === "settled" || thread.usageLimitResetAt == null) return false;
  const recovery = thread.limitRecovery ?? null;
  const armed = recovery !== null && recovery.runId === thread.latestRunId;
  if (!(armed ? recovery.autoResume : autoResumeLimited)) return false;
  const resetMs = Date.parse(thread.usageLimitResetAt);
  if (!Number.isFinite(resetMs)) return false;
  const failedMs =
    thread.latestRunCompletedAt == null
      ? nowMs
      : DateTime.toEpochMillis(thread.latestRunCompletedAt);
  return resetMs - failedMs <= LIMIT_WAIT_MAX_MS && nowMs < resetMs + LIMIT_RESUME_GRACE_MS;
}

/**
 * Whether a thread's agent works or goes on by itself: a live, queued or draining run, background
 * work that wakes it, a message about to start a turn, or a usage-limit resume. One that waits for
 * a person does not: nobody answers before the morning.
 */
export function threadWorks(
  thread: NightThread,
  nowMs: number,
  autoResumeLimited: boolean,
): boolean {
  if (thread.archivedAt !== null || thread.pendingRuntimeRequest !== null) return false;
  if (thread.activityRunStatus != null || thread.status === "queued") return true;
  if (backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])) return true;
  if (threadHasQueuedTurnStart(thread, nowMs)) return true;
  return awaitsLimitResume(thread, nowMs, autoResumeLimited);
}

export const nothingWorks = (
  threads: ReadonlyArray<NightThread>,
  nowMs: number,
  autoResumeLimited: boolean,
): boolean => !threads.some((thread) => threadWorks(thread, nowMs, autoResumeLimited));

/**
 * A session is a thread the user runs: not the overseer, not a subagent, and not a thread another
 * thread launched. Its subagents and launched threads are its own business.
 */
export const isNightSession = (thread: NightThread, overseerThreadId: ThreadId | null): boolean =>
  thread.id !== overseerThreadId &&
  thread.archivedAt === null &&
  thread.lineage.relationshipToParent !== "subagent" &&
  thread.launchedByThreadId === undefined;

/** The thread a subagent or launched thread works for. */
const workParentOf = (thread: NightThread): ThreadId | null =>
  thread.launchedByThreadId ??
  (thread.lineage.relationshipToParent === "subagent" ? thread.lineage.parentThreadId : null);

export interface NightSessionView {
  readonly thread: NightThread;
  /** The session or a thread working for it still works. */
  readonly works: boolean;
  /** Threads working for it, at any depth, that wait for an answer. */
  readonly waitingDescendants: ReadonlyArray<NightThread>;
}

export function nightSessions(
  threads: ReadonlyArray<NightThread>,
  overseerThreadId: ThreadId | null,
  nowMs: number,
  autoResumeLimited: boolean,
): ReadonlyArray<NightSessionView> {
  const children = new Map<ThreadId, NightThread[]>();
  for (const thread of threads) {
    const parent = workParentOf(thread);
    if (parent === null) continue;
    children.set(parent, [...(children.get(parent) ?? []), thread]);
  }
  return threads
    .filter((thread) => isNightSession(thread, overseerThreadId))
    .map((session) => {
      let works = threadWorks(session, nowMs, autoResumeLimited);
      const waitingDescendants: NightThread[] = [];
      const seen = new Set<ThreadId>([session.id]);
      const stack = [...(children.get(session.id) ?? [])];
      for (let thread = stack.pop(); thread !== undefined; thread = stack.pop()) {
        if (seen.has(thread.id)) continue;
        seen.add(thread.id);
        if (threadWorks(thread, nowMs, autoResumeLimited)) works = true;
        else if (thread.archivedAt === null && thread.pendingRuntimeRequest !== null) {
          waitingDescendants.push(thread);
        }
        stack.push(...(children.get(thread.id) ?? []));
      }
      return { thread: session, works, waitingDescendants };
    });
}

/** Requests the overseer can answer. T3 answers dynamic tool calls itself; only the user signs in. */
export const overseerAnswersRequest = (kind: OrchestrationV2RuntimeRequest["kind"]): boolean =>
  kind !== "dynamic_tool_call" && kind !== "auth_refresh";

/**
 * Sessions that worked at the last look and no longer do. One stopped on a request the overseer
 * can answer is left out: that request woke the overseer already.
 */
export const stoppedSessions = (
  previouslyWorking: ReadonlySet<ThreadId>,
  sessions: ReadonlyArray<NightSessionView>,
): ReadonlyArray<NightSessionView> =>
  sessions.filter(
    (session) =>
      previouslyWorking.has(session.thread.id) &&
      !session.works &&
      !(
        session.thread.pendingRuntimeRequest !== null &&
        overseerAnswersRequest(session.thread.pendingRuntimeRequest.kind)
      ),
  );

export const contextRatio = (
  usage: OrchestrationV2ProviderTurnTokenUsage | undefined,
): number | null =>
  usage === undefined || usage.maxTokens == null || usage.maxTokens <= 0
    ? null
    : usage.usedTokens / usage.maxTokens;

export type NightStep =
  | { readonly type: "start-agents" }
  | { readonly type: "start-queued"; readonly index: number }
  | { readonly type: "request-report" }
  | { readonly type: "finish" };

/** What T3 does once nothing has worked for a while. */
export function nextNightStep(state: NightState): NightStep | null {
  switch (state.phase) {
    case "night":
    case "ending":
      if (!state.agentsStarted && state.plan.end.agents.length > 0) return { type: "start-agents" };
      if (state.queueStarted < state.plan.end.queue.length) {
        return { type: "start-queued", index: state.queueStarted };
      }
      return { type: "request-report" };
    case "report":
      return { type: "finish" };
    case "briefing":
    case "done":
      return null;
  }
}

/** While the user is away, every session's instructions carry the night rules. */
export const nightRulesApply = (state: NightState | null): boolean =>
  state !== null &&
  (state.phase === "night" || state.phase === "ending" || state.phase === "report");

/** The overseer hears about sessions while the night's work runs, not during its report. */
export const overseerWatches = (state: NightState | null): state is NightState =>
  state !== null && (state.phase === "night" || state.phase === "ending");
