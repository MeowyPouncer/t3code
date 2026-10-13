import type { ThreadId } from "@t3tools/contracts";

import { threadRuntimeIsActive, type EnvironmentThreadShell } from "./models.ts";
import { toSortableTimestamp } from "./threadSort.ts";

// Working section beta, shared so web and mobile fold and order the inbox the
// same way. Off by default; each client owns its own toggle.

type WorkingThreadInput = Pick<
  EnvironmentThreadShell,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "interactionMode"
  | "latestRun"
  | "runtime"
>;

/** Threads busy with work that does not need the user fold into the Working
    section: a running run, or one stopped with background work that will wake
    it. Approvals, questions, plan prompts, and failures stay in the inbox. */
export function isThreadWorking(thread: WorkingThreadInput): boolean {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  if (!threadRuntimeIsActive(thread.runtime) && thread.runtime?.status !== "idle") return false;
  // A plan prompt outranks lingering background work: the user has to act on it.
  const run = thread.latestRun;
  const runSettled =
    run !== null &&
    run.status !== "preparing" &&
    run.status !== "queued" &&
    run.status !== "starting" &&
    run.status !== "running" &&
    run.status !== "waiting" &&
    thread.runtime?.activeRunId !== run.runId;
  return !(thread.interactionMode === "plan" && thread.hasActionableProposedPlan && runSettled);
}

type FamilyThreadInput = Pick<
  EnvironmentThreadShell,
  "environmentId" | "id" | "lineage" | "launchedByThreadId"
>;

/** FORK: the thread this one works for: a subagent's parent, or the thread that
    launched it. A fork is the user's own thread and works for no one. */
export function threadFamilyParentId(thread: FamilyThreadInput): ThreadId | null {
  if (thread.lineage.relationshipToParent === "subagent") return thread.lineage.parentThreadId;
  if (thread.lineage.relationshipToParent === null) return thread.launchedByThreadId ?? null;
  return null;
}

/** FORK: for each thread, the threads at work for it at any depth (its subagents
    and the threads it launched), keyed by `keyOf`. A thread whose own turn
    ended still reads as working while they do. */
export function workingFamilyByThread<T extends FamilyThreadInput>(
  threads: readonly T[],
  isWorking: (thread: T) => boolean,
  keyOf: (thread: Pick<T, "environmentId" | "id">) => string,
): ReadonlyMap<string, readonly T[]> {
  const byKey = new Map(threads.map((thread) => [keyOf(thread), thread] as const));
  const family = new Map<string, T[]>();
  for (const thread of threads) {
    if (!isWorking(thread)) continue;
    const seen = new Set([keyOf(thread)]);
    let parentId = threadFamilyParentId(thread);
    while (parentId !== null) {
      const key = keyOf({ environmentId: thread.environmentId, id: parentId });
      // A launch cycle cannot happen through the tools; corrupt data must not hang here.
      if (seen.has(key)) break;
      seen.add(key);
      const members = family.get(key);
      if (members === undefined) family.set(key, [thread]);
      else members.push(thread);
      const parent = byKey.get(key);
      if (parent === undefined) break;
      parentId = threadFamilyParentId(parent);
    }
  }
  return family;
}

type InboxThreadInput = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "createdAt" | "unsettledAt" | "latestRun"
>;

/** The inbox lists threads newest first by when each last came back to the
    user, so a thread that leaves the Working section lands on top.
    `observedReturnAt` adds returns the server does not stamp, such as an
    approval request mid-turn or background work ending. */
export function sortInboxThreadsByReturn<T extends InboxThreadInput>(
  threads: readonly T[],
  observedReturnAt?: (thread: T) => number | undefined,
): T[] {
  const timestamps = new Map(
    threads.map((thread) => [
      thread,
      Math.max(
        toSortableTimestamp(thread.createdAt) ?? 0,
        toSortableTimestamp(thread.unsettledAt ?? undefined) ?? 0,
        toSortableTimestamp(thread.latestRun?.requestedAt ?? undefined) ?? 0,
        toSortableTimestamp(thread.latestRun?.completedAt ?? undefined) ?? 0,
        observedReturnAt?.(thread) ?? 0,
      ),
    ]),
  );
  return sortNewestFirst(threads, timestamps);
}

type WorkingSortInput = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "createdAt" | "latestRun" | "latestUserAuthoredMessageAt"
>;

/** The Working section lists threads newest first by the last message the
    user sent. Runs ending and wakes (background results, delegated results,
    PR watches) do not move a row, so the order stays put while agents finish
    and resume. Servers without the authored stamp fall back to the latest
    run's request time. */
export function sortWorkingThreadsBySend<T extends WorkingSortInput>(threads: readonly T[]): T[] {
  const timestamps = new Map(
    threads.map((thread) => [
      thread,
      Math.max(
        toSortableTimestamp(thread.createdAt) ?? 0,
        toSortableTimestamp(
          (thread.latestUserAuthoredMessageAt === undefined
            ? thread.latestRun?.requestedAt
            : thread.latestUserAuthoredMessageAt) ?? undefined,
        ) ?? 0,
      ),
    ]),
  );
  return sortNewestFirst(threads, timestamps);
}

function sortNewestFirst<T extends Pick<EnvironmentThreadShell, "id" | "environmentId">>(
  threads: readonly T[],
  timestamps: ReadonlyMap<T, number>,
): T[] {
  return [...threads].sort(
    (left, right) =>
      timestamps.get(right)! - timestamps.get(left)! ||
      left.id.localeCompare(right.id) ||
      left.environmentId.localeCompare(right.environmentId),
  );
}

/**
 * Remembers when this client saw each thread leave the Working section. Keep
 * one at module scope so the inbox order survives routes that unmount the
 * list. Call `observe` with every thread shell on each list rebuild, or with
 * null to reset while the beta is off. The first call only takes a baseline,
 * so mounting never reshuffles the inbox.
 */
export function createInboxReturnTracker() {
  const keyOf = (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) =>
    `${thread.environmentId}:${thread.id}`;
  let lastWorkingKeys: ReadonlySet<string> | null = null;
  const returns = new Map<string, number>();
  return {
    observe(threads: ReadonlyArray<WorkingThreadInput & InboxThreadInput> | null): void {
      if (threads === null) {
        lastWorkingKeys = null;
        returns.clear();
        return;
      }
      const working = new Set<string>();
      const present = new Set<string>();
      for (const thread of threads) {
        const key = keyOf(thread);
        present.add(key);
        if (isThreadWorking(thread)) working.add(key);
      }
      // Drop deleted threads so the map stays bounded by the live thread list.
      for (const key of returns.keys()) {
        if (!present.has(key)) returns.delete(key);
      }
      // The moment this client saw the change is the data; there is no
      // server stamp to read instead.
      // @effect-diagnostics-next-line globalDate:off
      const at = Date.now();
      for (const key of lastWorkingKeys ?? []) {
        if (present.has(key) && !working.has(key)) returns.set(key, at);
      }
      lastWorkingKeys = working;
    },
    returnedAt: (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) =>
      returns.get(keyOf(thread)),
  };
}
