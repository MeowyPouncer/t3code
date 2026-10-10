/**
 * FORK (T3MIG-FORK-014): what keeps an idle provider session from being
 * stopped, beyond the turns it is running (`ProviderSessionManager`'s
 * `busyTurns`) and the adapter's own background work
 * (`hasPendingBackgroundWork`). A thread is held while it has an active run, a
 * pending approval or question, or delegated work (`delegate_task`) that is
 * still running or whose child still waits for children of its own. Anything
 * that cannot be read holds the session too.
 */
import type {
  OrchestrationV2Run,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2Subagent,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";

/** While a session is held, how often it is checked again. */
export const IDLE_STOP_HOLD_RECHECK_MS = 60 * 1000;

/** Delegation chains deeper than this are not read; the session counts as held. */
const MAX_DELEGATION_DEPTH = 8;

export type IdleStopHold =
  | "background_work"
  | "active_run"
  | "pending_request"
  | "delegated_work"
  | "unknown";

/** The idle window for `providerSessionIdleStopMinutes`; null never stops a session. */
export function idleStopTimeoutMs(minutes: number | null | undefined): number | null {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes) || minutes <= 0) {
    return null;
  }
  return Math.round(minutes * 60 * 1000);
}

const ACTIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

const TERMINAL_TASK_STATUSES: ReadonlySet<OrchestrationV2Subagent["status"]> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export interface IdleStopThreadRecords {
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "status" | "queueHeld" | "completedAt">>;
  readonly runtimeRequests: ReadonlyArray<
    Pick<OrchestrationV2RuntimeRequest, "status" | "resolvedAt">
  >;
  readonly subagents: ReadonlyArray<
    Pick<
      OrchestrationV2Subagent,
      "origin" | "status" | "childThreadId" | "completedAt" | "updatedAt"
    >
  >;
}

/** What holds a thread, and when its last hold ended (null if none ever did). */
export interface IdleStopThreadHolds {
  readonly holds: ReadonlyArray<IdleStopHold>;
  readonly lastHeldAtMs: number | null;
}

function latest(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

function epochMillis(value: DateTime.Utc | null): number | null {
  return value === null ? null : DateTime.toEpochMillis(value);
}

/**
 * One thread's own holds, when the last of them ended (a run's completion, an
 * answered request, a delegated task's end), and the child threads of its
 * finished delegated tasks, which still hold it while they wait for children
 * of their own.
 */
export function idleStopHoldsFromRecords(records: IdleStopThreadRecords): IdleStopThreadHolds & {
  readonly finishedChildThreadIds: ReadonlyArray<ThreadId>;
} {
  const holds: Array<IdleStopHold> = [];
  // A queue held after a restart waits for the user, not for this session.
  if (
    records.runs.some(
      (run) =>
        ACTIVE_RUN_STATUSES.has(run.status) && !(run.status === "queued" && run.queueHeld === true),
    )
  ) {
    holds.push("active_run");
  }
  if (records.runtimeRequests.some((request) => request.status === "pending")) {
    holds.push("pending_request");
  }
  const delegated = records.subagents.filter((task) => task.origin === "app_owned");
  if (delegated.some((task) => !TERMINAL_TASK_STATUSES.has(task.status))) {
    holds.push("delegated_work");
  }
  const finishedChildThreadIds = delegated.flatMap((task) =>
    TERMINAL_TASK_STATUSES.has(task.status) && task.childThreadId !== null
      ? [task.childThreadId]
      : [],
  );
  let lastHeldAtMs: number | null = null;
  for (const run of records.runs) lastHeldAtMs = latest(lastHeldAtMs, epochMillis(run.completedAt));
  for (const request of records.runtimeRequests) {
    lastHeldAtMs = latest(lastHeldAtMs, epochMillis(request.resolvedAt));
  }
  for (const task of delegated) {
    if (!TERMINAL_TASK_STATUSES.has(task.status)) continue;
    lastHeldAtMs = latest(lastHeldAtMs, epochMillis(task.completedAt ?? task.updatedAt));
  }
  return { holds, lastHeldAtMs, finishedChildThreadIds };
}

const UNKNOWN: IdleStopThreadHolds = { holds: ["unknown"], lastHeldAtMs: null };

const holdsForThread = (
  projectionStore: Pick<ProjectionStoreV2Shape, "getThreadRecords">,
  threadId: ThreadId,
  depth: number,
  visited: Set<ThreadId>,
): Effect.Effect<IdleStopThreadHolds> => {
  if (visited.has(threadId)) return Effect.succeed({ holds: [], lastHeldAtMs: null });
  visited.add(threadId);
  return projectionStore.getThreadRecords(threadId, ["runs", "runtimeRequests", "subagents"]).pipe(
    Effect.flatMap((records): Effect.Effect<IdleStopThreadHolds> => {
      const own = idleStopHoldsFromRecords(records);
      if (own.holds.length > 0 || own.finishedChildThreadIds.length === 0) {
        return Effect.succeed({ holds: own.holds, lastHeldAtMs: own.lastHeldAtMs });
      }
      if (depth >= MAX_DELEGATION_DEPTH) return Effect.succeed(UNKNOWN);
      return Effect.forEach(own.finishedChildThreadIds, (childThreadId) =>
        holdsForThread(projectionStore, childThreadId, depth + 1, visited),
      ).pipe(
        Effect.map((children): IdleStopThreadHolds => {
          const flat = children.flatMap((child) => child.holds);
          const lastHeldAtMs = children.reduce<number | null>(
            (at, child) => latest(at, child.lastHeldAtMs),
            own.lastHeldAtMs,
          );
          if (flat.includes("unknown")) return UNKNOWN;
          return { holds: flat.length > 0 ? ["delegated_work"] : [], lastHeldAtMs };
        }),
      );
    }),
    // A thread that no longer exists waits for nothing.
    Effect.catchTags({
      ProjectionStoreThreadNotFoundError: () =>
        Effect.succeed<IdleStopThreadHolds>({ holds: [], lastHeldAtMs: null }),
    }),
    Effect.catchCause(() => Effect.succeed(UNKNOWN)),
  );
};

/**
 * What holds `threadId`'s provider session open (empty when it may be
 * stopped), and when the last hold ended, delegated descendants included.
 */
export const threadIdleStopHolds = (
  projectionStore: Pick<ProjectionStoreV2Shape, "getThreadRecords">,
  threadId: ThreadId,
): Effect.Effect<IdleStopThreadHolds> => holdsForThread(projectionStore, threadId, 0, new Set());
