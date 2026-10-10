// FORK (T3MIG-FORK-014): the Claude process work that holds an idle stop.
import { describe, expect, it } from "vite-plus/test";

import {
  applyClaudeIdleStopFrame,
  applyClaudeStopHookInput,
  type ClaudeIdleStopWork,
  claudeIdleStopWorkHolds,
  EMPTY_CLAUDE_IDLE_STOP_WORK,
  updateClaudeIdleStopWork,
} from "./ClaudeIdleStopWork.ts";

const level = (tasks: ReadonlyArray<Record<string, unknown>>) => ({
  type: "system",
  subtype: "background_tasks_changed",
  tasks,
});

const toolUse = (name: string, parentToolUseId: string | null = null) => ({
  type: "assistant",
  parent_tool_use_id: parentToolUseId,
  message: { content: [{ type: "tool_use", id: `toolu_${name}`, name, input: {} }] },
});

const apply = (...frames: ReadonlyArray<unknown>): ClaudeIdleStopWork =>
  frames.reduce<ClaudeIdleStopWork>(applyClaudeIdleStopFrame, EMPTY_CLAUDE_IDLE_STOP_WORK);

describe("Claude idle stop work", () => {
  it("holds nothing for a fresh process", () => {
    expect(claudeIdleStopWorkHolds(EMPTY_CLAUDE_IDLE_STOP_WORK)).toEqual([]);
  });

  it.each([
    ["local_workflow"],
    ["local_agent"],
    ["local_bash"],
    ["mcp_task"],
    ["remote_agent"],
    ["dream"],
  ])("holds for a live %s task until the level drops it", (taskType) => {
    const running = apply(level([{ task_id: "t1", task_type: taskType, description: "x" }]));
    expect(claudeIdleStopWorkHolds(running)).toEqual(["background_task"]);
    expect(claudeIdleStopWorkHolds(applyClaudeIdleStopFrame(running, level([])))).toEqual([]);
  });

  it("counts ambient tasks too", () => {
    const work = apply(
      level([{ task_id: "w1", task_type: "local_bash", description: "watch", ambient: true }]),
    );
    expect(claudeIdleStopWorkHolds(work)).toEqual(["background_task"]);
  });

  it("follows task edges when the CLI sends no level", () => {
    const started = apply({
      type: "system",
      subtype: "task_started",
      task_id: "wf",
      task_type: "local_workflow",
    });
    expect(claudeIdleStopWorkHolds(started)).toEqual(["background_task"]);
    expect(
      claudeIdleStopWorkHolds(
        applyClaudeIdleStopFrame(started, {
          type: "system",
          subtype: "task_notification",
          task_id: "wf",
          status: "completed",
        }),
      ),
    ).toEqual([]);
    expect(
      claudeIdleStopWorkHolds(
        applyClaudeIdleStopFrame(started, {
          type: "system",
          subtype: "task_updated",
          task_id: "wf",
          patch: { status: "killed" },
        }),
      ),
    ).toEqual([]);
  });

  it("ignores a foreground task until it moves to the background", () => {
    const foreground = apply({
      type: "system",
      subtype: "task_started",
      task_id: "agent",
      task_type: "local_agent",
      is_backgrounded: false,
    });
    expect(claudeIdleStopWorkHolds(foreground)).toEqual([]);
    const backgrounded = applyClaudeIdleStopFrame(foreground, {
      type: "system",
      subtype: "task_updated",
      task_id: "agent",
      patch: { is_backgrounded: true },
    });
    expect(claudeIdleStopWorkHolds(backgrounded)).toEqual(["background_task"]);
  });

  it.each([["ScheduleWakeup"], ["CronCreate"]])(
    "holds after %s until a Stop hook reports the crons",
    (tool) => {
      const used = apply(toolUse(tool));
      expect(claudeIdleStopWorkHolds(used)).toEqual(["session_cron"]);
      // No session_crons (an older CLI): still unknown.
      expect(
        claudeIdleStopWorkHolds(applyClaudeStopHookInput(used, { hook_event_name: "Stop" })),
      ).toEqual(["session_cron"]);
      const reported = applyClaudeStopHookInput(used, {
        hook_event_name: "Stop",
        session_crons: [{ id: "c1", schedule: "*/5 * * * *", recurring: true, prompt: "p" }],
      });
      expect(claudeIdleStopWorkHolds(reported)).toEqual(["session_cron"]);
      expect(
        claudeIdleStopWorkHolds(
          applyClaudeStopHookInput(reported, { hook_event_name: "Stop", session_crons: [] }),
        ),
      ).toEqual([]);
    },
  );

  it("takes a subagent's cron tool and its SubagentStop report as the session's", () => {
    const used = apply(toolUse("CronCreate", "toolu_parent"));
    expect(claudeIdleStopWorkHolds(used)).toEqual(["session_cron"]);
    const reported = applyClaudeStopHookInput(used, {
      hook_event_name: "SubagentStop",
      session_crons: [{ id: "c1", schedule: "0 9 * * *", recurring: true, prompt: "p" }],
    });
    expect(reported.crons).toEqual([{ id: "c1", recurring: true }]);
  });

  it("does not hold for other tools or text", () => {
    expect(claudeIdleStopWorkHolds(apply(toolUse("Bash"), toolUse("CronList")))).toEqual([]);
  });

  it("returns the same state and map for a frame that changes nothing", () => {
    const work = apply(level([{ task_id: "t1", task_type: "local_workflow" }]));
    expect(
      applyClaudeIdleStopFrame(work, level([{ task_id: "t1", task_type: "local_workflow" }])),
    ).toBe(work);
    expect(applyClaudeIdleStopFrame(work, { type: "result" })).toBe(work);
    const map = new Map([["native", work]]);
    expect(updateClaudeIdleStopWork(map, "native", (current) => current)).toBe(map);
    const updated = updateClaudeIdleStopWork(map, "other", (current) =>
      applyClaudeIdleStopFrame(current, toolUse("ScheduleWakeup")),
    );
    expect(updated).not.toBe(map);
    expect(claudeIdleStopWorkHolds(updated.get("other")!)).toEqual(["session_cron"]);
  });
});
