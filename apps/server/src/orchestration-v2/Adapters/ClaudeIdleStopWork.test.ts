// FORK (T3MIG-FORK-014): the Claude process work that holds an idle stop.
import { describe, expect, it } from "vite-plus/test";

import {
  applyClaudeIdleStopFrame,
  applyClaudeStopHookInput,
  CLAUDE_IDLE_STOP_WORK_AT_PROCESS_START,
  type ClaudeIdleStopWork,
  claudeIdleStopWorkHolds,
  updateClaudeIdleStopWork,
} from "./ClaudeIdleStopWork.ts";

const level = (tasks: ReadonlyArray<Record<string, unknown>>) => ({
  type: "system",
  subtype: "background_tasks_changed",
  tasks,
});

const started = (taskId: string, extra: Record<string, unknown> = {}) => ({
  type: "system",
  subtype: "task_started",
  task_id: taskId,
  task_type: "local_workflow",
  ...extra,
});

const notified = (taskId: string, extra: Record<string, unknown> = {}) => ({
  type: "system",
  subtype: "task_notification",
  task_id: taskId,
  status: "completed",
  ...extra,
});

const toolUse = (name: string, parentToolUseId: string | null = null) => ({
  type: "assistant",
  parent_tool_use_id: parentToolUseId,
  message: { content: [{ type: "tool_use", id: `toolu_${name}`, name, input: {} }] },
});

const NO_CRONS = { hook_event_name: "Stop", session_crons: [] };

/** A process whose first Stop hook has reported no crons. */
const known = applyClaudeStopHookInput(CLAUDE_IDLE_STOP_WORK_AT_PROCESS_START, NO_CRONS);

const apply = (from: ClaudeIdleStopWork, ...frames: ReadonlyArray<unknown>): ClaudeIdleStopWork =>
  frames.reduce<ClaudeIdleStopWork>(applyClaudeIdleStopFrame, from);

describe("Claude idle stop work: crons", () => {
  it("holds a new process until a hook reports its crons", () => {
    expect(claudeIdleStopWorkHolds(CLAUDE_IDLE_STOP_WORK_AT_PROCESS_START)).toEqual([
      "session_cron",
    ]);
    // An older CLI that sends no session_crons leaves them unknown.
    expect(
      claudeIdleStopWorkHolds(
        applyClaudeStopHookInput(CLAUDE_IDLE_STOP_WORK_AT_PROCESS_START, {
          hook_event_name: "Stop",
        }),
      ),
    ).toEqual(["session_cron"]);
    expect(claudeIdleStopWorkHolds(known)).toEqual([]);
    // A SubagentStop report makes them known as well.
    expect(
      claudeIdleStopWorkHolds(
        applyClaudeStopHookInput(CLAUDE_IDLE_STOP_WORK_AT_PROCESS_START, {
          hook_event_name: "SubagentStop",
          session_crons: [],
        }),
      ),
    ).toEqual([]);
  });

  it("holds while a restored or reported cron is scheduled", () => {
    const restored = applyClaudeStopHookInput(CLAUDE_IDLE_STOP_WORK_AT_PROCESS_START, {
      hook_event_name: "Stop",
      session_crons: [{ id: "durable", schedule: "0 9 * * *", recurring: true, prompt: "p" }],
    });
    expect(claudeIdleStopWorkHolds(restored)).toEqual(["session_cron"]);
    expect(restored.crons).toEqual([{ id: "durable", recurring: true }]);
    expect(claudeIdleStopWorkHolds(applyClaudeStopHookInput(restored, NO_CRONS))).toEqual([]);
  });

  it.each([["ScheduleWakeup"], ["CronCreate"]])("holds after %s until the next report", (tool) => {
    const used = apply(known, toolUse(tool));
    expect(claudeIdleStopWorkHolds(used)).toEqual(["session_cron"]);
    expect(
      claudeIdleStopWorkHolds(applyClaudeStopHookInput(used, { hook_event_name: "Stop" })),
    ).toEqual(["session_cron"]);
    expect(claudeIdleStopWorkHolds(applyClaudeStopHookInput(used, NO_CRONS))).toEqual([]);
  });

  it("takes a subagent's cron tool as the session's", () => {
    expect(claudeIdleStopWorkHolds(apply(known, toolUse("CronCreate", "toolu_parent")))).toEqual([
      "session_cron",
    ]);
  });

  it("does not hold for other tools", () => {
    expect(claudeIdleStopWorkHolds(apply(known, toolUse("Bash"), toolUse("CronList")))).toEqual([]);
  });
});

