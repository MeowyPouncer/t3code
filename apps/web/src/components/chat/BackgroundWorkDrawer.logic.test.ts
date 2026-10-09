import { describe, expect, it } from "vite-plus/test";

import {
  backgroundWorkOutputTaskIds,
  createReadWhenShown,
  finishedBackgroundWorkTitle,
  markBackgroundWorkRead,
  nextBackgroundWorkHistory,
  type BackgroundWorkEntry,
} from "./BackgroundWorkDrawer.logic";

function entry(taskId: string, overrides: Partial<BackgroundWorkEntry> = {}): BackgroundWorkEntry {
  return {
    taskId,
    kind: "command",
    label: `run ${taskId}`,
    childThreadId: undefined,
    kindLabel: "Command",
    command: undefined,
    startedAt: undefined,
    hasOutput: true,
    ...overrides,
  };
}

describe("backgroundWorkOutputTaskIds", () => {
  it("names Claude roster commands and monitors, not subagents or other providers", () => {
    const ids = backgroundWorkOutputTaskIds([
      {
        driver: "claudeAgent" as never,
        pendingBackgroundTasks: [
          { taskId: "bash1", kind: "command" },
          { taskId: "mon1", kind: "monitor" },
          { taskId: "agent1", kind: "subagent" },
        ],
      },
      {
        driver: "codex" as never,
        pendingBackgroundTasks: [{ taskId: "codex1", kind: "command" }],
      },
    ]);
    expect([...ids].toSorted()).toEqual(["bash1", "mon1"]);
  });
});

describe("nextBackgroundWorkHistory", () => {
  it("starts from the first settled snapshot with nothing finished", () => {
    const history = nextBackgroundWorkHistory(undefined, {
      running: [entry("a")],
      latestRunId: "run-1",
      nowIso: "2026-10-09T10:00:00.000Z",
    });
    expect(history.finished).toEqual([]);
    expect(history.running.map((item) => item.taskId)).toEqual(["a"]);
  });

  it("lists work that left the roster as finished, newest first", () => {
    let history = nextBackgroundWorkHistory(undefined, {
      running: [entry("a"), entry("b")],
      latestRunId: "run-1",
      nowIso: "2026-10-09T10:00:00.000Z",
    });
    history = nextBackgroundWorkHistory(history, {
      running: [entry("b")],
      latestRunId: "run-2",
      nowIso: "2026-10-09T10:05:00.000Z",
    });
    history = nextBackgroundWorkHistory(history, {
      running: [],
      latestRunId: "run-3",
      nowIso: "2026-10-09T10:09:00.000Z",
    });
    expect(history.finished.map((item) => [item.taskId, item.finishedAt, item.read])).toEqual([
      ["b", "2026-10-09T10:09:00.000Z", false],
      ["a", "2026-10-09T10:05:00.000Z", false],
    ]);
  });

  it("keeps unread finished work across turns", () => {
    let history = nextBackgroundWorkHistory(undefined, {
      running: [entry("a")],
      latestRunId: "run-1",
      nowIso: "t1",
    });
    history = nextBackgroundWorkHistory(history, {
      running: [],
      latestRunId: "run-2",
      nowIso: "t2",
    });
    history = nextBackgroundWorkHistory(history, {
      running: [],
      latestRunId: "run-3",
      nowIso: "t3",
    });
    expect(history.finished.map((item) => item.taskId)).toEqual(["a"]);
  });

  it("drops read work once the next run has started, not before", () => {
    let history = nextBackgroundWorkHistory(undefined, {
      running: [entry("a")],
      latestRunId: "run-1",
      nowIso: "t1",
    });
    history = nextBackgroundWorkHistory(history, {
      running: [],
      latestRunId: "run-2",
      nowIso: "t2",
    });
    history = markBackgroundWorkRead(history, "run-2");
    expect(history.finished.map((item) => item.read)).toEqual([true]);

    const sameTurn = nextBackgroundWorkHistory(history, {
      running: [],
      latestRunId: "run-2",
      nowIso: "t3",
    });
    expect(sameTurn).toBe(history);

    const nextTurn = nextBackgroundWorkHistory(history, {
      running: [],
      latestRunId: "run-3",
      nowIso: "t4",
    });
    expect(nextTurn.finished).toEqual([]);
    expect(nextTurn.readAtRunId).toBeNull();
  });

  it("keeps work that finished after the read when the read rows go", () => {
    let history = nextBackgroundWorkHistory(undefined, {
      running: [entry("a"), entry("b")],
      latestRunId: "run-1",
      nowIso: "t1",
    });
    history = nextBackgroundWorkHistory(history, {
      running: [entry("b")],
      latestRunId: "run-1",
      nowIso: "t2",
    });
    history = markBackgroundWorkRead(history, "run-1");
    history = nextBackgroundWorkHistory(history, {
      running: [],
      latestRunId: "run-2",
      nowIso: "t3",
    });
    expect(history.finished.map((item) => [item.taskId, item.read])).toEqual([["b", false]]);
  });

  it("runs a finished item again when it returns to the roster", () => {
    let history = nextBackgroundWorkHistory(undefined, {
      running: [entry("agent", { kind: "subagent", kindLabel: "Subagent", hasOutput: false })],
      latestRunId: "run-1",
      nowIso: "t1",
    });
    history = nextBackgroundWorkHistory(history, {
      running: [],
      latestRunId: "run-1",
      nowIso: "t2",
    });
    expect(history.finished).toHaveLength(1);
    history = nextBackgroundWorkHistory(history, {
      running: [entry("agent", { kind: "subagent", kindLabel: "Subagent", hasOutput: false })],
      latestRunId: "run-2",
      nowIso: "t3",
    });
    expect(history.finished).toEqual([]);
    expect(history.running.map((item) => item.taskId)).toEqual(["agent"]);
  });

  it("returns the same history when an equal snapshot repeats", () => {
    const history = nextBackgroundWorkHistory(undefined, {
      running: [entry("a")],
      latestRunId: "run-1",
      nowIso: "t1",
    });
    expect(
      nextBackgroundWorkHistory(history, {
        running: [entry("a")],
        latestRunId: "run-1",
        nowIso: "t2",
      }),
    ).toBe(history);
  });

  it("caps the finished list", () => {
    const many = Array.from({ length: 30 }, (_, index) => entry(`t${index}`));
    let history = nextBackgroundWorkHistory(undefined, {
      running: many,
      latestRunId: "run-1",
      nowIso: "t1",
    });
    history = nextBackgroundWorkHistory(history, {
      running: [],
      latestRunId: "run-1",
      nowIso: "t2",
    });
    expect(history.finished).toHaveLength(20);
  });
});

