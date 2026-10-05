import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { ContextWindowSnapshot } from "~/lib/contextWindow";

/**
 * Prompt-cache lifetime after a provider's last request. Only Claude is listed:
 * its SDK reports every cache write as `ephemeral_1h_input_tokens` here, never
 * `ephemeral_5m_*`. Other providers' caches are not something a client can time.
 */
const PROMPT_CACHE_TTL_MS: Readonly<Record<string, number>> = {
  claudeAgent: 60 * 60 * 1000,
};

const CONTEXT_BAR_CELLS = 10;

export type StatusLineContext = {
  readonly bar: string | null;
  readonly used: string;
  readonly max: string | null;
  readonly percent: string | null;
  readonly overloaded: boolean;
};

export type StatusLineCache =
  | { readonly state: "live" }
  | { readonly state: "warm"; readonly remaining: string; readonly remainingMs: number }
  | { readonly state: "expired" };

export type StatusLineModel = {
  readonly context: StatusLineContext | null;
  readonly cache: StatusLineCache | null;
  readonly compactions: number | null;
};

export function formatStatusLineTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1_000) return `${Math.round(value)}`;
  if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function formatStatusLinePercent(value: number): string {
  const clamped = Math.max(0, Math.min(100, value));
  return clamped < 10 ? `${clamped.toFixed(1).replace(/\.0$/, "")}%` : `${Math.round(clamped)}%`;
}

export function formatContextBar(percent: number): string {
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * CONTEXT_BAR_CELLS);
  return "█".repeat(filled) + "░".repeat(CONTEXT_BAR_CELLS - filled);
}

/** `59:54`; minutes run to 60 because the longest lifetime is one hour. */
export function formatCacheRemaining(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function promptCacheTtlMs(driverKind: string | null | undefined): number | null {
  return (driverKind != null ? PROMPT_CACHE_TTL_MS[driverKind] : undefined) ?? null;
}

function deriveContext(usage: ContextWindowSnapshot | null): StatusLineContext | null {
  if (usage === null || !Number.isFinite(usage.usedTokens)) return null;
  const reportedMax = usage.maxTokens ?? null;
  const maxTokens = reportedMax !== null && reportedMax > 0 ? reportedMax : null;
  const percent = maxTokens === null ? null : Math.min(100, (usage.usedTokens / maxTokens) * 100);
  return {
    bar: percent === null ? null : formatContextBar(percent),
    used: formatStatusLineTokens(usage.usedTokens),
    max: maxTokens === null ? null : formatStatusLineTokens(maxTokens),
    percent: percent === null ? null : formatStatusLinePercent(percent),
    overloaded: percent !== null && percent > 90,
  };
}

function deriveCache(input: {
  readonly driverKind: string | null | undefined;
  readonly turnRunning: boolean;
  readonly lastTurnCompletedAtMs: number | null;
  readonly nowMs: number;
}): StatusLineCache | null {
  const ttlMs = promptCacheTtlMs(input.driverKind);
  if (ttlMs === null) return null;
  // Every request of a running turn rewrites the cache.
  if (input.turnRunning) return { state: "live" };
  if (input.lastTurnCompletedAtMs === null) return null;
  const remainingMs = input.lastTurnCompletedAtMs + ttlMs - input.nowMs;
  // A clock last read before the turn ended can run ahead of the lifetime for one tick.
  return remainingMs > 0
    ? {
        state: "warm",
        remaining: formatCacheRemaining(Math.min(remainingMs, ttlMs)),
        remainingMs: Math.min(remainingMs, ttlMs),
      }
    : { state: "expired" };
}

/**
 * What the status line shows. A widget the provider cannot fill is `null` and
 * is hidden; a line with no widget left is `null` too. Compactions show only
 * once there is one.
 */
export function deriveStatusLine(input: {
  readonly enabled: boolean;
  readonly driverKind: string | null | undefined;
  readonly contextWindow: ContextWindowSnapshot | null;
  readonly compactionCount: number;
  readonly turnRunning: boolean;
  readonly lastTurnCompletedAtMs: number | null;
  readonly nowMs: number;
}): StatusLineModel | null {
  if (!input.enabled) return null;
  const context = deriveContext(input.contextWindow);
  const cache = deriveCache(input);
  const compactions = input.compactionCount > 0 ? input.compactionCount : null;
  return context === null && cache === null && compactions === null
    ? null
    : { context, cache, compactions };
}

/** The snapshot's whole-thread total, else the compactions in the loaded items. */
export function resolveCompactionCount(
  projection: Pick<OrchestrationV2ThreadProjection, "compactionCount" | "turnItems"> | null,
): number {
  if (projection === null) return 0;
  if (projection.compactionCount !== undefined) return projection.compactionCount;
  return projection.turnItems.filter(
    (item) => item.type === "compaction" && item.status === "completed",
  ).length;
}

/** When the active provider thread's newest turn ended, in epoch milliseconds. */
export function latestProviderTurnCompletedAtMs(
  providerTurns: ReadonlyArray<
    Pick<OrchestrationV2ProviderTurn, "providerThreadId" | "completedAt">
  >,
  activeProviderThreadId: OrchestrationV2ProviderTurn["providerThreadId"] | null,
): number | null {
  let latest: number | null = null;
  for (const turn of providerTurns) {
    if (turn.completedAt === null) continue;
    if (activeProviderThreadId !== null && turn.providerThreadId !== activeProviderThreadId) {
      continue;
    }
    const completedAtMs = DateTime.toEpochMillis(turn.completedAt);
    if (latest === null || completedAtMs > latest) latest = completedAtMs;
  }
  return latest;
}