describe("Claude idle stop work: the task level", () => {
  it.each([
    ["local_workflow"],
    ["local_agent"],
    ["local_bash"],
    ["mcp_task"],
    ["remote_agent"],
    ["dream"],
  ])("holds for a live %s task until the level drops it", (taskType) => {
    const running = apply(known, level([{ task_id: "t1", task_type: taskType }]));
    expect(claudeIdleStopWorkHolds(running)).toEqual(["background_task"]);
    expect(claudeIdleStopWorkHolds(apply(running, level([])))).toEqual([]);
  });

  it("counts ambient tasks too", () => {
    const work = apply(known, level([{ task_id: "w1", task_type: "local_bash", ambient: true }]));
    expect(claudeIdleStopWorkHolds(work)).toEqual(["background_task"]);
  });

  it("does not let a late completion clear a task the level still lists", () => {
    const resumed = apply(known, level([{ task_id: "agent", task_type: "local_agent" }]));
    const after = apply(resumed, notified("agent"), {
      type: "system",
      subtype: "task_updated",
      task_id: "agent",
      patch: { status: "killed" },
    });
    expect(claudeIdleStopWorkHolds(after)).toEqual(["background_task"]);
  });

  it("does not let a late start add a task the level has dropped", () => {
    const work = apply(known, level([{ task_id: "wf", task_type: "local_workflow" }]), level([]));
    expect(claudeIdleStopWorkHolds(apply(work, started("wf"), started("other")))).toEqual([]);
  });
});

describe("Claude idle stop work: edges, for a CLI that sends no level", () => {
  it("follows starts and ends", () => {
    const running = apply(known, started("wf"));
    expect(claudeIdleStopWorkHolds(running)).toEqual(["background_task"]);
    expect(claudeIdleStopWorkHolds(apply(running, notified("wf")))).toEqual([]);
    expect(
      claudeIdleStopWorkHolds(
        apply(running, {
          type: "system",
          subtype: "task_updated",
          task_id: "wf",
          patch: { status: "failed" },
        }),
      ),
    ).toEqual([]);
  });

  it("ignores a foreground task until it moves to the background", () => {
    const foreground = apply(known, started("agent", { is_backgrounded: false }));
    expect(claudeIdleStopWorkHolds(foreground)).toEqual([]);
    const backgrounded = apply(foreground, {
      type: "system",
      subtype: "task_updated",
      task_id: "agent",
      patch: { is_backgrounded: true },
    });
    expect(claudeIdleStopWorkHolds(backgrounded)).toEqual(["background_task"]);
  });

  it("does not let an earlier run's completion clear a resumed task", () => {
    const resumed = apply(
      known,
      started("agent", { run_id: "run-1" }),
      notified("agent", {
        run_id: "run-1",
      }),
      started("agent", { run_id: "run-2" }),
    );
    expect(claudeIdleStopWorkHolds(resumed)).toEqual(["background_task"]);
    // A duplicate completion of run 1 arrives late.
    expect(claudeIdleStopWorkHolds(apply(resumed, notified("agent", { run_id: "run-1" })))).toEqual(
      ["background_task"],
    );
    expect(claudeIdleStopWorkHolds(apply(resumed, notified("agent", { run_id: "run-2" })))).toEqual(
      [],
    );
  });

  it("does not add a task whose start arrives after its end", () => {
    const work = apply(known, notified("quick"), started("quick"));
    expect(claudeIdleStopWorkHolds(work)).toEqual([]);
    const fenced = apply(
      known,
      notified("agent", { run_id: "run-1" }),
      started("agent", {
        run_id: "run-1",
      }),
    );
    expect(claudeIdleStopWorkHolds(fenced)).toEqual([]);
    // A later run of the same task is live.
    expect(claudeIdleStopWorkHolds(apply(fenced, started("agent", { run_id: "run-2" })))).toEqual([
      "background_task",
    ]);
  });
});

describe("Claude idle stop work: bookkeeping", () => {
  it("returns the same state and map for a frame that changes nothing", () => {
    const work = apply(known, level([{ task_id: "t1", task_type: "local_workflow" }]));
    expect(
      applyClaudeIdleStopFrame(work, level([{ task_id: "t1", task_type: "local_workflow" }])),
    ).toBe(work);
    expect(applyClaudeIdleStopFrame(work, { type: "result" })).toBe(work);
    const map = new Map([["native", work]]);
    expect(updateClaudeIdleStopWork(map, "native", (current) => current)).toBe(map);
  });

  it("starts a thread with no entry as a new process", () => {
    const updated = updateClaudeIdleStopWork(new Map(), "other", (current) => current);
    expect(claudeIdleStopWorkHolds(updated.get("other")!)).toEqual(["session_cron"]);
  });
});
