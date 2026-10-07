// @vitest-environment jsdom
import { EnvironmentId, ProjectId, type TodoBoardSnapshot } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { TasksPage } from "./TasksPage";

const project = {
  id: ProjectId.make("board"),
  environmentId: EnvironmentId.make("local"),
  title: "AIHub",
  workspaceRoot: "/integration",
};
const snapshot: TodoBoardSnapshot = {
  root: "/integration",
  url: "",
  generated_at: "2026-10-07 06:00 UTC",
  generated_ts: 0,
  cards: [],
  backlog_cards: [
    {
      id: "PARKED-001",
      kind: "card",
      title: "Parked task",
      brief: "Keep this parked",
      prompt: "/take-card PARKED-001",
      path: "docs/todo/PARKED-001.md",
      status: "backlog",
      pri: "P2",
      size: "S",
      area: "core",
      pack: "",
      source: "backlog",
      ord: 0,
      created: null,
      modified: null,
      stale: false,
      origin_only: false,
      origin_status: null,
      branch: null,
    },
  ],
  area_order: ["core"],
  counts: { total: 0, ready: 0, in_progress: 0, blocked: 0, backlog: 1, backlog_notes: 0 },
};
const refresh = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("~/env", () => ({ isElectron: false }));
vi.mock("~/state/entities", () => ({
  useProjects: () => [project],
  useThreadShells: () => [],
  useServerConfigs: () =>
    new Map([[project.environmentId, { environment: { capabilities: { todoBoard: true } } }]]),
}));
vi.mock("~/state/environments", () => ({ useEnvironmentHttpBaseUrl: () => null }));
vi.mock("~/state/projects", () => ({
  projectTodoBoard: () => ({ kind: "board" }),
  projectEnvironment: { readFile: () => ({ kind: "file" }) },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: { kind: string } | null) => ({
    data:
      atom?.kind === "board"
        ? { available: true, snapshot }
        : atom?.kind === "file"
          ? { contents: "Card source", truncated: false }
          : null,
    isPending: false,
    error: null,
    refresh,
  }),
}));
vi.mock("~/components/WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
}));
vi.mock("~/components/ChatMarkdown", () => ({
  default: ({ text }: { text: string }) => <pre>{text}</pre>,
}));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function click(label: string, within: Element = host) {
  const button = [...within.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!button) throw new Error(`Missing button: ${label}`);
  await act(async () => button.click());
}

it("preserves Backlog, Table, search and scroll when reading a card and returning", async () => {
  await act(async () =>
    root.render(
      <TasksPage search={{ environmentId: project.environmentId, projectId: project.id }} />,
    ),
  );
  await click("Backlog", host.querySelector('[aria-label="Task source"]')!);
  await click("Table", host.querySelector('[aria-label="Task view"]')!);
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Search tasks"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "Parked",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const scroll = host.querySelector("table")!.parentElement!;
  scroll.scrollTop = 180;
  await click("Parked task");
  expect(host.querySelector("pre")?.textContent).toBe("Card source");
  await click("Tasks");
  expect(host.querySelector<HTMLInputElement>('input[aria-label="Search tasks"]')?.value).toBe(
    "Parked",
  );
  expect(
    host.querySelector('[aria-label="Task source"] button[aria-pressed="true"]')?.textContent,
  ).toBe("Backlog");
  expect(
    host.querySelector('[aria-label="Task view"] button[aria-pressed="true"]')?.textContent,
  ).toBe("Table");
  expect(host.querySelector("table")?.parentElement?.scrollTop).toBe(180);
  expect(host.querySelector("table")?.closest("[hidden]")).toBeNull();
});
