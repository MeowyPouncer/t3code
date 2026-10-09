// @effect-diagnostics nodeBuiltinImport:off
/**
 * The end of a Claude background task's output, for the composer's
 * background-work drawer (FORK-010).
 *
 * Claude Code writes a background Bash or Monitor's output to
 * `<tmp>/claude-<uid>/<project>/<session>/tasks/<task>.output` and names that
 * path only once the task ends, so the server finds the file from the thread's
 * own Claude sessions and the task id; no client path is accepted.
 *
 * Containment rules:
 * - task and session ids are plain names, so they cannot walk the tree;
 * - a symlinked `.output` (a subagent's points at its transcript) is not
 *   served: subagents have their own thread;
 * - the opened file's realpath must stay under Claude's temp root;
 * - only the tail is read, cleaned of terminal control codes and with
 *   secrets masked before it crosses the transport. Nothing is stored.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  OrchestrationGetBackgroundTaskOutputError,
  type OrchestrationV2GetBackgroundTaskOutputResult,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

// ClaudeAdapterV2's CLAUDE_PROVIDER, without loading the adapter here.
const CLAUDE_DRIVER = "claudeAgent";

/** Enough for a screen of a build log; the drawer shows the end of it. */
export const BACKGROUND_TASK_OUTPUT_TAIL_BYTES = 64 * 1024;

const PLAIN_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function isPlainBackgroundTaskId(value: string): boolean {
  return PLAIN_ID.test(value);
}

/** Where Claude Code keeps its per-session task files, as the CLI computes it. */
export function claudeTaskOutputRoot(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly tmpdir: string;
  readonly uid: number | undefined;
}): string {
  const base = input.env.CLAUDE_CODE_TMPDIR?.trim() || input.tmpdir;
  return NodePath.join(base, input.uid === undefined ? "claude" : `claude-${input.uid}`);
}

/** The native session ids of a thread's Claude provider threads, newest last. */
export function claudeSessionIdsForThread(
  providerThreads: ReadonlyArray<Pick<OrchestrationV2ProviderThread, "driver" | "nativeThreadRef">>,
): ReadonlyArray<string> {
  const ids = new Set<string>();
  for (const thread of providerThreads) {
    if (thread.driver !== CLAUDE_DRIVER) continue;
    const nativeId = thread.nativeThreadRef?.nativeId;
    if (typeof nativeId === "string" && isPlainBackgroundTaskId(nativeId)) ids.add(nativeId);
  }
  return [...ids];
}

// CSI (colours, cursor moves), OSC (titles, links) and two-byte escapes.
const ANSI_ESCAPE =
  // eslint-disable-next-line no-control-regex -- terminal escape codes are what this strips
  /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/gu;
// eslint-disable-next-line no-control-regex -- stray control bytes are what this strips
const OTHER_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu;

/**
 * The tail as a reader sees it in a terminal: no escape codes, and a line a
 * progress bar rewrote with `\r` shows only its last state. A cut tail starts
 * at its first whole line.
 */
export function cleanBackgroundTaskOutput(raw: string, truncated: boolean): string {
  let text = raw;
  if (truncated) {
    const firstBreak = text.indexOf("\n");
    text = firstBreak === -1 ? text : text.slice(firstBreak + 1);
  }
  return text
    .replace(ANSI_ESCAPE, "")
    .split("\n")
    .map((line) => {
      const withoutCr = line.endsWith("\r") ? line.slice(0, -1) : line;
      const lastReturn = withoutCr.lastIndexOf("\r");
      return (lastReturn === -1 ? withoutCr : withoutCr.slice(lastReturn + 1)).replace(
        OTHER_CONTROL,
        "",
      );
    })
    .join("\n");
}

const MASK = "[masked]";
const SECRET_KEY =
  "[A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|credentials?)";

/**
 * Masks the credential shapes a log commonly prints. Output files are raw
 * terminal output, which the secret-masking hook never sees.
 */
export function maskBackgroundTaskOutput(text: string): string {
  return (
    text
      .replace(
        /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu,
        `${MASK} private key`,
      )
      .replace(/\b(https?:\/\/)[^\s/:@]+:[^\s/@]+@/giu, `$1${MASK}@`)
      .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gu, `$1 ${MASK}`)
      // A Basic credential is base64; "Basic authentication" is prose.
      .replace(
        /\b(Basic)\s+(?=[A-Za-z0-9+/]*(?:[0-9+/=]|[a-z][A-Z]))[A-Za-z0-9+/]{8,}={0,2}/gu,
        `$1 ${MASK}`,
      )
      .replace(
        new RegExp(
          `(["']?\\b${SECRET_KEY}\\b["']?\\s*[:=]\\s*)("[^"\\n]*"|'[^'\\n]*'|[^\\s,;]+)`,
          "giu",
        ),
        `$1${MASK}`,
      )
      .replace(
        /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/gu,
        MASK,
      )
  );
}

