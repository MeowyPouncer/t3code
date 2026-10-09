import { formatPendingBackgroundWorkStatus } from "@t3tools/client-runtime/state/thread-execution";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon, CircleDotIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { cn } from "~/lib/utils";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { Button, InlineButton } from "../ui/button";
import {
  createReadWhenShown,
  markBackgroundWorkRead,
  nextBackgroundWorkHistory,
  type BackgroundWorkEntry,
  type BackgroundWorkHistory,
  type FinishedBackgroundWorkEntry,
} from "./BackgroundWorkDrawer.logic";
import { ComposerBanner } from "./ComposerBanner";

// Per thread, across thread switches; a reload starts over.
const histories = new Map<string, BackgroundWorkHistory>();
const listeners = new Set<() => void>();
const NO_FINISHED: ReadonlyArray<FinishedBackgroundWorkEntry> = [];
const OUTPUT_REFRESH_MS = 2_000;
/** How long finished rows must stay on screen to count as read. */
const READ_AFTER_SHOWN_MS = 600;

/** On screen as far as layout can tell: sized, not hidden, page not in the background. */
function isElementShown(element: HTMLElement): boolean {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return false;
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  return element.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) ?? true;
}

function setHistory(key: string, next: BackgroundWorkHistory): void {
  if (histories.get(key) === next) return;
  histories.set(key, next);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Remembers what left a thread's background-work list, so the drawer can keep
 * it until the turn after it was read. Fed only settled snapshots: while a run
 * is active the list is empty by design, which is not an ending.
 */
export function useBackgroundWorkHistory(input: {
  readonly key: string | null;
  readonly running: ReadonlyArray<BackgroundWorkEntry>;
  readonly latestRunId: string | null;
  readonly settled: boolean;
}): {
  readonly finished: ReadonlyArray<FinishedBackgroundWorkEntry>;
  readonly markRead: () => void;
} {
  const { key, running, latestRunId, settled } = input;
  const history = useSyncExternalStore(subscribe, () =>
    key === null ? undefined : histories.get(key),
  );
  useEffect(() => {
    if (key === null || !settled) return;
    setHistory(
      key,
      nextBackgroundWorkHistory(histories.get(key), {
        running,
        latestRunId,
        nowIso: new Date().toISOString(),
      }),
    );
  }, [key, latestRunId, running, settled]);
  const markRead = useCallback(() => {
    if (key === null) return;
    const current = histories.get(key);
    if (current !== undefined) setHistory(key, markBackgroundWorkRead(current, latestRunId));
  }, [key, latestRunId]);
  return { finished: history?.finished ?? NO_FINISHED, markRead };
}

/** The strip's disclosure: the row stays a status, so the toggle is its own control. */
export function BackgroundWorkDrawerToggle({
  expanded,
  onToggle,
}: {
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-expanded={expanded}
      aria-label={expanded ? "Hide background work" : "Show background work"}
      data-background-work-toggle="true"
      onClick={onToggle}
    >
      <ChevronDownIcon className={cn("size-3.5", !expanded && "rotate-180")} />
    </Button>
  );
}

/** The end of a Claude task's output file, refreshed while the task runs. */
function BackgroundTaskOutput({
  environmentId,
  threadId,
  taskId,
  live,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly taskId: string;
  readonly live: boolean;
}) {
  const query = useEnvironmentQuery(
    orchestrationEnvironment.backgroundTaskOutput({
      environmentId,
      input: { threadId, taskId },
    }),
  );
  const { refresh } = query;
  useEffect(() => {
    if (!live) return;
    const id = setInterval(refresh, OUTPUT_REFRESH_MS);
    return () => clearInterval(id);
  }, [live, refresh]);

  const preRef = useRef<HTMLPreElement>(null);
  const followRef = useRef(true);
  const contents = query.data?.contents ?? "";
  // Follow the end like a terminal unless the reader scrolled up.
  useLayoutEffect(() => {
    const pre = preRef.current;
    if (pre && followRef.current && contents.length > 0) pre.scrollTop = pre.scrollHeight;
  }, [contents]);

  let note: string | null = null;
  if (query.error !== null && query.data === null) note = query.error;
  else if (query.data === null) note = "Loading output…";
  else if (!query.data.found)
    note = "No output file: not started, cleaned up, or on another machine.";
  else if (contents.trim().length === 0) note = "No output yet.";
  else if (query.data.truncated) note = "The last 64 KB.";

  return (
    <div className="flex min-w-0 flex-col gap-1" data-background-task-output="true">
      {query.data?.found && contents.trim().length > 0 ? (
        <pre
          ref={preRef}
          onScroll={(event) => {
            const pre = event.currentTarget;
            followRef.current = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 8;
          }}
          className="max-h-56 overflow-auto rounded-md bg-muted/60 px-2 py-1.5 font-mono text-2xs/4 whitespace-pre-wrap break-all text-foreground/85"
        >
          {contents}
        </pre>
      ) : null}
      {note === null ? null : <span className="text-2xs text-muted-foreground">{note}</span>}
    </div>
  );
}

function BackgroundWorkRow({
  entry,
  finished,
  environmentId,
  threadId,
  outputOpen,
  onToggleOutput,
  onOpenThread,
}: {
  readonly entry: BackgroundWorkEntry;
  readonly finished: boolean;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly outputOpen: boolean;
  readonly onToggleOutput: (taskId: string) => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const statusRef = useRef<HTMLSpanElement>(null);
  // Ticks through DOM writes, as the subagent bar does, so the chat view
  // never re-renders for a timer.
  useLayoutEffect(() => {
    const update = () => {
      if (statusRef.current) {
        statusRef.current.textContent = finished
          ? `${entry.kindLabel} · finished`
          : formatPendingBackgroundWorkStatus(entry, Date.now());
      }
    };
    update();
    if (finished) return;
    const id = setInterval(update, 1_000);
    return () => clearInterval(id);
  }, [entry, finished]);

  const childThreadId = entry.childThreadId;
  return (
    <ComposerBanner.Row
      render={<li />}
      className="items-start py-1 pe-2"
      data-background-work-row={finished ? "finished" : "running"}
    >
      <ComposerBanner.Icon className={cn("h-6", finished ? "text-success" : "text-primary")}>
        {finished ? <CheckIcon /> : <CircleDotIcon />}
      </ComposerBanner.Icon>
      <ComposerBanner.Content className="min-h-6 flex-wrap gap-x-2 gap-y-0">
        {childThreadId === undefined ? (
          <span
            className={cn(
              "min-w-0 truncate font-medium",
              finished ? "text-muted-foreground" : "text-foreground/90",
            )}
          >
            {entry.label}
          </span>
        ) : (
          <InlineButton
            aria-label={`Open subagent ${entry.label}`}
            onClick={() => onOpenThread(childThreadId)}
          >
            {entry.label}
          </InlineButton>
        )}
        <span ref={statusRef} className="shrink-0 text-muted-foreground tabular-nums" />
      </ComposerBanner.Content>
      {entry.hasOutput ? (
        <ComposerBanner.Actions>
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={outputOpen}
            onClick={() => onToggleOutput(entry.taskId)}
          >
            Output
            <ChevronDownIcon className={cn("size-3", !outputOpen && "-rotate-90")} />
          </Button>
        </ComposerBanner.Actions>
      ) : null}
      {entry.command !== undefined || outputOpen ? (
        <div className="col-[2/4] row-start-2 flex min-w-0 flex-col gap-1 pb-1">
          {entry.command === undefined ? null : (
            <code className="line-clamp-2 font-mono text-2xs/4 break-all whitespace-pre-wrap text-muted-foreground">
              {entry.command}
            </code>
          )}
          {outputOpen ? (
            <BackgroundTaskOutput
              environmentId={environmentId}
              threadId={threadId}
              taskId={entry.taskId}
              live={!finished}
            />
          ) : null}
        </div>
      ) : null}
    </ComposerBanner.Row>
  );
}

/**
 * The background-work strip's drawer: what runs, for how long, and on click
 * the live end of a command's or monitor's output; finished work below it.
 */
export function BackgroundWorkDrawer({
  environmentId,
  threadId,
  running,
  finished,
  onOpenThread,
  onRead,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly running: ReadonlyArray<BackgroundWorkEntry>;
  readonly finished: ReadonlyArray<FinishedBackgroundWorkEntry>;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onRead: () => void;
}) {
  // Seeing is reading: finished rows count as read once they have been on
  // screen, not merely mounted (a drawer behind another notice is unseen).
  const rowsRef = useRef<HTMLDivElement>(null);
  const hasUnread = finished.some((entry) => !entry.read);
  useEffect(() => {
    const element = rowsRef.current;
    if (!hasUnread || element === null || typeof IntersectionObserver === "undefined") return;
    const reader = createReadWhenShown({
      delayMs: READ_AFTER_SHOWN_MS,
      isShown: () => isElementShown(element),
      onRead,
      setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) reader.intersect(entry.isIntersecting);
      },
      { threshold: [0, 0.5, 1] },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      reader.dispose();
    };
  }, [hasUnread, onRead]);
  const [openOutputIds, setOpenOutputIds] = useState<ReadonlySet<string>>(() => new Set());
  const toggleOutput = useCallback((taskId: string) => {
    setOpenOutputIds((current) => {
      const next = new Set(current);
      if (!next.delete(taskId)) next.add(taskId);
      return next;
    });
  }, []);

  const rows = (entries: ReadonlyArray<BackgroundWorkEntry>, isFinished: boolean) =>
    entries.map((entry) => (
      <BackgroundWorkRow
        key={`${isFinished ? "finished" : "running"}:${entry.taskId}`}
        entry={entry}
        finished={isFinished}
        environmentId={environmentId}
        threadId={threadId}
        outputOpen={openOutputIds.has(entry.taskId)}
        onToggleOutput={toggleOutput}
        onOpenThread={onOpenThread}
      />
    ));

  return (
    <ComposerBanner.Scroll className="max-h-[min(28rem,50dvh)]" data-background-work-drawer="true">
      <div ref={rowsRef}>
        <ComposerBanner.Children render={<ul role="list" />} aria-label="Background work">
          {rows(running, false)}
          {rows(finished, true)}
        </ComposerBanner.Children>
      </div>
    </ComposerBanner.Scroll>
  );
}
