import { Minimize2Icon, TimerIcon } from "lucide-react";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";

import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  deriveStatusLine,
  describeStatusLine,
  promptCacheTtlMs,
  type StatusLineContext,
  type StatusLineModel,
} from "./ComposerStatusLine.logic";

const TICK_MS = 1_000;
const RING_RADIUS = 9.75;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** The legacy context meter's ring, small enough to sit in the footer row. */
function ContextRing({ ratio, overloaded }: { ratio: number; overloaded: boolean }) {
  const clamped = Math.max(0, Math.min(100, ratio));
  return (
    <svg viewBox="0 0 24 24" className="size-3.5 shrink-0 -rotate-90" aria-hidden="true">
      <circle
        cx="12"
        cy="12"
        r={RING_RADIUS}
        fill="none"
        className="stroke-muted-foreground/24"
        strokeWidth="3"
      />
      <circle
        cx="12"
        cy="12"
        r={RING_RADIUS}
        fill="none"
        stroke={
          overloaded
            ? "var(--color-error)"
            : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)"
        }
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={RING_CIRCUMFERENCE}
        strokeDashoffset={RING_CIRCUMFERENCE * (1 - clamped / 100)}
      />
    </svg>
  );
}

function cacheText(cache: NonNullable<StatusLineModel["cache"]>): string {
  switch (cache.state) {
    case "live":
      return "live";
    case "warm":
      return cache.remaining;
    case "expired":
      return "expired";
  }
}

function contextText(context: StatusLineContext): string {
  return context.percent ?? context.used;
}

function Widget(props: { tooltip: string; className?: string | undefined; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className={cn("flex items-center gap-1 whitespace-nowrap", props.className)} />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.tooltip}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Context, prompt-cache timer and compaction count of the open thread, as one
 * run of small widgets in the composer's footer row. A widget the provider
 * cannot fill is left out; the row hides on a narrow composer, where the
 * controls beside it need the room.
 */
export const ComposerStatusLine = memo(function ComposerStatusLine(props: {
  enabled: boolean;
  driverKind: string | null | undefined;
  contextWindow: ContextWindowSnapshot | null;
  compactionCount: number;
  turnRunning: boolean;
  lastTurnCompletedAtMs: number | null;
}) {
  const {
    enabled,
    driverKind,
    contextWindow,
    compactionCount,
    turnRunning,
    lastTurnCompletedAtMs,
  } = props;
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Only a warm cache changes by itself. The tick that crosses the expiry
  // renders "expired" and stops the clock; a later turn restarts it.
  const ttlMs = promptCacheTtlMs(driverKind);
  const countingDown =
    enabled &&
    ttlMs !== null &&
    !turnRunning &&
    lastTurnCompletedAtMs !== null &&
    nowMs < lastTurnCompletedAtMs + ttlMs;
  useEffect(() => {
    if (!countingDown) return;
    const id = setInterval(() => setNowMs(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [countingDown]);

  const line = useMemo(
    () =>
      deriveStatusLine({
        enabled,
        driverKind,
        contextWindow,
        compactionCount,
        turnRunning,
        lastTurnCompletedAtMs,
        nowMs,
      }),
    [
      enabled,
      driverKind,
      contextWindow,
      compactionCount,
      turnRunning,
      lastTurnCompletedAtMs,
      nowMs,
    ],
  );
  if (line === null) return null;

  const { context, cache, compactions } = line;
  const tooltips = describeStatusLine(line);
  return (
    <div
      data-composer-status-line="true"
      className="flex shrink-0 items-center gap-2.5 text-xs text-muted-foreground tabular-nums @max-[560px]/composer-surface:hidden"
    >
      {context !== null && tooltips.context !== null ? (
        <Widget
          tooltip={tooltips.context}
          className={context.overloaded ? "text-destructive" : undefined}
        >
          {context.ratio !== null ? (
            <ContextRing ratio={context.ratio} overloaded={context.overloaded} />
          ) : null}
          {contextText(context)}
        </Widget>
      ) : null}
      {cache !== null && tooltips.cache !== null ? (
        <Widget
          tooltip={tooltips.cache}
          className={cache.state === "expired" ? "text-muted-foreground/60" : undefined}
        >
          <TimerIcon className="size-3.5 shrink-0" aria-hidden="true" />
          {cacheText(cache)}
        </Widget>
      ) : null}
      {compactions !== null && tooltips.compactions !== null ? (
        <Widget tooltip={tooltips.compactions}>
          <Minimize2Icon className="size-3.5 shrink-0" aria-hidden="true" />
          {compactions}
        </Widget>
      ) : null}
    </div>
  );
});
