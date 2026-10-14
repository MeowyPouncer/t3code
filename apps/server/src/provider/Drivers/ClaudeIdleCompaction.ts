// FORK: whether T3 compacts a Claude instance's idle threads (IdleCompactionWorker).
import {
  DEFAULT_CLAUDE_IDLE_COMPACTION_MIN_TOKENS,
  type ClaudeSettings,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import type { ProviderIdleCompaction } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** Near a usage limit, what is left goes to the agents' own work, as Claude Code does. */
const NEAR_LIMIT_PERCENT = 90;

export function claudeIdleCompaction(input: {
  readonly config: Pick<ClaudeSettings, "idleCompaction" | "idleCompactionMinTokens">;
  /** `idleCompaction` in the instance's Claude settings.json; false turns Claude Code's own off. */
  readonly claudeSetting: unknown;
  readonly usageLimits: ServerProviderUsageLimits | undefined;
  readonly nowMs: number;
}): ProviderIdleCompaction | null {
  if (!input.config.idleCompaction || input.claudeSetting === false) return null;
  const nearLimit = (input.usageLimits?.windows ?? []).some(
    (window) =>
      window.usedPercent >= NEAR_LIMIT_PERCENT &&
      (window.resetsAt === undefined || Date.parse(window.resetsAt) > input.nowMs),
  );
  if (nearLimit) return null;
  const minTokens = input.config.idleCompactionMinTokens;
  return {
    minTokens: minTokens.length > 0 ? Number(minTokens) : DEFAULT_CLAUDE_IDLE_COMPACTION_MIN_TOKENS,
  };
}

const decodeClaudeUserSettings = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ idleCompaction: Schema.optional(Schema.Unknown) })),
);

/** `idleCompaction` from `<configDir>/settings.json`; undefined when unset or unreadable. */
export const readClaudeIdleCompactionSetting = (configDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const text = yield* fs.readFileString(path.join(configDir, "settings.json"));
    return (yield* decodeClaudeUserSettings(text)).idleCompaction;
  }).pipe(Effect.orElseSucceed(() => undefined));
