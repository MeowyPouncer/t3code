import {
  ProjectId,
  ProviderInstanceId,
  type ModelSelection,
  type TodoBoardCard,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { nightPromptTitle, planNightEnd } from "./nightPlanLogic";

const card = (id: string, title: string): TodoBoardCard => ({
  id,
  kind: "card",
  title,
  brief: title,
  prompt: `/take-card ${id}`,
  path: `docs/todo/${id}.md`,
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
});

const projectId = ProjectId.make("project");
const modelSelection = {
  instanceId: ProviderInstanceId.make("claude"),
  model: "claude-opus-5-5",
} satisfies ModelSelection;

const plan = (input: Partial<Parameters<typeof planNightEnd>[0]>) =>
  planNightEnd({
    projectId,
    projectTitle: "catwolf-project",
    modelSelection,
    runtimeMode: "full-access",
    cards: [],
    mode: "separate",
    instructions: "Orchestrate.",
    prompts: [],
    ...input,
  });

describe("planNightEnd", () => {
  it("starts the picked cards the way Tasks does, never in plan mode", () => {
    const { agents } = plan({
      cards: [card("HOME-GEO-001", "Geo tab"), card("HOME-BAND-002", "Band plan")],
      mode: "orchestrator",
    });
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      projectId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      title: "HOME-GEO-001 + HOME-BAND-002 · orchestrator",
      instructions: "Orchestrate.",
    });
  });

  it("limits card agents through the queue, and tells an orchestrator instead", () => {
    const cards = [card("A-1", "One"), card("A-2", "Two"), card("A-3", "Three")];
    expect(plan({ cards, maxRunning: 2 }).maxAgents).toBe(2);
    expect(plan({ cards, maxRunning: 3 }).maxAgents).toBeUndefined();
    const orchestrated = plan({ cards, maxRunning: 2, mode: "orchestrator" });
    expect(orchestrated.maxAgents).toBeUndefined();
    expect(orchestrated.agents[0]?.text).toContain("Run at most 2 writers at a time");
  });

  it("queues each prompt that has text, named by its first line", () => {
    const { agents, queue } = plan({ prompts: ["  Update the docs\nthen the changelog", " ", ""] });
    expect(agents).toEqual([]);
    expect(queue.map((launch) => [launch.title, launch.text])).toEqual([
      ["Update the docs", "Update the docs\nthen the changelog"],
    ]);
  });
});

describe("nightPromptTitle", () => {
  it("cuts a long first line", () => {
    const title = nightPromptTitle("x".repeat(80));
    expect(title).toHaveLength(60);
    expect(title.endsWith("…")).toBe(true);
  });
});
