import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { TodoBoardCard, TodoBoardSnapshot } from "@t3tools/contracts";
import {
  ExpandIcon,
  ExternalLinkIcon,
  FileTextIcon,
  MessageSquareIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { readLocalApi } from "~/localApi";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { useServerConfigs } from "~/state/entities";
import { projectTodoBoard } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { filteredTasks, taskStatusLabel, type TaskFilters, type TaskView } from "./taskBoardLogic";

interface TasksPanelProps {
  project: EnvironmentProject;
  visible?: boolean;
  onUseInChat: (card: TodoBoardCard) => void;
  onOpenFile: (snapshot: TodoBoardSnapshot, card: TodoBoardCard) => void;
  onExpand?: () => void;
}

function TaskFilter(props: {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      value={props.value}
      items={props.options}
      onValueChange={(value) => props.onChange(value ?? "")}
    >
      <SelectTrigger size="sm" aria-label={props.label}>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {props.options.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function TaskCard(props: { card: TodoBoardCard; onUse: () => void; onOpen: () => void }) {
  const card = props.card;
  return (
    <article className="flex flex-col gap-2 rounded-lg border bg-card p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 break-all font-mono">{card.id}</span>
        <span className="shrink-0">{[card.pri, card.size].filter(Boolean).join(" · ") || "—"}</span>
      </div>
      <button
        type="button"
        className="text-left text-sm font-medium hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
        onClick={props.onOpen}
        disabled={card.origin_only}
      >
        {card.title}
      </button>
      <p className="line-clamp-2 text-xs text-muted-foreground">{card.brief || card.title}</p>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{card.area}</span>
        {card.pack ? <span>{card.pack}</span> : null}
        {card.kind === "note" ? <span>Older note</span> : null}
      </div>
      {card.branch ? (
        <div className="break-all font-mono text-xs text-muted-foreground">
          {card.branch.branch}
          {card.branch.tip_status ? ` · ${card.branch.tip_status}` : ""}
        </div>
      ) : null}
      {card.stale || card.origin_only || card.origin_status ? (
        <div className="flex flex-wrap gap-2 text-xs text-warning-foreground">
          {card.stale ? <span>Stale claim</span> : null}
          {card.origin_only ? <span>Origin only</span> : null}
          {card.origin_status ? <span>Origin: {taskStatusLabel(card.origin_status)}</span> : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="xs" onClick={props.onUse}>
          <MessageSquareIcon />
          Use in chat
        </Button>
        <Button variant="ghost" size="xs" onClick={props.onOpen} disabled={card.origin_only}>
          <FileTextIcon />
          {card.kind === "note" ? "Read note" : "Open file"}
        </Button>
      </div>
    </article>
  );
}

function TaskGroups(props: {
  cards: ReadonlyArray<TodoBoardCard>;
  view: Exclude<TaskView, "table">;
  renderCard: (card: TodoBoardCard) => ReactNode;
}) {
  const groups = new Map<string, TodoBoardCard[]>();
  for (const card of props.cards) {
    const key =
      props.view === "board"
        ? card.status
        : props.view === "areas"
          ? card.area
          : card.modified === null
            ? "Unknown date"
            : new Date(card.modified * 1000).toLocaleDateString();
    const group = groups.get(key) ?? [];
    group.push(card);
    groups.set(key, group);
  }
  const entries = [...groups];
  if (props.view === "board")
    entries.sort(
      ([a], [b]) =>
        ["ready", "in_progress", "blocked", "backlog"].indexOf(a) -
        ["ready", "in_progress", "blocked", "backlog"].indexOf(b),
    );
  if (props.view === "timeline")
    entries.sort(
      (a, b) =>
        Math.max(...b[1].map((c) => c.modified ?? 0)) -
        Math.max(...a[1].map((c) => c.modified ?? 0)),
    );
  return (
    <div className="flex flex-wrap items-start gap-4">
      {entries.map(([key, cards]) => (
        <section key={key} className="min-w-[min(17rem,100%)] flex-1 space-y-3">
          <h2 className="flex items-center justify-between gap-2 text-xs font-medium">
            <span>{props.view === "board" ? taskStatusLabel(key) : key}</span>
            <span className="text-muted-foreground">{cards.length}</span>
          </h2>
          {cards.map(props.renderCard)}
        </section>
      ))}
    </div>
  );
}

export function TasksPanel({
  project,
  visible = true,
  onUseInChat,
  onOpenFile,
  onExpand,
}: TasksPanelProps) {
  const configs = useServerConfigs();
  const config = configs.get(project.environmentId);
  const supported = config?.environment.capabilities.todoBoard === true;
  const query = useEnvironmentQuery(
    visible && supported
      ? projectTodoBoard({ environmentId: project.environmentId, input: { projectId: project.id } })
      : null,
  );
  const baseUrl = useEnvironmentHttpBaseUrl(project.environmentId);
  const [filters, setFilters] = useState<TaskFilters>({
    source: "todo",
    search: "",
    status: "",
    priority: "",
    area: "",
  });
  const [view, setView] = useState<TaskView>("board");
  const refresh = query.refresh;
  useEffect(() => {
    if (!visible || !supported) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [visible, supported, refresh]);
  if (!config)
    return (
      <div className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        <Spinner />
        Connecting to environment…
      </div>
    );
  if (!supported)
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Tasks are unavailable on this environment.
      </div>
    );
  const snapshot = query.data?.available ? query.data.snapshot : null;
  if (!snapshot)
    return (
      <div className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        {query.isPending ? (
          <>
            <Spinner />
            Loading tasks…
          </>
        ) : query.error ? (
          <div role="alert" className="flex items-center gap-2">
            <span>{query.error}</span>
            <Button variant="outline" size="xs" onClick={refresh}>
              Retry
            </Button>
          </div>
        ) : (
          "This project has no TODO board."
        )}
      </div>
    );
  const cards = filteredTasks(snapshot, filters);
  const setFilter = (field: keyof TaskFilters, value: string) =>
    setFilters((previous) => ({ ...previous, [field]: value }));
  const localEnvironment =
    baseUrl !== null && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseUrl).hostname);
  const renderCard = (card: TodoBoardCard) => (
    <TaskCard
      key={card.id}
      card={card}
      onUse={() => onUseInChat(card)}
      onOpen={() => onOpenFile(snapshot, card)}
    />
  );
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-3 border-b p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-base font-medium">Tasks</h1>
          <span className="text-xs text-muted-foreground">{project.title}</span>
          <div className="ml-auto flex items-center gap-1">
            {localEnvironment && snapshot.url ? (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  void readLocalApi()?.shell.openExternal(snapshot.url);
                }}
              >
                <ExternalLinkIcon />
                External board
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Refresh tasks"
              disabled={query.isPending}
              onClick={refresh}
            >
              {query.isPending ? <Spinner /> : <RefreshCwIcon />}
            </Button>
            {onExpand ? (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Expand Tasks to full workspace"
                onClick={onExpand}
              >
                <ExpandIcon />
              </Button>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {(["ready", "in_progress", "blocked"] as const).map((status) => (
            <Button
              key={status}
              variant="outline"
              size="sm"
              aria-pressed={filters.status === status}
              onClick={() => setFilter("status", filters.status === status ? "" : status)}
            >
              <span className="tabular-nums">{snapshot.counts[status]}</span>
              {taskStatusLabel(status)}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div role="group" aria-label="Task source" className="flex gap-1">
            {(["todo", "backlog", "all"] as const).map((source) => (
              <Button
                key={source}
                size="xs"
                variant={filters.source === source ? "secondary" : "ghost"}
                aria-pressed={filters.source === source}
                onClick={() => setFilters((previous) => ({ ...previous, source, status: "" }))}
              >
                {source === "todo" ? "TODO" : source === "backlog" ? "Backlog" : "All"}
              </Button>
            ))}
          </div>
          <div role="group" aria-label="Task view" className="flex flex-wrap gap-1">
            {(["board", "areas", "table", "timeline"] as const).map((next) => (
              <Button
                key={next}
                size="xs"
                variant={view === next ? "secondary" : "ghost"}
                aria-pressed={view === next}
                onClick={() => setView(next)}
              >
                {next.slice(0, 1).toUpperCase() + next.slice(1)}
              </Button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-36 flex-1">
            <Input
              size="sm"
              type="search"
              value={filters.search}
              onChange={(event) => setFilter("search", event.target.value)}
              aria-label="Search tasks"
              placeholder="Search tasks…"
            />
          </div>
          <TaskFilter
            label="Task status"
            value={filters.status}
            options={[
              { value: "", label: "All statuses" },
              ...["ready", "in_progress", "blocked", "backlog"].map((value) => ({
                value,
                label: taskStatusLabel(value),
              })),
            ]}
            onChange={(value) => setFilter("status", value)}
          />
          <TaskFilter
            label="Priority"
            value={filters.priority}
            options={[
              { value: "", label: "All priorities" },
              ...["P0", "P1", "P2", "P3"].map((value) => ({ value, label: value })),
            ]}
            onChange={(value) => setFilter("priority", value)}
          />
          <TaskFilter
            label="Task area"
            value={filters.area}
            options={[
              { value: "", label: "All areas" },
              ...snapshot.area_order.map((value) => ({ value, label: value })),
            ]}
            onChange={(value) => setFilter("area", value)}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {cards.length} tasks
            {filters.source === "backlog"
              ? ` · ${snapshot.counts.backlog} cards · ${snapshot.counts.backlog_notes} older notes`
              : ""}
          </span>
          <Tooltip>
            <TooltipTrigger render={<span tabIndex={0} />}>
              Updated{" "}
              {new Date(snapshot.generated_ts * 1000).toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              })}
            </TooltipTrigger>
            <TooltipPopup>{snapshot.generated_at}</TooltipPopup>
          </Tooltip>
        </div>
        {query.error ? (
          <div role="alert" className="text-sm text-warning-foreground">
            Refresh failed. Showing the previous snapshot.
          </div>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {cards.length === 0 ? (
          <p className="text-sm text-muted-foreground">No matching tasks.</p>
        ) : view === "table" ? (
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="p-2">Task</th>
                <th className="p-2">Status</th>
                <th className="p-2">Priority</th>
                <th className="p-2">Area</th>
                <th className="p-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {cards.map((card) => (
                <tr key={card.id} className="border-b">
                  <td className="min-w-44 p-2">
                    <div className="font-mono text-muted-foreground">{card.id}</div>
                    <button
                      type="button"
                      onClick={() => onOpenFile(snapshot, card)}
                      disabled={card.origin_only}
                      className="text-left hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      {card.title}
                    </button>
                  </td>
                  <td className="p-2">
                    {taskStatusLabel(card.status)}
                    {card.stale ? <div className="text-warning-foreground">Stale claim</div> : null}
                    {card.origin_only ? (
                      <div className="text-warning-foreground">Origin only</div>
                    ) : null}
                    {card.origin_status ? (
                      <div className="text-warning-foreground">
                        Origin: {taskStatusLabel(card.origin_status)}
                      </div>
                    ) : null}
                  </td>
                  <td className="p-2">{card.pri ?? "—"}</td>
                  <td className="p-2">{card.area}</td>
                  <td className="p-2">
                    <Button variant="outline" size="xs" onClick={() => onUseInChat(card)}>
                      Use in chat
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <TaskGroups cards={cards} view={view} renderCard={renderCard} />
        )}
      </div>
    </div>
  );
}
