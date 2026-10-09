// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { afterAll, assert, describe, it } from "vite-plus/test";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

import {
  claudeSessionIdsForThread,
  claudeTaskOutputRoot,
  cleanBackgroundTaskOutput,
  isPlainBackgroundTaskId,
  maskBackgroundTaskOutput,
  presentBackgroundTaskOutput,
  readBackgroundTaskOutput,
} from "./backgroundTaskOutputQuery.ts";

// <base>/root is Claude's temp root; <base>/outside is everything else.
const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bg-task-output-"));
const root = NodePath.join(base, "root");
const outside = NodePath.join(base, "outside");
const session = "c9bd5bb1-11b2-4195-8047-6aae5d5a95ca";
const tasks = NodePath.join(root, "-home-mp-project", session, "tasks");
NodeFS.mkdirSync(tasks, { recursive: true });
NodeFS.mkdirSync(outside, { recursive: true });
NodeFS.writeFileSync(NodePath.join(tasks, "bf42ubb6j.output"), "line one\nline two\n");
NodeFS.writeFileSync(
  NodePath.join(tasks, "blong0001.output"),
  `${"x".repeat(50)}\nkept tail\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456\n`,
);
const transcript = NodePath.join(outside, "transcript.jsonl");
NodeFS.writeFileSync(transcript, '{"secret":"transcript"}\n');
if (symlinksSupported) {
  NodeFS.symlinkSync(transcript, NodePath.join(tasks, "a4f24b8a1ecb537d7.output"));
}

/** A fresh session of its own under the root, with one task output. */
function makeSession(sessionId: string, taskId: string, contents: string, project = "-p") {
  const dir = NodePath.join(root, project, sessionId, "tasks");
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, `${taskId}.output`), contents);
  return dir;
}

/** An outside directory holding a file named like a task output. */
function makeOutsideTasks(name: string, taskId: string) {
  const dir = NodePath.join(outside, name);
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, `${taskId}.output`), "OUTSIDE SECRET\n");
  return dir;
}

function failureReason(exit: Exit.Exit<unknown, unknown>): string | undefined {
  if (Exit.isSuccess(exit)) return undefined;
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error;
  return (error as { readonly reason?: string } | undefined)?.reason;
}

