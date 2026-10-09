import type { PendingBackgroundWorkItem } from "@t3tools/client-runtime/state/thread-execution";
import type { OrchestrationV2ProviderThread } from "@t3tools/contracts";

/** One row of the background-work drawer. */
export interface BackgroundWorkEntry extends PendingBackgroundWorkItem {
  /** Claude wrote this work's output to a file the server can tail. */
  readonly hasOutput: boolean;
}

export interface FinishedBackgroundWorkEntry extends BackgroundWorkEntry {
  /** When the client saw it leave the list: an upper bound, not its exit time. */
  readonly finishedAt: string;
  readonly read: boolean;
}

/**
 * What a thread's drawer remembers between settled snapshots. Finished work
 * stays listed until the turn after it was read, as in the CLI.
 */
export interface BackgroundWorkHistory {
  /** The list as last seen while the thread was settled. */
  readonly running: ReadonlyArray<BackgroundWorkEntry>;
  readonly finished: ReadonlyArray<FinishedBackgroundWorkEntry>;
  /** The latest run when the finished rows were last read. */
  readonly readAtRunId: string | null;
}

const MAX_FINISHED = 20;

// Claude's adapter reports the work it writes an output file for: background
// Bash commands and Monitors (both local_bash tasks). Subagents open their own
// thread instead, and other providers' work has no file.
const OUTPUT_KINDS = new Set<PendingBackgroundWorkItem["kind"]>([
  "command",
  "monitor",
  "background_task",
]);

/** Task ids whose output the server can read: Claude roster commands and monitors. */
export function backgroundWorkOutputTaskIds(
  providerThreads: ReadonlyArray<
    Pick<OrchestrationV2ProviderThread, "driver" | "pendingBackgroundTasks">
  >,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const thread of providerThreads) {
    if (thread.driver !== "claudeAgent") continue;
    for (const task of thread.pendingBackgroundTasks ?? []) {
      if (OUTPUT_KINDS.has(task.kind)) ids.add(task.taskId);
    }
  }
  return ids;
}

function sameEntries(
  left: ReadonlyArray<BackgroundWorkEntry>,
  right: ReadonlyArray<BackgroundWorkEntry>,
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        entry.taskId === other.taskId &&
        entry.label === other.label &&
        entry.command === other.command &&
        entry.startedAt === other.startedAt &&
        entry.childThreadId === other.childThreadId &&
        entry.hasOutput === other.hasOutput
      );
    })
  );
}

/**
 * Folds one settled snapshot into the history. Work that left the list since
 * the last one finished; work that came back (a resumed subagent) runs again.
 * Read rows go once a later run has started. Returns `previous` unchanged when
 * nothing moved, so a store can skip the update.
 */
export function nextBackgroundWorkHistory(
  previous: BackgroundWorkHistory | undefined,
  input: {
    readonly running: ReadonlyArray<BackgroundWorkEntry>;
    readonly latestRunId: string | null;
    readonly nowIso: string;
  },
): BackgroundWorkHistory {
  if (previous === undefined) {
    return { running: input.running, finished: [], readAtRunId: null };
  }
  const runningIds = new Set(input.running.map((entry) => entry.taskId));
  const turnPassed = previous.readAtRunId !== null && previous.readAtRunId !== input.latestRunId;
  const kept = previous.finished.filter(
    (entry) => !runningIds.has(entry.taskId) && !(turnPassed && entry.read),
  );
  const keptIds = new Set(kept.map((entry) => entry.taskId));
  const ended = previous.running
    .filter((entry) => !runningIds.has(entry.taskId) && !keptIds.has(entry.taskId))
    .map((entry): FinishedBackgroundWorkEntry => ({
      ...entry,
      finishedAt: input.nowIso,
      read: false,
    }));
  const finished = ended.length === 0 ? kept : [...ended, ...kept].slice(0, MAX_FINISHED);
  const readAtRunId = turnPassed ? null : previous.readAtRunId;
  if (
    finished.length === previous.finished.length &&
    finished.every((entry, index) => entry === previous.finished[index]) &&
    readAtRunId === previous.readAtRunId &&
    sameEntries(input.running, previous.running)
  ) {
    return previous;
  }
  return { running: input.running, finished, readAtRunId };
}

/** The drawer showed the finished rows: they go after the next run. */
export function markBackgroundWorkRead(
  history: BackgroundWorkHistory,
  latestRunId: string | null,
): BackgroundWorkHistory {
  if (history.finished.every((entry) => entry.read) && history.readAtRunId !== null) {
    return history;
  }
  if (history.finished.length === 0) return history;
  return {
    ...history,
    finished: history.finished.map((entry) => (entry.read ? entry : { ...entry, read: true })),
    readAtRunId: latestRunId,
  };
}

function pluralNoun(singular: string, count: number): string {
  return count === 1 ? singular : `${singular}s`;
}

/** "Finished: npm run build", or "2 commands and 1 subagent finished". */
export function finishedBackgroundWorkTitle(
  finished: ReadonlyArray<Pick<FinishedBackgroundWorkEntry, "kindLabel" | "label">>,
): string {
  const [only] = finished;
  if (finished.length === 1 && only !== undefined) {
    const noun = only.kindLabel.toLowerCase();
    return only.label.toLowerCase() === noun ? `A ${noun} finished` : `Finished: ${only.label}`;
  }
  const counts = new Map<string, number>();
  for (const entry of finished) {
    const noun = entry.kindLabel.toLowerCase();
    counts.set(noun, (counts.get(noun) ?? 0) + 1);
  }
  const groups = Array.from(counts, ([noun, count]) => `${count} ${pluralNoun(noun, count)}`);
  const joined =
    groups.length <= 1 ? groups.join("") : `${groups.slice(0, -1).join(", ")} and ${groups.at(-1)}`;
  return `${joined} finished`;
}

/**
 * Calls `onRead` once the drawer's rows have stayed on screen for `delayMs`.
 * A drawer can be mounted yet unseen (behind another notice in the collapsed
 * stack, or scrolled away), and unseen rows must not count as read. While the
 * rows intersect but are not shown (`visibility`/`opacity` hide them), the
 * check repeats, since showing them may not change their geometry.
 */
export function createReadWhenShown(input: {
  readonly delayMs: number;
  readonly isShown: () => boolean;
  readonly onRead: () => void;
  readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
}): { readonly intersect: (intersecting: boolean) => void; readonly dispose: () => void } {
  let timer: unknown = null;
  let intersecting = false;
  const clear = () => {
    if (timer !== null) input.clearTimer(timer);
    timer = null;
  };
  const arm = () => {
    timer = input.setTimer(() => {
      timer = null;
      if (!intersecting) return;
      if (input.isShown()) input.onRead();
      else arm();
    }, input.delayMs);
  };
  return {
    intersect: (next) => {
      intersecting = next;
      clear();
      if (next) arm();
    },
    dispose: () => {
      intersecting = false;
      clear();
    },
  };
}
