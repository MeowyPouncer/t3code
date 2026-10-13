import type { TodoBoardCard } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { canStartTaskAgent, planTaskAgentLaunches } from "./taskAgentsLogic";

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

const geo = card({ id: "HOME-GEO-001", title: "Geo tab", brief: "Group sections by region" });
const band = card({ id: "HOME-BAND-002", title: "Band plan", brief: "Band plan", prompt: "" });

describe("planTaskAgentLaunches", () => {
  it("starts a thread per card with the card's own prompt, named by its ID", () => {
    expect(
      planTaskAgentLaunches({
        mode: "separate",
        projectTitle: "catwolf-project",
        cards: [geo, band],
        instructions: "unused",
      }),
    ).toEqual([
      {
        title: "HOME-GEO-001 · Geo tab",
        text: "/take-card HOME-GEO-001\n\nGroup sections by region",
      },
      { title: "HOME-BAND-002 · Band plan", text: "/take-card HOME-BAND-002\n\nBand plan" },
    ]);
  });

  it("starts one orchestrator with the instructions and every card in its first message", () => {
    const [launch, ...rest] = planTaskAgentLaunches({
      mode: "orchestrator",
      projectTitle: "catwolf-project",
      cards: [geo, band],
      instructions: "Launch one writer per card.",
    });
    expect(rest).toEqual([]);
    expect(launch?.title).toBe("HOME-GEO-001 + HOME-BAND-002 · orchestrator");
    expect(launch?.instructions).toBe("Launch one writer per card.");
    expect(launch?.text).toBe(
      [
        "Orchestrate these 2 cards from the catwolf-project TODO board:",
        [
          "1. HOME-GEO-001 — Geo tab",
          "   Brief: Group sections by region",
          "   Card file: docs/todo/HOME-GEO-001.md",
          "   Start prompt: /take-card HOME-GEO-001",
        ].join("\n"),
        [
          "2. HOME-BAND-002 — Band plan",
          "   Card file: docs/todo/HOME-BAND-002.md",
          "   Start prompt: /take-card HOME-BAND-002",
        ].join("\n"),
      ].join("\n\n"),
    );
  });

  it("starts nothing without cards, and never for a card known only on origin", () => {
    expect(
      planTaskAgentLaunches({
        mode: "orchestrator",
        projectTitle: "p",
        cards: [],
        instructions: "x",
      }),
    ).toEqual([]);
    expect(canStartTaskAgent(card({ origin_only: true }))).toBe(false);
    expect(canStartTaskAgent(geo)).toBe(true);
  });
});
