import { memo, useEffect, useMemo, useState } from "react";

import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import { cn } from "~/lib/utils";
import {
  deriveStatusLine,
  promptCacheTtlMs,
  type StatusLineModel,
} from "./ComposerStatusLine.logic";

const TICK_MS = 1_000;

function cacheText(cache: NonNullable<StatusLineModel["cache"]>): string {
  switch (cache.state) {
    case "live":
      return "cache live";
    case "warm":
      return `cache ${cache.remaining}`;
    case "expired":
      return "cache expired";
  }
}

/**
 * Under the composer: context bar, prompt-cache timer and compaction count of
 * the open thread, mirroring the matching ccstatusline widgets. Widgets the
 * provider cannot fill are left out.
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
  const widgets: Array<{ key: string; className?: string; text: string }> = [];
  if (context !== null) {
    widgets.push({
      key: "context",
      ...(context.overloaded ? { className: "text-destructive" } : {}),
      text: [
        context.bar,
        context.max !== null ? `${context.used}/${context.max}` : context.used,
        context.percent,
      ]
        .filter((part) => part !== null)
        .join(" "),
    });
  }
  if (cache !== null) {
    widgets.push({
      key: "cache",
      ...(cache.state === "expired" ? { className: "text-muted-foreground/60" } : {}),
      text: cacheText(cache),
    });
  }
  if (compactions !== null) {
    widgets.push({ key: "compactions", text: `↻ ${compactions}` });
  }

  return (
    <div
      data-composer-status-line="true"
      className="flex min-w-0 flex-wrap items-center gap-x-2 px-4 pt-1.5 text-2xs leading-4 text-muted-foreground tabular-nums sm:px-5"
    >
      {widgets.map((widget, index) => (
        <span key={widget.key} className="flex items-center gap-x-2">
          {index > 0 ? (
            <span aria-hidden="true" className="text-muted-foreground/40">
              ·
            </span>
          ) : null}
          <span className={cn("whitespace-nowrap", widget.className)}>{widget.text}</span>
        </span>
      ))}
    </div>
  );
});