afterAll(() => {
  NodeFS.rmSync(base, { recursive: true, force: true });
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
      cleanBackgroundTaskOutput("\u001b[32mok\u001b[0m\r\n10%\r50%\r100%\ndone\u0007"),
      "ok\n100%\ndone",
    );
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

describe("presentBackgroundTaskOutput", () => {
  const body = Array.from(
    { length: 30 },
    (_, index) => `KEYBODY${String(index).padStart(2, "0")}${"A".repeat(55)}`,
  );

  it("masks a key whose BEGIN line only the lead-in holds", () => {
    // A key still being printed: no END yet, and the tail starts inside its body.
    const raw = `before\n-----BEGIN RSA PRIVATE KEY-----\n${body.join("\n")}\n`;
    const shown = presentBackgroundTaskOutput(raw, { tailChars: 400, startsAtFileStart: true });
    assert.notInclude(shown.contents, "KEYBODY");
    assert.isTrue(shown.cut);
  });

  it("masks a key body whose BEGIN line is not in the window at all", () => {
    const raw = `${body.slice(5).join("\n")}\n-----END PRIVATE KEY-----\nafter the key\n`;
    const shown = presentBackgroundTaskOutput(raw, {
      tailChars: 100_000,
      startsAtFileStart: false,
    });
    assert.notInclude(shown.contents, "KEYBODY");
    assert.include(shown.contents, "after the key");
  });

  it("drops the partial word at a cut in a line with no break", () => {
    const raw = `${"a".repeat(100)} Zsecretfragment rest of line`;
    const shown = presentBackgroundTaskOutput(raw, {
      tailChars: "ecretfragment rest of line".length,
      startsAtFileStart: true,
    });
    assert.equal(shown.contents, "rest of line");
  });

  it("never shows the first, partial line of a window read from mid-file", () => {
    const shown = presentBackgroundTaskOutput("rtial-token-ghp\nline two\n", {
      tailChars: 1_000,
      startsAtFileStart: false,
    });
    assert.equal(shown.contents, "line two\n");
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
        root: NodePath.join(base, "absent"),
      });
      assert.isFalse(noRoot.found);
    }),
  );

  effectIt.effect("rejects a task id that is not a plain name", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        readBackgroundTaskOutput({ taskId: "../transcript", sessionIds: [session], root }),
      );
      assert.equal(failureReason(exit), "invalid-task-id");
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

  effectIt.effect.skipIf(!symlinksSupported)(
    "refuses a tasks directory linked outside the root",
    () =>
      Effect.gen(function* () {
        const sessionDir = NodePath.join(root, "-p", "aaaa0001");
        NodeFS.mkdirSync(sessionDir, { recursive: true });
        NodeFS.symlinkSync(
          makeOutsideTasks("linked", "bout00001"),
          NodePath.join(sessionDir, "tasks"),
        );
        const exit = yield* Effect.exit(
          readBackgroundTaskOutput({ taskId: "bout00001", sessionIds: ["aaaa0001"], root }),
        );
        assert.equal(failureReason(exit), "outside-root");
      }),
  );

  effectIt.effect.skipIf(!symlinksSupported)(
    "refuses another thread's session reached through a link",
    () =>
      Effect.gen(function* () {
        // Thread B's own output; thread A's tasks dir links to B's.
        const otherTasks = makeSession("bbbb0002", "bcross001", "THREAD B OUTPUT\n", "-other");
        const sessionDir = NodePath.join(root, "-p", "aaaa0002");
        NodeFS.mkdirSync(sessionDir, { recursive: true });
        NodeFS.symlinkSync(otherTasks, NodePath.join(sessionDir, "tasks"));
        const exit = yield* Effect.exit(
          readBackgroundTaskOutput({ taskId: "bcross001", sessionIds: ["aaaa0002"], root }),
        );
        assert.equal(failureReason(exit), "outside-root");
        // B itself still reads its own output.
        const own = yield* readBackgroundTaskOutput({
          taskId: "bcross001",
          sessionIds: ["bbbb0002"],
          root,
        });
        assert.equal(own.contents, "THREAD B OUTPUT\n");
      }),
  );

  effectIt.effect.skipIf(!symlinksSupported)(
    "refuses a tasks directory swapped for a link between the check and the open",
    () =>
      Effect.gen(function* () {
        const dir = makeSession("aaaa0003", "bswap0001", "inside\n");
        const elsewhere = makeOutsideTasks("swap-dir", "bswap0001");
        const exit = yield* Effect.exit(
          readBackgroundTaskOutput({
            taskId: "bswap0001",
            sessionIds: ["aaaa0003"],
            root,
            open: async (path, flags) => {
              await NodeFSP.rename(dir, `${dir}.moved`);
              await NodeFSP.symlink(elsewhere, dir);
              return NodeFSP.open(path, flags);
            },
          }),
        );
        assert.equal(failureReason(exit), "changed-during-read");
      }),
  );

  effectIt.effect.skipIf(!symlinksSupported)(
    "refuses an output file swapped for a link between the check and the open",
    () =>
      Effect.gen(function* () {
        const dir = makeSession("aaaa0004", "bswap0002", "inside\n");
        const target = NodePath.join(
          makeOutsideTasks("swap-leaf", "bswap0002"),
          "bswap0002.output",
        );
        const exit = yield* Effect.exit(
          readBackgroundTaskOutput({
            taskId: "bswap0002",
            sessionIds: ["aaaa0004"],
            root,
            open: async (path, flags) => {
              await NodeFSP.rm(NodePath.join(dir, "bswap0002.output"));
              await NodeFSP.symlink(target, NodePath.join(dir, "bswap0002.output"));
              return NodeFSP.open(path, flags);
            },
          }),
        );
        assert.equal(failureReason(exit), "changed-during-read");
      }),
  );

  effectIt.effect("refuses an opened file that is not the one the path names", () =>
    Effect.gen(function* () {
      makeSession("aaaa0005", "bswap0003", "inside\n");
      const other = NodePath.join(makeOutsideTasks("swap-inode", "bswap0003"), "bswap0003.output");
      const exit = yield* Effect.exit(
        readBackgroundTaskOutput({
          taskId: "bswap0003",
          sessionIds: ["aaaa0005"],
          root,
          // The path was swapped and swapped back around the open.
          open: (_path, flags) => NodeFSP.open(other, flags),
        }),
      );
      assert.equal(failureReason(exit), "changed-during-read");
    }),
  );

  effectIt.effect("refuses an output file hard-linked from elsewhere", () =>
    Effect.gen(function* () {
      const dir = makeSession("aaaa0006", "bplace001", "placeholder\n");
      const other = NodePath.join(makeOutsideTasks("hard", "bhard0001"), "bhard0001.output");
      NodeFS.linkSync(other, NodePath.join(dir, "bhard0001.output"));
      const exit = yield* Effect.exit(
        readBackgroundTaskOutput({ taskId: "bhard0001", sessionIds: ["aaaa0006"], root }),
      );
      assert.equal(failureReason(exit), "changed-during-read");
    }),
  );
});
