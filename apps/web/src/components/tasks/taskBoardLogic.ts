import type { TodoBoardCard, TodoBoardSnapshot } from "@t3tools/contracts";

export type TaskSource = "todo" | "backlog" | "all";
export type TaskView = "board" | "areas" | "table" | "timeline";
export interface TaskFilters {
  source: TaskSource;
  search: string;
  status: string;
  priority: string;
  area: string;
}

const priorityRank = (priority: string | null) => Number(priority?.match(/^P(\d+)$/)?.[1] ?? 9);

export function filteredTasks(snapshot: TodoBoardSnapshot, filters: TaskFilters) {
  const cards =
    filters.source === "todo"
      ? snapshot.cards
      : filters.source === "backlog"
        ? snapshot.backlog_cards
        : [...snapshot.cards, ...snapshot.backlog_cards];
  const query = filters.search.trim().toLocaleLowerCase();
  return cards
    .filter(
      (card) =>
        (!filters.status || card.status === filters.status) &&
        (!filters.priority || card.pri === filters.priority) &&
        (!filters.area || card.area === filters.area) &&
        (!query ||
          [card.id, card.title, card.brief, card.area, card.pack, card.branch?.branch]
            .join(" ")
            .toLocaleLowerCase()
            .includes(query)),
    )
    .toSorted(
      (a, b) =>
        priorityRank(a.pri) - priorityRank(b.pri) || a.ord - b.ord || a.id.localeCompare(b.id),
    );
}

export function taskPrompt(card: TodoBoardCard) {
  return card.kind === "note"
    ? card.prompt
    : `${card.prompt || `/take-card ${card.id}`}\n\n${card.brief || card.title}`;
}

export function appendTaskPrompt(existing: string, card: TodoBoardCard) {
  const prompt = taskPrompt(card);
  return existing.endsWith(prompt)
    ? existing
    : existing.length > 0
      ? `${existing}\n\n${prompt}`
      : prompt;
}

export function taskStatusLabel(status: string) {
  return (
    {
      ready: "Ready",
      in_progress: "In progress",
      blocked: "Blocked",
      backlog: "Backlog",
      closed: "Closed",
    }[status] ?? status
  );
}