const NOT_FOUND: OrchestrationV2GetBackgroundTaskOutputResult = {
  found: false,
  contents: "",
  truncated: false,
  sizeBytes: 0,
};

function isMissing(cause: unknown): boolean {
  const code = (cause as { readonly code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** The first regular `<session>/tasks/<task>.output` under any project directory. */
async function findTaskOutput(input: {
  readonly root: string;
  readonly sessionIds: ReadonlyArray<string>;
  readonly taskId: string;
}): Promise<string | null> {
  let projects: ReadonlyArray<string>;
  try {
    projects = (await NodeFSP.readdir(input.root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (cause) {
    if (isMissing(cause)) return null;
    throw cause;
  }
  // The newest session is the likeliest owner of a live task.
  for (const sessionId of input.sessionIds.toReversed()) {
    for (const project of projects) {
      const candidate = NodePath.join(
        input.root,
        project,
        sessionId,
        "tasks",
        `${input.taskId}.output`,
      );
      try {
        const stat = await NodeFSP.lstat(candidate);
        if (stat.isFile()) return candidate;
      } catch (cause) {
        if (!isMissing(cause)) throw cause;
      }
    }
  }
  return null;
}

export const readBackgroundTaskOutput = Effect.fn("orchestration.readBackgroundTaskOutput")(
  function* (input: {
    readonly taskId: string;
    readonly sessionIds: ReadonlyArray<string>;
    /** Tests only; the server reads Claude's own root. */
    readonly root?: string;
    readonly tailBytes?: number;
  }) {
    if (!isPlainBackgroundTaskId(input.taskId)) {
      return yield* new OrchestrationGetBackgroundTaskOutputError({
        reason: "invalid-task-id",
        taskId: input.taskId,
      });
    }
    const sessionIds = input.sessionIds.filter(isPlainBackgroundTaskId);
    if (sessionIds.length === 0) return NOT_FOUND;
    const root =
      input.root ??
      claudeTaskOutputRoot({
        env: process.env,
        tmpdir: NodeOS.tmpdir(),
        uid: process.getuid?.(),
      });
    const tailBytes = input.tailBytes ?? BACKGROUND_TASK_OUTPUT_TAIL_BYTES;

    const read = yield* Effect.tryPromise({
      try: async () => {
        const path = await findTaskOutput({ root, sessionIds, taskId: input.taskId });
        if (path === null) return null;
        const [realRoot, realPath] = await Promise.all([
          NodeFSP.realpath(root),
          NodeFSP.realpath(path),
        ]);
        if (!realPath.startsWith(`${realRoot}${NodePath.sep}`)) {
          return { failure: "outside-root" as const };
        }
        const handle = await NodeFSP.open(realPath, "r");
        try {
          // Verify what was opened, not the path: a swap after lstat cannot pass.
          const stat = await handle.stat();
          if (!stat.isFile()) return null;
          const length = Math.min(stat.size, tailBytes);
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buffer, 0, length, stat.size - length);
          const truncated = stat.size > length;
          return {
            contents: maskBackgroundTaskOutput(
              cleanBackgroundTaskOutput(buffer.subarray(0, bytesRead).toString("utf8"), truncated),
            ),
            truncated,
            sizeBytes: stat.size,
            modifiedAt: stat.mtime.toISOString(),
          };
        } finally {
          await handle.close();
        }
      },
      catch: (cause) =>
        new OrchestrationGetBackgroundTaskOutputError({
          reason: "read-failed",
          taskId: input.taskId,
          cause,
        }),
    });
    if (read === null) return NOT_FOUND;
    if ("failure" in read) {
      return yield* new OrchestrationGetBackgroundTaskOutputError({
        reason: read.failure,
        taskId: input.taskId,
      });
    }
    return {
      found: true,
      contents: read.contents,
      truncated: read.truncated,
      sizeBytes: read.sizeBytes,
      modifiedAt: read.modifiedAt,
    } satisfies OrchestrationV2GetBackgroundTaskOutputResult;
  },
);
