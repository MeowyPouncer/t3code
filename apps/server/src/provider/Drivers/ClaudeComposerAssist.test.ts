import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  claudeNearUsageLimit,
  makeClaudeComposerAssist,
  readClaudeComposerAssistLine,
} from "./ClaudeComposerAssist.ts";

// A stand-in for `claude -p --input-format stream-json`: it logs each start and its arguments,
// then answers the one user message it reads, the way FAKE_CLAUDE_MODE says.
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\\n");
  buffer = lines.pop();
  for (const line of lines) {
    const message = JSON.parse(line);
    const text = message.message.content[0].text;
    const mode = process.env.FAKE_CLAUDE_MODE;
    if (mode === "silent") {
      process.stderr.write("Not logged in");
      process.exit(1);
    }
    process.stdout.write(JSON.stringify({ type: "system", subtype: "init" }) + "\\n");
    process.stdout.write(
      JSON.stringify(
        mode === "error"
          ? { type: "result", subtype: "error_during_execution", is_error: true, result: "Usage limit reached" }
          : { type: "result", subtype: "success", is_error: false, result: "echo:" + text },
      ) + "\\n",
    );
  }
});
process.stdin.on("end", () => process.exit(0));
`;

const setup = (mode: "echo" | "silent" | "error") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fake-claude-" });
    const binaryPath = path.join(dir, "claude");
    const log = path.join(dir, "starts.log");
    yield* fs.writeFileString(binaryPath, FAKE_CLAUDE);
    yield* fs.chmod(binaryPath, 0o755);
    const assist = yield* makeClaudeComposerAssist({
      binaryPath,
      environment: { ...process.env, FAKE_CLAUDE_LOG: log, FAKE_CLAUDE_MODE: mode },
      usageLimits: Effect.succeed(undefined),
    });
    const starts = fs.readFileString(log).pipe(
      Effect.map((text) =>
        text
          .trim()
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as ReadonlyArray<string>),
      ),
    );
    return { assist, starts };
  }).pipe(Effect.provide(NodeServices.layer));

describe("ClaudeComposerAssist", () => {
  it.live("answers each task from its own Claude process", () =>
    Effect.gen(function* () {
      const { assist, starts } = yield* setup("echo");
      const first = yield* assist.complete({ system: "SYS", task: "one", timeoutMs: 15_000 });
      assert.equal(first, "echo:one");
      const second = yield* assist.complete({ system: "SYS", task: "two", timeoutMs: 15_000 });
      assert.equal(second, "echo:two");
      const argv = (yield* starts)[0] ?? [];
      assert.include(argv, "--safe-mode");
      assert.include(argv, "--no-session-persistence");
      assert.equal(argv[argv.indexOf("--system-prompt") + 1], "SYS");
      assert.equal(argv[argv.indexOf("--tools") + 1], "");
      assert.equal(argv[argv.indexOf("--model") + 1], "haiku");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reports why Claude gave no answer", () =>
    Effect.gen(function* () {
      const silent = yield* setup("silent");
      const exit = yield* silent.assist
        .complete({ system: "SYS", task: "one", timeoutMs: 15_000 })
        .pipe(Effect.flip);
      assert.include(exit.detail, "Not logged in");
      const failing = yield* setup("error");
      const error = yield* failing.assist
        .complete({ system: "SYS", task: "one", timeoutMs: 15_000 })
        .pipe(Effect.flip);
      assert.equal(error.detail, "Usage limit reached");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("reads only result lines", () => {
    assert.isUndefined(readClaudeComposerAssistLine('{"type":"system"}'));
    assert.isUndefined(readClaudeComposerAssistLine("not json"));
    assert.deepEqual(
      readClaudeComposerAssistLine('{"type":"result","subtype":"success","result":"hi"}'),
      { ok: true, text: "hi" },
    );
    assert.deepEqual(
      readClaudeComposerAssistLine('{"type":"result","subtype":"error_max_turns"}'),
      {
        ok: false,
        detail: "Claude stopped (error_max_turns).",
      },
    );
  });

  it("holds background work near a usage limit until the window resets", () => {
    const window = (usedPercent: number, resetsAt?: string) => ({
      usageLimits: {
        windows: [
          { id: "five_hour", usedPercent, ...(resetsAt === undefined ? {} : { resetsAt }) },
        ],
      } as never,
    });
    assert.isTrue(claudeNearUsageLimit(window(92).usageLimits, 0));
    assert.isFalse(claudeNearUsageLimit(window(60).usageLimits, 0));
    assert.isFalse(claudeNearUsageLimit(window(95, "1970-01-01T00:00:01.000Z").usageLimits, 5_000));
    assert.isFalse(claudeNearUsageLimit(undefined, 0));
  });
});