describe("finishedBackgroundWorkTitle", () => {
  it("names one finished item or counts several by kind", () => {
    expect(finishedBackgroundWorkTitle([{ kindLabel: "Command", label: "npm test" }])).toBe(
      "Finished: npm test",
    );
    expect(finishedBackgroundWorkTitle([{ kindLabel: "Monitor", label: "monitor" }])).toBe(
      "A monitor finished",
    );
    expect(
      finishedBackgroundWorkTitle([
        { kindLabel: "Command", label: "a" },
        { kindLabel: "Command", label: "b" },
        { kindLabel: "Subagent", label: "c" },
      ]),
    ).toBe("2 commands and 1 subagent finished");
  });
});

describe("createReadWhenShown", () => {
  function harness(shown: { value: boolean }) {
    const timers: Array<{ callback: () => void; cleared: boolean }> = [];
    let reads = 0;
    const reader = createReadWhenShown({
      delayMs: 600,
      isShown: () => shown.value,
      onRead: () => {
        reads += 1;
      },
      setTimer: (callback) => {
        const timer = { callback, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimer: (handle) => {
        (handle as { cleared: boolean }).cleared = true;
      },
    });
    const fire = () => {
      for (const timer of timers.splice(0)) if (!timer.cleared) timer.callback();
    };
    return { reader, fire, reads: () => reads };
  }

  it("never reads rows that are not on screen", () => {
    const { fire, reads } = harness({ value: true });
    fire();
    expect(reads()).toBe(0);
  });

  it("reads rows that stayed on screen for the delay", () => {
    const { reader, fire, reads } = harness({ value: true });
    reader.intersect(true);
    fire();
    expect(reads()).toBe(1);
  });

  it("does not read rows that left the screen before the delay", () => {
    const { reader, fire, reads } = harness({ value: true });
    reader.intersect(true);
    reader.intersect(false);
    fire();
    expect(reads()).toBe(0);
  });

  it("waits while intersecting rows are hidden, then reads once they show", () => {
    const shown = { value: false };
    const { reader, fire, reads } = harness(shown);
    reader.intersect(true);
    fire();
    fire();
    expect(reads()).toBe(0);
    shown.value = true;
    fire();
    expect(reads()).toBe(1);
  });
});
