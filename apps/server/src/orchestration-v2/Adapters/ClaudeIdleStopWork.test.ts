// FORK (T3MIG-FORK-014): the Claude process work that holds an idle stop.
import { describe, expect, it } from "vite-plus/test";

import {
  anyClaudeIdleStopWorkHolds,
  applyClaudeIdleStopFrame,
  applyClaudeStopHookInput,
  CLAUDE_IDLE_STOP_WORK_AT_PROCESS_START,
  type ClaudeIdleStopWork,
  claudeIdleStopWorkHolds,
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
  task_type: "local_agent",
  ...extra,
});

const notified = (taskId: string) => ({
  type: "system",
  subtype: "task_notification",
  task_id: taskId,
  status: "completed",
});

const toolUse = (name: string, parentToolUseId: string | null = null) => ({
  type: "assistant",
  parent_tool_use_id: parentToolUseId,
  message: { content: [{ type: "tool_use", id: `toolu_${name}`, name, input: {} }] },
});

const RESULT = { type: "result", subtype: "success" };
const stop = (crons?: ReadonlyArray<Record<string, unknown>>) => ({
  hook_event_name: "Stop",
  ...(crons === undefined ? {} : { session_crons: crons }),
});
const CRON = { id: "c1", schedule: "*/5 * * * *", recurring: true, prompt: "p" };

const apply = (from: ClaudeIdleStopWork, ...frames: ReadonlyArray<unknown>): ClaudeIdleStopWork =>
  frames.reduce<ClaudeIdleStopWork>(applyClaudeIdleStopFrame, from);

/** A process whose first turn reported no crons. */
const known = apply(
  applyClaudeStopHookInput(CLAUDE_IDLE_STOP_WORK_AT_PROCESS_START, stop([])),
  RESULT,
);

describe("Claude idle stop work: crons", () => {
  it("holds a new process until a report applies at a result", () => {
    const start = CLAUDE_IDLE_STOP_WORK_AT_PROCESS_START;
    expect(claudeIdleStopWorkHolds(start)).toEqual(["session_cron"]);
    // The report waits for the result frame of its turn.
    const reported = applyClaudeStopHookInput(start, stop([]));
    expect(claudeIdleStopWorkHolds(reported)).toEqual(["session_cron"]);
    expect(claudeIdleStopWorkHolds(apply(reported, RESULT))).toEqual([]);
    // A turn that ends without a Stop hook (interrupted) leaves them unknown.
    expect(claudeIdleStopWorkHolds(apply(start, RESULT))).toEqual(["session_cron"]);
    // So does an older CLI that sends no session_crons.
    expect(claudeIdleStopWorkHolds(apply(applyClaudeStopHookInput(start, stop()), RESULT))).toEqual(
      ["session_cron"],
    );
  });

  it("covers a cron tool frame the report overtook, once the result arrives", () => {
    // The CLI wrote the tool frame before its Stop hook, but the hook callback
    // ran before the frame left the SDK's buffer.
    const reported = applyClaudeStopHookInput(known, stop([]));
    const work = apply(reported, toolUse("ScheduleWakeup"), RESULT);
    expect(claudeIdleStopWorkHolds(work)).toEqual([]);
  });

  it("holds while a restored or reported cron is scheduled", () => {
    const restored = apply(
      applyClaudeStopHookInput(CLAUDE_IDLE_STOP_WORK_AT_PROCESS_START, stop([CRON])),
      RESULT,
    );
    expect(claudeIdleStopWorkHolds(restored)).toEqual(["session_cron"]);
    expect(restored.crons).toEqual([{ id: "c1", recurring: true }]);
    expect(
      claudeIdleStopWorkHolds(apply(applyClaudeStopHookInput(restored, stop([])), RESULT)),
    ).toEqual([]);
  });

  it.each([["ScheduleWakeup"], ["CronCreate"]])(
    "holds after %s until the next report applies",
    (tool) => {
      const used = apply(known, toolUse(tool));
      expect(claudeIdleStopWorkHolds(used)).toEqual(["session_cron"]);
      expect(claudeIdleStopWorkHolds(apply(used, RESULT))).toEqual(["session_cron"]);
      expect(
        claudeIdleStopWorkHolds(apply(applyClaudeStopHookInput(used, stop()), RESULT)),
      ).toEqual(["session_cron"]);
      expect(
        claudeIdleStopWorkHolds(apply(applyClaudeStopHookInput(used, stop([])), RESULT)),
      ).toEqual([]);
    },
  );

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
  it("holds for a task seen starting until a level clears it", () => {
    const running = apply(known, started("wf"));
    expect(claudeIdleStopWorkHolds(running)).toEqual(["background_task"]);
    // An end edge does not clear it: it cannot tell a resumed task apart.
    expect(
      claudeIdleStopWorkHolds(
        apply(running, notified("wf"), {
          type: "system",
          subtype: "task_updated",
          task_id: "wf",
          patch: { status: "failed" },
        }),
      ),
    ).toEqual(["background_task"]);
    expect(claudeIdleStopWorkHolds(apply(running, notified("wf"), level([])))).toEqual([]);
  });

  it("keeps a task that ended and then resumed busy", () => {
    const work = apply(known, started("agent"), notified("agent"), started("agent"));
    expect(claudeIdleStopWorkHolds(work)).toEqual(["background_task"]);
    // A start that arrives after its end holds too, until a level.
    expect(claudeIdleStopWorkHolds(apply(known, notified("quick"), started("quick")))).toEqual([
      "background_task",
    ]);
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
});

describe("Claude idle stop work: bookkeeping", () => {
  it("returns the same state for a frame that changes nothing", () => {
    const work = apply(known, level([{ task_id: "t1", task_type: "local_workflow" }]));
    expect(
      applyClaudeIdleStopFrame(work, level([{ task_id: "t1", task_type: "local_workflow" }])),
    ).toBe(work);
    expect(applyClaudeIdleStopFrame(work, RESULT)).toBe(work);
  });

  it("tells whether any process holds work", () => {
    expect(anyClaudeIdleStopWorkHolds([known, CLAUDE_IDLE_STOP_WORK_AT_PROCESS_START])).toBe(true);
    expect(anyClaudeIdleStopWorkHolds([known])).toBe(false);
    expect(anyClaudeIdleStopWorkHolds([])).toBe(false);
  });
});
