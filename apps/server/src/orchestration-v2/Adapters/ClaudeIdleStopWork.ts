/**
 * FORK (T3MIG-FORK-014): work that lives in a Claude CLI process between turns
 * and dies with it, so an idle stop must wait for it: every live background
 * task the CLI reports (shells, monitors, subagents, workflows, MCP tasks, …)
 * and the session's crons (CronCreate, ScheduleWakeup, /loop), which wake the
 * process later.
 *
 * Tasks follow `background_tasks_changed`, the CLI's level: each one replaces
 * the set, and once a process has sent one, task edges are ignored. CLI
 * 2.1.296 sends it on every membership change. Without it the fallback fails
 * safe: a task seen starting holds until a level or the process exit clears
 * it, since an end edge carries no identity that tells a resumed task apart.
 *
 * Crons are read from the `session_crons` the CLI gives its Stop hook. They
 * are unknown, and hold, from the start of a process (it may restore crons
 * from an earlier session) and after a cron tool runs. The CLI runs the hook
 * before the turn's result, but the hook callback can overtake frames still
 * buffered in front of that result, so a report waits for the result frame
 * and covers everything before it.
 */

export interface ClaudeSessionCron {
  readonly id: string;
  readonly recurring: boolean;
}

export interface ClaudeIdleStopWork {
  /** Live background tasks: task id to SDK `task_type`. */
  readonly tasks: ReadonlyMap<string, string>;
  /** The process has sent `background_tasks_changed`, which is authoritative from then on. */
  readonly levelSeen: boolean;
  /** The crons the last applied report named; null while they are unknown. */
  readonly crons: ReadonlyArray<ClaudeSessionCron> | null;
  /** A cron tool ran after the last applied report, so the crons are not known. */
  readonly cronToolSinceReport: boolean;
  /** A Stop hook report waiting for the turn's result frame. */
  readonly pendingCrons: ReadonlyArray<ClaudeSessionCron> | null;
}

export type ClaudeIdleStopWorkHold = "background_task" | "session_cron";

/** A process as it starts: no tasks, crons unknown until its first report. */
export const CLAUDE_IDLE_STOP_WORK_AT_PROCESS_START: ClaudeIdleStopWork = {
  tasks: new Map(),
  levelSeen: false,
  crons: null,
  cronToolSinceReport: false,
  pendingCrons: null,
};

/** Tools that schedule a later wake of this session. */
const CLAUDE_CRON_TOOLS: ReadonlySet<string> = new Set(["CronCreate", "ScheduleWakeup"]);

/**
 * Whether a listed task holds the process. Every task does, `ambient` ones
 * (watchers the CLI keeps out of its activity indicators) included: they die
 * with the process too. Returning `entry.ambient !== true` would let them go.
 */
function taskHoldsIdleStop(_entry: { readonly ambient?: unknown }): boolean {
  return true;
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  const found = field(value, key);
  return typeof found === "string" && found.length > 0 ? found : undefined;
}

function usesCronTool(message: unknown): boolean {
  if (field(message, "type") !== "assistant") return false;
  const content = field(field(message, "message"), "content");
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) =>
      field(block, "type") === "tool_use" &&
      CLAUDE_CRON_TOOLS.has(stringField(block, "name") ?? ""),
  );
}

function sameTasks(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>) {
  return left.size === right.size && [...left].every(([id, type]) => right.get(id) === type);
}

/** Applies one SDK frame, in stream order; returns `work` itself when nothing changed. */
export function applyClaudeIdleStopFrame(
  work: ClaudeIdleStopWork,
  message: unknown,
): ClaudeIdleStopWork {
  const type = field(message, "type");
  if (type === "result") {
    // The Stop hook ran before this result, so its report covers every frame before it.
    if (work.pendingCrons === null) return work;
    return { ...work, crons: work.pendingCrons, cronToolSinceReport: false, pendingCrons: null };
  }
  if (usesCronTool(message)) {
    return work.cronToolSinceReport ? work : { ...work, cronToolSinceReport: true };
  }
  if (type !== "system") return work;
  const subtype = field(message, "subtype");
  if (subtype === "background_tasks_changed") {
    const listed = field(message, "tasks");
    if (!Array.isArray(listed)) return work;
    const tasks = new Map<string, string>();
    for (const entry of listed) {
      const id = stringField(entry, "task_id");
      if (id !== undefined && taskHoldsIdleStop(entry)) {
        tasks.set(id, stringField(entry, "task_type") ?? "unknown");
      }
    }
    if (work.levelSeen && sameTasks(tasks, work.tasks)) return work;
    return { ...work, tasks, levelSeen: true };
  }
  // The level is authoritative once the process has sent one.
  if (work.levelSeen) return work;
  const taskId = stringField(message, "task_id");
  if (taskId === undefined || work.tasks.has(taskId)) return work;
  // Fallback: a task seen starting holds; no end edge clears it.
  const started =
    (subtype === "task_started" && field(message, "is_backgrounded") !== false) ||
    (subtype === "task_updated" && field(field(message, "patch"), "is_backgrounded") === true);
  if (!started) return work;
  return {
    ...work,
    tasks: new Map(work.tasks).set(taskId, stringField(message, "task_type") ?? "unknown"),
  };
}

/**
 * Records a Stop hook input. Its `session_crons` is the whole set and applies
 * at the next result frame; a CLI that does not send it leaves the crons as
 * they were.
 */
export function applyClaudeStopHookInput(
  work: ClaudeIdleStopWork,
  hookInput: unknown,
): ClaudeIdleStopWork {
  const reported = field(hookInput, "session_crons");
  if (!Array.isArray(reported)) return work;
  const pendingCrons = reported.flatMap((entry): ReadonlyArray<ClaudeSessionCron> => {
    const id = stringField(entry, "id");
    return id === undefined ? [] : [{ id, recurring: field(entry, "recurring") !== false }];
  });
  return { ...work, pendingCrons };
}

export function claudeIdleStopWorkHolds(
  work: ClaudeIdleStopWork,
): ReadonlyArray<ClaudeIdleStopWorkHold> {
  const holds: Array<ClaudeIdleStopWorkHold> = [];
  if (work.tasks.size > 0) holds.push("background_task");
  if (work.crons === null || work.crons.length > 0 || work.cronToolSinceReport) {
    holds.push("session_cron");
  }
  return holds;
}

/**
 * Updates one native thread's work; returns `current` itself when nothing
 * changed. A thread with no entry starts as a fresh process would.
 */
export function updateClaudeIdleStopWork(
  current: ReadonlyMap<string, ClaudeIdleStopWork>,
  nativeThreadId: string,
  update: (work: ClaudeIdleStopWork) => ClaudeIdleStopWork,
): ReadonlyMap<string, ClaudeIdleStopWork> {
  const work = current.get(nativeThreadId) ?? CLAUDE_IDLE_STOP_WORK_AT_PROCESS_START;
  const next = update(work);
  if (next === work && current.has(nativeThreadId)) return current;
  return new Map(current).set(nativeThreadId, next);
}

/** Whether any live process holds work. */
export function anyClaudeIdleStopWorkHolds(
  works: ReadonlyMap<string, ClaudeIdleStopWork>,
): boolean {
  return [...works.values()].some((work) => claudeIdleStopWorkHolds(work).length > 0);
}
