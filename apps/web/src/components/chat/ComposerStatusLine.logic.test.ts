import { ProviderThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { ContextWindowSnapshot } from "~/lib/contextWindow";
import {
  deriveStatusLine,
  describeStatusLine,
  formatCacheRemaining,
  formatStatusLinePercent,
  formatStatusLineTokens,
  latestProviderTurnCompletedAtMs,
  promptCacheTtlMs,
  resolveCompactionCount,
} from "./ComposerStatusLine.logic";

const HOUR_MS = 60 * 60 * 1000;
const NOW_MS = Date.parse("2026-10-05T12:00:00.000Z");

function usage(usedTokens: number, maxTokens: number | null): ContextWindowSnapshot {
  return {
    usedTokens,
    maxTokens,
    usedPercentage: maxTokens === null ? null : (usedTokens / maxTokens) * 100,
  } as ContextWindowSnapshot;
}

function line(overrides: Partial<Parameters<typeof deriveStatusLine>[0]> = {}) {
  return deriveStatusLine({
    enabled: true,
    driverKind: "claudeAgent",
    contextWindow: usage(422_000, 1_000_000),
    compactionCount: 0,
    turnRunning: false,
    lastTurnCompletedAtMs: NOW_MS - 6_000,
    nowMs: NOW_MS,
    ...overrides,
  });
}

describe("status line formatting", () => {
  it("shortens token counts the way the approved layout reads", () => {
    expect(formatStatusLineTokens(0)).toBe("0");
    expect(formatStatusLineTokens(950)).toBe("950");
    expect(formatStatusLineTokens(6_100)).toBe("6.1k");
    expect(formatStatusLineTokens(422_000)).toBe("422k");
    expect(formatStatusLineTokens(1_000_000)).toBe("1.0M");
    expect(formatStatusLineTokens(1_250_000)).toBe("1.3M");
    expect(formatStatusLineTokens(Number.NaN)).toBe("0");
  });

  it("rounds percentages, keeping a decimal below ten", () => {
    expect(formatStatusLinePercent(42.4)).toBe("42%");
    expect(formatStatusLinePercent(3.46)).toBe("3.5%");
    expect(formatStatusLinePercent(0)).toBe("0%");
    expect(formatStatusLinePercent(140)).toBe("100%");
  });

  it("counts the cache down in minutes and seconds", () => {
    expect(formatCacheRemaining(HOUR_MS)).toBe("60:00");
    expect(formatCacheRemaining(HOUR_MS - 6_000)).toBe("59:54");
    expect(formatCacheRemaining(59_001)).toBe("1:00");
    expect(formatCacheRemaining(1)).toBe("0:01");
    expect(formatCacheRemaining(-5)).toBe("0:00");
  });
});

describe("deriveStatusLine", () => {
  it("fills all three widgets for a Claude thread", () => {
    expect(line({ compactionCount: 1 })).toEqual({
      context: {
        ratio: expect.closeTo(42.2, 5),
        used: "422k",
        max: "1.0M",
        percent: "42%",
        overloaded: false,
      },
      cache: { state: "warm", remaining: "59:54", remainingMs: HOUR_MS - 6_000 },
      compactions: 1,
    });
  });

  it("is hidden when the setting is off", () => {
    expect(line({ enabled: false, compactionCount: 3 })).toBeNull();
  });

  it("hides the cache for a provider whose cache lifetime is unknown", () => {
    expect(line({ driverKind: "codex" })?.cache).toBeNull();
    expect(line({ driverKind: "cursor" })?.cache).toBeNull();
    expect(line({ driverKind: null })?.cache).toBeNull();
    expect(promptCacheTtlMs("claudeAgent")).toBe(HOUR_MS);
    expect(promptCacheTtlMs("antigravity")).toBeNull();
  });

  it("hides the context when the provider reports no usage, and the bar when it reports no window", () => {
    expect(line({ contextWindow: null })?.context).toBeNull();
    expect(line({ contextWindow: usage(80_000, null) })?.context).toEqual({
      ratio: null,
      used: "80k",
      max: null,
      percent: null,
      overloaded: false,
    });
  });

  it("marks a context window above ninety percent", () => {
    expect(line({ contextWindow: usage(910_000, 1_000_000) })?.context?.overloaded).toBe(true);
    expect(line({ contextWindow: usage(900_000, 1_000_000) })?.context?.overloaded).toBe(false);
  });

  it("shows the cache as live during a turn and expired an hour after the last one", () => {
    expect(line({ turnRunning: true, lastTurnCompletedAtMs: null })?.cache).toEqual({
      state: "live",
    });
    expect(line({ lastTurnCompletedAtMs: NOW_MS - HOUR_MS })?.cache).toEqual({ state: "expired" });
    expect(line({ lastTurnCompletedAtMs: NOW_MS - HOUR_MS + 1_000 })?.cache?.state).toBe("warm");
  });

  it("never reads a countdown above the lifetime when the clock is stale", () => {
    expect(line({ lastTurnCompletedAtMs: NOW_MS + 15 * 60_000 })?.cache).toEqual({
      state: "warm",
      remaining: "60:00",
      remainingMs: HOUR_MS,
    });
  });

  it("hides the cache before any turn has finished", () => {
    expect(line({ lastTurnCompletedAtMs: null })?.cache).toBeNull();
  });

  it("shows compactions only once there is one", () => {
    expect(line({ compactionCount: 0 })?.compactions).toBeNull();
    expect(line({ compactionCount: 7 })?.compactions).toBe(7);
  });

  it("hides the whole line when no widget can be filled", () => {
    expect(
      line({ driverKind: "codex", contextWindow: null, lastTurnCompletedAtMs: null }),
    ).toBeNull();
  });
});

describe("resolveCompactionCount", () => {
  const items = [
    { type: "compaction", status: "completed" },
    { type: "compaction", status: "running" },
    { type: "command_execution", status: "completed" },
  ] as never;

  it("prefers the snapshot's whole-thread total", () => {
    expect(resolveCompactionCount({ compactionCount: 4, turnItems: items })).toBe(4);
  });

  it("falls back to the completed compactions among the loaded items", () => {
    expect(resolveCompactionCount({ turnItems: items })).toBe(1);
    expect(resolveCompactionCount(null)).toBe(0);
  });
});

describe("latestProviderTurnCompletedAtMs", () => {
  const first = ProviderThreadId.make("provider-thread-1");
  const second = ProviderThreadId.make("provider-thread-2");
  const at = (iso: string) => DateTime.makeUnsafe(iso);

  it("takes the newest finished turn of the active provider thread", () => {
    const turns = [
      { providerThreadId: first, completedAt: at("2026-10-05T10:00:00.000Z") },
      { providerThreadId: first, completedAt: at("2026-10-05T11:00:00.000Z") },
      { providerThreadId: first, completedAt: null },
      { providerThreadId: second, completedAt: at("2026-10-05T11:30:00.000Z") },
    ];
    expect(latestProviderTurnCompletedAtMs(turns, first)).toBe(Date.parse("2026-10-05T11:00:00Z"));
    expect(latestProviderTurnCompletedAtMs(turns, null)).toBe(Date.parse("2026-10-05T11:30:00Z"));
  });

  it("is null while no turn has finished", () => {
    expect(
      latestProviderTurnCompletedAtMs([{ providerThreadId: first, completedAt: null }], first),
    ).toBeNull();
    expect(latestProviderTurnCompletedAtMs([], first)).toBeNull();
  });
});

describe("describeStatusLine", () => {
  it("spells each widget out for its tooltip", () => {
    const text = describeStatusLine(line({ compactionCount: 1 })!);
    expect(text.context).toBe("Context window: 422k of 1.0M tokens used (42%)");
    expect(text.cache).toContain("59:54 left");
    expect(text.compactions).toBe("1 compaction in this thread");
    expect(describeStatusLine(line({ compactionCount: 6 })!).compactions).toBe(
      "6 compactions in this thread",
    );
  });

  it("explains a live and an expired cache, and a context with no window", () => {
    expect(describeStatusLine(line({ turnRunning: true })!).cache).toContain("every request");
    expect(describeStatusLine(line({ lastTurnCompletedAtMs: NOW_MS - HOUR_MS })!).cache).toContain(
      "expired",
    );
    expect(describeStatusLine(line({ contextWindow: usage(80_000, null) })!).context).toBe(
      "Context window: 80k tokens used",
    );
    expect(
      describeStatusLine(line({ driverKind: "codex", contextWindow: null, compactionCount: 2 })!),
    ).toEqual({ context: null, cache: null, compactions: "2 compactions in this thread" });
  });
});
