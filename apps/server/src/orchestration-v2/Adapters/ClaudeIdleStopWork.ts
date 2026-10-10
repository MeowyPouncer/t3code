/**
 * FORK (T3MIG-FORK-014): work that lives in a Claude CLI process between turns
 * and dies with it, so an idle stop must wait for it. The Waiting roster only
 * shows background shells and monitors (`local_bash`) and running subagents;
 * this also follows every other live background task the CLI reports
 * (workflows, MCP tasks, remote agents, …) and the session's crons
 * (CronCreate, ScheduleWakeup, /loop), which wake the process later.
 *
 * Tasks follow `background_tasks_changed` (a level: each one replaces the set),
 * with the task edges as a fallback for CLIs that do not send it. Crons are
 * read from the `session_crons` the CLI gives its Stop and SubagentStop hooks;
 * a cron tool that ran after the last report leaves them unknown, which holds.
 */

export interface ClaudeSessionCron {
  readonly id: string;
  readonly recurring: boolean;
}

export interface ClaudeIdleStopWork {
  /** Live background tasks: task id to SDK `task_type`. */
  readonly tasks: ReadonlyMap<string, string>;
  /** The crons the last hook reported; null before any hook reported them. */
  readonly crons: ReadonlyArray<ClaudeSessionCron> | null;
  /** A cron tool ran after the last report, so the crons are not known. */
  readonly cronToolSinceReport: boolean;
}

export type ClaudeIdleStopWorkHold = "background_task" | "session_cron";

export const EMPTY_CLAUDE_IDLE_STOP_WORK: ClaudeIdleStopWork = {
  tasks: new Map(),
  crons: null,
  cronToolSinceReport: false,
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

function withTasks(
  work: ClaudeIdleStopWork,
  tasks: ReadonlyMap<string, string>,
): ClaudeIdleStopWork {
  return { ...work, tasks };
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
  const taskId = stringField(message, "task_id");
  switch (subtype) {
    case "background_tasks_changed": {
      const listed = field(message, "tasks");
      if (!Array.isArray(listed)) return work;
      const tasks = new Map<string, string>();
      for (const entry of listed) {
        const id = stringField(entry, "task_id");
        if (id !== undefined && taskHoldsIdleStop(entry)) {
          tasks.set(id, stringField(entry, "task_type") ?? "unknown");
        }
      }
      if (
        tasks.size === work.tasks.size &&
        [...tasks].every(([id, type]) => work.tasks.get(id) === type)
      ) {
        return work;
      }
      return withTasks(work, tasks);
    }
    case "task_started": {
      // A foreground task blocks its tool call inside a turn; one moved to the
      // background later arrives as task_updated or in the level.
      if (taskId === undefined || field(message, "is_backgrounded") === false) return work;
      if (work.tasks.has(taskId)) return work;
      return withTasks(
        work,
        new Map(work.tasks).set(taskId, stringField(message, "task_type") ?? "unknown"),
      );
    }
    case "task_updated": {
      if (taskId === undefined) return work;
      const patch = field(message, "patch");
      const status = field(patch, "status");
      if (status === "completed" || status === "failed" || status === "killed") {
        if (!work.tasks.has(taskId)) return work;
        const tasks = new Map(work.tasks);
        tasks.delete(taskId);
        return withTasks(work, tasks);
      }
      if (field(patch, "is_backgrounded") === true && !work.tasks.has(taskId)) {
        return withTasks(work, new Map(work.tasks).set(taskId, "unknown"));
      }
      return work;
    }
    case "task_notification": {
      if (taskId === undefined || !work.tasks.has(taskId)) return work;
      const tasks = new Map(work.tasks);
      tasks.delete(taskId);
      return withTasks(work, tasks);
    }
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
  if (work.cronToolSinceReport || (work.crons !== null && work.crons.length > 0)) {
    holds.push("session_cron");
  }
  return holds;
}

/** Updates one native thread's work; returns `current` itself when nothing changed. */
export function updateClaudeIdleStopWork(
  current: ReadonlyMap<string, ClaudeIdleStopWork>,
  nativeThreadId: string,
  update: (work: ClaudeIdleStopWork) => ClaudeIdleStopWork,
): ReadonlyMap<string, ClaudeIdleStopWork> {
  const work = current.get(nativeThreadId) ?? EMPTY_CLAUDE_IDLE_STOP_WORK;
  const next = update(work);
  if (next === work) return current;
  return new Map(current).set(nativeThreadId, next);
}
