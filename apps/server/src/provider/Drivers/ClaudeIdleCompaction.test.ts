import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { claudeIdleCompaction, readClaudeIdleCompactionSetting } from "./ClaudeIdleCompaction.ts";

const config = { idleCompaction: true, idleCompactionMinTokens: "" };
const window = (usedPercent: number, resetsAtMs?: number) => ({
  id: "five_hour",
  kind: "session" as const,
  label: "Session",
  usedPercent,
  ...(resetsAtMs === undefined
    ? {}
    : { resetsAt: DateTime.formatIso(DateTime.makeUnsafe(resetsAtMs)) }),
});
const limits = (...windows: ReadonlyArray<ReturnType<typeof window>>) => ({
  checkedAt: DateTime.formatIso(DateTime.makeUnsafe(0)),
  windows,
});
const policy = (input: Partial<Parameters<typeof claudeIdleCompaction>[0]>) =>
  claudeIdleCompaction({
    config,
    claudeSetting: undefined,
    usageLimits: undefined,
    nowMs: 1_000,
    ...input,
  });

describe("claudeIdleCompaction", () => {
  it("compacts from 200K tokens unless the instance sets its own threshold", () => {
    assert.deepEqual(policy({}), { minTokens: 200_000 });
    assert.deepEqual(policy({ config: { ...config, idleCompactionMinTokens: "300000" } }), {
      minTokens: 300_000,
    });
  });

  it("is off when the instance or Claude's own settings turn it off", () => {
    assert.isNull(policy({ config: { ...config, idleCompaction: false } }));
    assert.isNull(policy({ claudeSetting: false }));
    assert.deepEqual(policy({ claudeSetting: true }), { minTokens: 200_000 });
  });

  it("waits while a usage window is nearly spent", () => {
    assert.isNull(policy({ usageLimits: limits(window(40), window(92, 5_000)) }));
    assert.deepEqual(policy({ usageLimits: limits(window(89)) }), { minTokens: 200_000 });
    // A window that has already reset no longer counts.
    assert.deepEqual(policy({ usageLimits: limits(window(97, 500)) }), { minTokens: 200_000 });
  });
});

describe("readClaudeIdleCompactionSetting", () => {
  it.effect("reads idleCompaction from the Claude home's settings.json", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-home-" });
      assert.isUndefined(yield* readClaudeIdleCompactionSetting(dir));
      yield* fs.writeFileString(path.join(dir, "settings.json"), '{"idleCompaction": false}');
      assert.isFalse(yield* readClaudeIdleCompactionSetting(dir));
      yield* fs.writeFileString(path.join(dir, "settings.json"), "{ not json");
      assert.isUndefined(yield* readClaudeIdleCompactionSetting(dir));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
