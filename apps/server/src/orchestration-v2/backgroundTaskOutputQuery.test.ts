// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterAll, assert, describe, it } from "vite-plus/test";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

import {
  claudeSessionIdsForThread,
  claudeTaskOutputRoot,
  cleanBackgroundTaskOutput,
  isPlainBackgroundTaskId,
  maskBackgroundTaskOutput,
  readBackgroundTaskOutput,
} from "./backgroundTaskOutputQuery.ts";

const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bg-task-output-"));
const session = "c9bd5bb1-11b2-4195-8047-6aae5d5a95ca";
const tasks = NodePath.join(root, "-home-mp-project", session, "tasks");
NodeFS.mkdirSync(tasks, { recursive: true });
NodeFS.writeFileSync(NodePath.join(tasks, "bf42ubb6j.output"), "line one\nline two\n");
NodeFS.writeFileSync(
  NodePath.join(tasks, "blong0001.output"),
  `${"x".repeat(50)}\nkept tail\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456\n`,
);
const transcript = NodePath.join(root, "transcript.jsonl");
NodeFS.writeFileSync(transcript, '{"secret":"transcript"}\n');
if (symlinksSupported) {
  NodeFS.symlinkSync(transcript, NodePath.join(tasks, "a4f24b8a1ecb537d7.output"));
}

afterAll(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("background task output helpers", () => {
  it("accepts plain ids only", () => {
    assert.isTrue(isPlainBackgroundTaskId("bf42ubb6j"));
    assert.isTrue(isPlainBackgroundTaskId(session));
    assert.isFalse(isPlainBackgroundTaskId("../etc"));
    assert.isFalse(isPlainBackgroundTaskId("a/b"));
    assert.isFalse(isPlainBackgroundTaskId(""));
  });

  it("finds Claude's temp root as the CLI does", () => {
    assert.equal(claudeTaskOutputRoot({ env: {}, tmpdir: "/tmp", uid: 1000 }), "/tmp/claude-1000");
    assert.equal(
      claudeTaskOutputRoot({ env: { CLAUDE_CODE_TMPDIR: "/var/t" }, tmpdir: "/tmp", uid: 7 }),
      "/var/t/claude-7",
    );
  });

  it("names only Claude provider threads' sessions", () => {
    const ids = claudeSessionIdsForThread([
      { driver: "codex" as never, nativeThreadRef: null },
      {
        driver: "claudeAgent" as never,
        nativeThreadRef: { driver: "claudeAgent" as never, nativeId: session, strength: "strong" },
      },
      {
        driver: "claudeAgent" as never,
        nativeThreadRef: { driver: "claudeAgent" as never, nativeId: "../x", strength: "strong" },
      },
    ]);
    assert.deepEqual(ids, [session]);
  });

  it("cleans terminal codes and keeps a rewritten line's last state", () => {
    assert.equal(
      cleanBackgroundTaskOutput("\u001b[32mok\u001b[0m\r\n10%\r50%\r100%\ndone\u0007", false),
      "ok\n100%\ndone",
    );
    // A cut tail starts at its first whole line.
    assert.equal(cleanBackgroundTaskOutput("rtial\nwhole\n", true), "whole\n");
  });

  it("masks common credential shapes and leaves prose alone", () => {
    const masked = maskBackgroundTaskOutput(
      [
        "export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456",
        '{"api_key": "abc123"}',
        "Authorization: Bearer abcdefghijklmnop",
        "git clone https://user:hunter22@example.com/repo.git",
        "key sk-ant-REDACTEDREDACTEDREDACTED",
        "Basic authentication is off; max_tokens: 5; PWD=/home/mp",
      ].join("\n"),
    );
    assert.notInclude(masked, "ghp_abcdefghijklmnopqrstuvwxyz123456");
    assert.notInclude(masked, "abc123");
    assert.notInclude(masked, "abcdefghijklmnop");
    assert.notInclude(masked, "hunter22");
    assert.notInclude(masked, "sk-ant-");
    assert.include(masked, "GITHUB_TOKEN=[masked]");
    assert.include(masked, "Basic authentication is off; max_tokens: 5; PWD=/home/mp");
  });
});

describe("readBackgroundTaskOutput", () => {
  effectIt.effect("reads a task's output from the thread's session", () =>
    Effect.gen(function* () {
      const result = yield* readBackgroundTaskOutput({
        taskId: "bf42ubb6j",
        sessionIds: [session],
        root,
      });
      assert.isTrue(result.found);
      assert.equal(result.contents, "line one\nline two\n");
      assert.isFalse(result.truncated);
      assert.equal(result.sizeBytes, 18);
    }),
  );

  effectIt.effect("returns the masked tail of a long output", () =>
    Effect.gen(function* () {
      const result = yield* readBackgroundTaskOutput({
        taskId: "blong0001",
        sessionIds: [session],
        root,
        tailBytes: 65,
      });
      assert.isTrue(result.truncated);
      assert.equal(result.contents, "kept tail\nGITHUB_TOKEN=[masked]\n");
    }),
  );

  effectIt.effect("finds nothing for another session or a missing task", () =>
    Effect.gen(function* () {
      const otherSession = yield* readBackgroundTaskOutput({
        taskId: "bf42ubb6j",
        sessionIds: ["11111111-2222-3333-4444-555555555555"],
        root,
      });
      assert.isFalse(otherSession.found);
      const missing = yield* readBackgroundTaskOutput({
        taskId: "bnothere0",
        sessionIds: [session],
        root,
      });
      assert.isFalse(missing.found);
      const noRoot = yield* readBackgroundTaskOutput({
        taskId: "bf42ubb6j",
        sessionIds: [session],
        root: NodePath.join(root, "absent"),
      });
      assert.isFalse(noRoot.found);
    }),
  );

  effectIt.effect("rejects a task id that is not a plain name", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        readBackgroundTaskOutput({ taskId: "../transcript", sessionIds: [session], root }),
      );
      assert.equal(exit._tag, "Failure");
    }),
  );

  effectIt.effect.skipIf(!symlinksSupported)(
    "does not serve a subagent's symlinked transcript",
    () =>
      Effect.gen(function* () {
        const result = yield* readBackgroundTaskOutput({
          taskId: "a4f24b8a1ecb537d7",
          sessionIds: [session],
          root,
        });
        assert.isFalse(result.found);
      }),
  );
});
