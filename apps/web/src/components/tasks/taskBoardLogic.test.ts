import type { TodoBoardCard, TodoBoardSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { appendTaskPrompt, filteredTasks, taskPrompt, type TaskFilters } from "./taskBoardLogic";

const card = (overrides: Partial<TodoBoardCard> = {}): TodoBoardCard => ({
  id: "TASK-001",
  kind: "card",
  title: "Task",
  brief: "Outcome",
  prompt: `/take-card ${overrides.id ?? "TASK-001"}`,
  path: `docs/todo/${overrides.id ?? "TASK-001"}.md`,
  status: "ready",
  pri: "P1",
  size: "S",
  area: "core",
  pack: "",
  source: "todo",
  ord: 0,
  created: null,
  modified: null,
  stale: false,
  origin_only: false,
  origin_status: null,
  branch: null,
  ...overrides,
});
const todo = card({
  id: "ACTIVE-001",
  status: "in_progress",
  stale: true,
  origin_status: "closed",
  branch: { branch: "task/active-001", dirty: 3, ahead: 1, behind: 2, tip_status: "in_progress" },
});
const parked = card({
  id: "PARKED-001",
  source: "backlog",
  status: "backlog",
  pri: null,
  size: null,
});
const note = card({
  id: "NOTE-001",
  kind: "note",
  source: "backlog",
  status: "backlog",
  prompt: "Full original note\n\nKeep its boundaries.",
  path: "BACKLOG.md",
  pri: null,
  size: null,
});
const data: TodoBoardSnapshot = {
  root: "/project",
  url: "",
  generated_at: "2026-10-07 06:00 UTC",
  generated_ts: 0,
  cards: [todo, card()],
  backlog_cards: [parked, note],
  area_order: ["core"],
  counts: { total: 2, ready: 1, in_progress: 1, blocked: 0, backlog: 1, backlog_notes: 1 },
};
const filters: TaskFilters = { source: "todo", search: "", status: "", priority: "", area: "" };

describe("native task board", () => {
  it("keeps TODO, parked cards and original notes separate without promoting backlog", () => {
    expect(filteredTasks(data, filters).map((c) => c.id)).toEqual(["ACTIVE-001", "TASK-001"]);
    expect(filteredTasks(data, { ...filters, source: "backlog" }).map((c) => c.id)).toEqual([
      "NOTE-001",
      "PARKED-001",
    ]);
    expect(filteredTasks(data, { ...filters, source: "all" })).toHaveLength(4);
    expect(parked.status).toBe("backlog");
  });
  it("preserves a local claim and origin discrepancy while filtering on local status and branch", () => {
    const result = filteredTasks(data, {
      ...filters,
      status: "in_progress",
      search: "task/active-001",
    });
    expect(result).toEqual([todo]);
    expect(result[0]?.stale).toBe(true);
    expect(result[0]?.origin_status).toBe("closed");
    expect(filteredTasks(data, { ...filters, status: "closed" })).toEqual([]);
  });
  it("handles missing estimates and unknown priority without changing missing data to zero", () => {
    const unknown = card({ id: "UNKNOWN-001", pri: "?" });
    const sorted = filteredTasks({ ...data, cards: [unknown, ...data.cards] }, filters);
    expect(sorted.at(-1)).toEqual(unknown);
    expect(parked.size).toBeNull();
  });
  it("keeps P0 questions ahead of ready work instead of treating zero as missing priority", () => {
    const question = card({ id: "QUESTION-001", pri: "P0", status: "blocked" });
    expect(filteredTasks({ ...data, cards: [...data.cards, question] }, filters)[0]).toBe(question);
    expect(
      filteredTasks({ ...data, cards: [...data.cards, question] }, { ...filters, priority: "P0" }),
    ).toEqual([question]);
  });
  it("stages original notes without making a take-card command", () => {
    expect(taskPrompt(note)).toBe(note.prompt);
    expect(taskPrompt(note)).not.toContain("/take-card");
  });
  it("appends a card without overwriting an existing draft or duplicating repeated staging", () => {
    const draft = "My unfinished request\nwith its context";
    const staged = appendTaskPrompt(draft, todo);
    expect(staged).toBe(`${draft}\n\n/take-card ACTIVE-001\n\nOutcome`);
    expect(appendTaskPrompt(staged, todo)).toBe(staged);
    expect(appendTaskPrompt("", note)).toBe(note.prompt);
  });
});
