/**
 * FORK (T3MIG-FORK-014): work that lives in a Claude CLI process between turns
 * and dies with it, so an idle stop must wait for it: every live background
 * task the CLI reports (shells, monitors, subagents, workflows, MCP tasks, …)
 * and the session's crons (CronCreate, ScheduleWakeup, /loop), which wake the
 * process later.
 *
 * Tasks follow `background_tasks_changed`, the CLI's level: each one replaces
 * the set, and once a process has sent one, task edges are ignored, so a late
 * completion cannot clear a newer task and a late start cannot add a phantom.
 * A CLI that sends no level is followed by its edges, fenced by `run_id` and by
 * the tasks already seen ending.
 *
 * Crons are read from the `session_crons` the CLI gives its Stop and
 * SubagentStop hooks. They are unknown, and hold, from the start of a process
 * (it may restore crons from an earlier session) until a hook reports them,
 * and again after a cron tool runs until the next report.
 */

export interface ClaudeSessionCron {
  readonly id: string;
  readonly recurring: boolean;
}

export interface ClaudeIdleStopTask {
  readonly type: string;
  /** The task's `run_id`, when the CLI sends one (a resumed task gets a new one). */
  readonly runId?: string;
}

export interface ClaudeIdleStopWork {
  /** Live background tasks by task id. */
  readonly tasks: ReadonlyMap<string, ClaudeIdleStopTask>;
  /** The process has sent `background_tasks_changed`, which is authoritative from then on. */
  readonly levelSeen: boolean;
  /** Edge fallback only: tasks seen ending, so a start that arrives late is not added. */
  readonly ended: ReadonlyArray<string>;
  /** The crons the last hook reported; null while they are unknown. */
  readonly crons: ReadonlyArray<ClaudeSessionCron> | null;
  /** A cron tool ran after the last report, so the crons are not known. */
  readonly cronToolSinceReport: boolean;
}

export type ClaudeIdleStopWorkHold = "background_task" | "session_cron";

/** A process as it starts: no tasks, crons unknown until its first report. */
export const CLAUDE_IDLE_STOP_WORK_AT_PROCESS_START: ClaudeIdleStopWork = {
  tasks: new Map(),
  levelSeen: false,
  ended: [],
  crons: null,
  cronToolSinceReport: false,
};

/** Tools that schedule a later wake of this session. */
const CLAUDE_CRON_TOOLS: ReadonlySet<string> = new Set(["CronCreate", "ScheduleWakeup"]);

/** How many ended task ids the edge fallback remembers. */
const MAX_ENDED_TASKS = 256;

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

function sameTasks(
  left: ReadonlyMap<string, ClaudeIdleStopTask>,
  right: ReadonlyMap<string, ClaudeIdleStopTask>,
): boolean {
  return (
    left.size === right.size &&
    [...left].every(([id, task]) => {
      const other = right.get(id);
      return other !== undefined && other.type === task.type && other.runId === task.runId;
    })
  );
}

/** Edge fallback: a task ended. A completion of an older run leaves a newer one alone. */
function endTask(
  work: ClaudeIdleStopWork,
  taskId: string,
  runId: string | undefined,
): ClaudeIdleStopWork {
  const live = work.tasks.get(taskId);
  if (
    live !== undefined &&
    live.runId !== undefined &&
    runId !== undefined &&
    live.runId !== runId
  ) {
    return work;
  }
  const endedKey = runId === undefined ? taskId : `${taskId}\u0000${runId}`;
  const ended = [...work.ended.filter((key) => key !== endedKey), endedKey].slice(-MAX_ENDED_TASKS);
  if (live === undefined) return { ...work, ended };
  const tasks = new Map(work.tasks);
  tasks.delete(taskId);
  return { ...work, tasks, ended };
}

/** Edge fallback: a task started, unless it is already known to have ended. */
function startTask(
  work: ClaudeIdleStopWork,
  taskId: string,
  task: ClaudeIdleStopTask,
): ClaudeIdleStopWork {
  const live = work.tasks.get(taskId);
  if (live !== undefined && (task.runId === undefined || live.runId === task.runId)) return work;
  const endedKey = task.runId === undefined ? taskId : `${taskId}\u0000${task.runId}`;
  if (work.ended.includes(endedKey)) return work;
  return { ...work, tasks: new Map(work.tasks).set(taskId, task) };
}

/** Applies one SDK frame of the process; returns `work` itself when nothing changed. */
export function applyClaudeIdleStopFrame(
  work: ClaudeIdleStopWork,
  message: unknown,
): ClaudeIdleStopWork {
  if (usesCronTool(message)) {
    return work.cronToolSinceReport ? work : { ...work, cronToolSinceReport: true };
  }
  if (field(message, "type") !== "system") return work;
  const subtype = field(message, "subtype");
  if (subtype === "background_tasks_changed") {
    const listed = field(message, "tasks");
    if (!Array.isArray(listed)) return work;
    const tasks = new Map<string, ClaudeIdleStopTask>();
    for (const entry of listed) {
      const id = stringField(entry, "task_id");
      if (id !== undefined && taskHoldsIdleStop(entry)) {
        tasks.set(id, { type: stringField(entry, "task_type") ?? "unknown" });
      }
    }
    if (work.levelSeen && sameTasks(tasks, work.tasks)) return work;
    return { ...work, tasks, levelSeen: true, ended: [] };
  }
  // The level is authoritative once the process has sent one.
  if (work.levelSeen) return work;
  const taskId = stringField(message, "task_id");
  if (taskId === undefined) return work;
  const runId = stringField(message, "run_id");
  switch (subtype) {
    case "task_started":
      // A foreground task blocks its tool call inside a turn; one moved to the
      // background later arrives as task_updated.
      if (field(message, "is_backgrounded") === false) return work;
      return startTask(work, taskId, {
        type: stringField(message, "task_type") ?? "unknown",
        ...(runId === undefined ? {} : { runId }),
      });
    case "task_updated": {
      const patch = field(message, "patch");
      const status = field(patch, "status");
      if (status === "completed" || status === "failed" || status === "killed") {
        return endTask(work, taskId, runId);
      }
      if (field(patch, "is_backgrounded") === true) {
        return startTask(work, taskId, {
          type: "unknown",
          ...(runId === undefined ? {} : { runId }),
        });
      }
      return work;
    }
    case "task_notification":
      return endTask(work, taskId, runId);
    default:
      return work;
  }
}

/**
 * Applies a Stop or SubagentStop hook input. Its `session_crons` is the whole
 * set; a CLI that does not send it leaves the crons as they were.
 */
export function applyClaudeStopHookInput(
  work: ClaudeIdleStopWork,
  hookInput: unknown,
): ClaudeIdleStopWork {
  const reported = field(hookInput, "session_crons");
  if (!Array.isArray(reported)) return work;
  const crons = reported.flatMap((entry): ReadonlyArray<ClaudeSessionCron> => {
    const id = stringField(entry, "id");
    return id === undefined ? [] : [{ id, recurring: field(entry, "recurring") !== false }];
  });
  return { ...work, crons, cronToolSinceReport: false };
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
