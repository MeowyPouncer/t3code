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
 * - the file's realpath must be exactly `<root>/<project>/<session>/tasks/
 *   <task>.output` for one of this thread's own sessions: a link anywhere
 *   below the root (a symlinked `tasks` dir, another thread's session, a
 *   subagent's `.output` pointing at its transcript) is refused;
 * - the file is opened without following a final link, and after opening the
 *   path must still name exactly the opened inode, a regular file with one
 *   link, so a swap between the check and the open is refused;
 * - only the tail is shown, cleaned of terminal control codes; secrets are
 *   masked over a wider window than is shown, so a cut cannot strip the
 *   context (a key's BEGIN line, a `token=`) that marks them. Nothing is stored.
 */
import * as NodeFS from "node:fs";
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
/** Read before the tail so masking sees what a cut would hide; longer than a private key. */
export const BACKGROUND_TASK_OUTPUT_LEAD_IN_BYTES = 16 * 1024;

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
 * Output as a reader sees it in a terminal: no escape codes, and a line a
 * progress bar rewrote with `\r` shows only its last state.
 */
export function cleanBackgroundTaskOutput(raw: string): string {
  return raw
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
const PEM_LABEL = "[A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?";
const PEM_BLOCK = new RegExp(
  `-----BEGIN ${PEM_LABEL}-----[\\s\\S]*?(?:-----END ${PEM_LABEL}-----|$)`,
  "gu",
);
const PEM_END = new RegExp(`-----END ${PEM_LABEL}-----`, "gu");
// A PEM body line (base64) or one of its RFC 1421 headers.
const PEM_BODY_LINE = /^(?:[A-Za-z0-9+/=]{0,100}|(?:Proc-Type|DEK-Info|Comment): .*)$/u;

/** Whole-match or one-group patterns: the group is the secret part. */
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /\bhttps?:\/\/([^\s/:@]+:[^\s/@]+)@/dgiu,
  /\bBearer\s+([A-Za-z0-9._~+/=-]{8,})/dgu,
  // A Basic credential is base64; "Basic authentication" is prose.
  /\bBasic\s+((?=[A-Za-z0-9+/]*(?:[0-9+/=]|[a-z][A-Z]))[A-Za-z0-9+/]{8,}={0,2})/dgu,
  new RegExp(`["']?\\b${SECRET_KEY}\\b["']?\\s*[:=]\\s*("[^"\\n]*"|'[^'\\n]*'|[^\\s,;]+)`, "dgiu"),
  /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/dgu,
];

interface SecretRange {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

/**
 * Where the credentials in `text` are. A private key whose BEGIN line is
 * not in `text` (cut off above) is still a key: its base64 body runs back
 * from the END line to the first line that is not body, or to the start.
 */
export function backgroundTaskOutputSecretRanges(text: string): ReadonlyArray<SecretRange> {
  const ranges: Array<SecretRange> = [];
  const pemReplacement = `${MASK} private key`;
  for (const match of text.matchAll(PEM_BLOCK)) {
    ranges.push({
      start: match.index,
      end: match.index + match[0].length,
      replacement: pemReplacement,
    });
  }
  for (const match of text.matchAll(PEM_END)) {
    const end = match.index + match[0].length;
    if (ranges.some((range) => range.start <= match.index && end <= range.end)) continue;
    let start = text.lastIndexOf("\n", match.index - 1) + 1;
    while (start > 0) {
      const previousStart = text.lastIndexOf("\n", start - 2) + 1;
      if (!PEM_BODY_LINE.test(text.slice(previousStart, start - 1))) break;
      start = previousStart;
    }
    ranges.push({ start, end, replacement: pemReplacement });
  }
  for (const pattern of SECRET_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const [start, end] = match.indices?.[1] ?? [match.index, match.index + match[0].length];
      ranges.push({ start, end, replacement: MASK });
    }
  }
  return ranges.toSorted((left, right) => left.start - right.start || right.end - left.end);
}

/** `text` from `from` on, with every range that reaches past `from` masked. */
function applySecretRanges(text: string, ranges: ReadonlyArray<SecretRange>, from: number): string {
  let output = "";
  let position = from;
  for (const range of ranges) {
    if (range.end <= position) continue;
    output += text.slice(position, Math.max(range.start, position)) + range.replacement;
    position = range.end;
  }
  return output + text.slice(position);
}

/**
 * Masks the credential shapes a log commonly prints. Output files are raw
 * terminal output, which the secret-masking hook never sees.
 */
export function maskBackgroundTaskOutput(text: string): string {
  return applySecretRanges(text, backgroundTaskOutputSecretRanges(text), 0);
}

/**
 * Where the shown tail starts: at most `tailChars` from the end, at a whole
 * line. A window read from mid-file never shows its first, partial line.
 * With no whole line left, the partial word at the cut is dropped, since it
 * may be the end of a credential whose start was cut away.
 */
function tailStart(text: string, tailChars: number, startsAtFileStart: boolean): number {
  let start = Math.max(0, text.length - tailChars);
  if (!startsAtFileStart) {
    const firstBreak = text.indexOf("\n");
    if (firstBreak !== -1) start = Math.max(start, firstBreak + 1);
  }
  if (start === 0 ? startsAtFileStart : text[start - 1] === "\n") return start;
  const nextBreak = text.indexOf("\n", start);
  if (nextBreak !== -1 && nextBreak < text.length - 1) return nextBreak + 1;
  const space = text.slice(start).search(/\s/u);
  return space === -1 ? text.length : start + space + 1;
}

/**
 * The tail of a read window, cleaned and masked. Masking runs over the whole
 * window before the cut, so the lead-in gives it the context the tail lacks.
 */
export function presentBackgroundTaskOutput(
  raw: string,
  input: { readonly tailChars: number; readonly startsAtFileStart: boolean },
): { readonly contents: string; readonly cut: boolean } {
  const text = cleanBackgroundTaskOutput(raw);
  const start = tailStart(text, input.tailChars, input.startsAtFileStart);
  return {
    contents: applySecretRanges(text, backgroundTaskOutputSecretRanges(text), start),
    cut: start > 0 || !input.startsAtFileStart,
  };
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

interface TaskOutputCandidate {
  readonly path: string;
  readonly project: string;
  readonly sessionId: string;
}

/** The first `<session>/tasks/<task>.output` that is a regular file, under any project directory. */
async function findTaskOutput(input: {
  readonly root: string;
  readonly sessionIds: ReadonlyArray<string>;
  readonly taskId: string;
}): Promise<TaskOutputCandidate | null> {
  let projects: ReadonlyArray<string>;
  try {
    // Dirent types come from lstat: a symlinked project directory is skipped.
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
      const path = NodePath.join(input.root, project, sessionId, "tasks", `${input.taskId}.output`);
      try {
        const stat = await NodeFSP.lstat(path);
        if (stat.isFile()) return { path, project, sessionId };
      } catch (cause) {
        if (!isMissing(cause)) throw cause;
      }
    }
  }
  return null;
}

type OpenTaskOutput = (path: string, flags: number) => Promise<NodeFSP.FileHandle>;

const OPEN_FLAGS =
  NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK;

type TaskOutputRead =
  | { readonly failure: "outside-root" | "changed-during-read" }
  | {
      readonly contents: string;
      readonly truncated: boolean;
      readonly sizeBytes: number;
      readonly modifiedAt: string;
    };

/**
 * Reads a task's output only from this thread's own session directory. The
 * check before opening refuses links; the check after opening proves the
 * path still names exactly the opened inode, so a swap in between fails.
 */
async function readContainedTaskOutput(input: {
  readonly root: string;
  readonly candidate: TaskOutputCandidate;
  readonly taskId: string;
  readonly tailBytes: number;
  readonly open: OpenTaskOutput;
}): Promise<TaskOutputRead> {
  const realRoot = await NodeFSP.realpath(input.root);
  // Exactly the lexical path under the real root: no link at any level below it.
  const expected = NodePath.join(
    realRoot,
    input.candidate.project,
    input.candidate.sessionId,
    "tasks",
    `${input.taskId}.output`,
  );
  if ((await NodeFSP.realpath(input.candidate.path)) !== expected) {
    return { failure: "outside-root" };
  }
  let handle: NodeFSP.FileHandle;
  try {
    handle = await input.open(expected, OPEN_FLAGS);
  } catch (cause) {
    // The final component became a link after the check.
    if ((cause as { readonly code?: unknown } | null)?.code === "ELOOP") {
      return { failure: "changed-during-read" };
    }
    throw cause;
  }
  try {
    const opened = await handle.stat();
    const [realAfter, pathAfter] = await Promise.all([
      NodeFSP.realpath(expected),
      NodeFSP.lstat(expected),
    ]);
    if (
      !opened.isFile() ||
      // A hard link could bring another file in under this name.
      opened.nlink !== 1 ||
      realAfter !== expected ||
      pathAfter.dev !== opened.dev ||
      pathAfter.ino !== opened.ino
    ) {
      return { failure: "changed-during-read" };
    }
    const windowLength = Math.min(
      opened.size,
      input.tailBytes + BACKGROUND_TASK_OUTPUT_LEAD_IN_BYTES,
    );
    const buffer = Buffer.alloc(windowLength);
    const { bytesRead } = await handle.read(buffer, 0, windowLength, opened.size - windowLength);
    const shown = presentBackgroundTaskOutput(buffer.subarray(0, bytesRead).toString("utf8"), {
      tailChars: input.tailBytes,
      startsAtFileStart: windowLength === opened.size,
    });
    return {
      contents: shown.contents,
      truncated: shown.cut,
      sizeBytes: opened.size,
      modifiedAt: opened.mtime.toISOString(),
    };
  } finally {
    await handle.close();
  }
}

export const readBackgroundTaskOutput = Effect.fn("orchestration.readBackgroundTaskOutput")(
  function* (input: {
    readonly taskId: string;
    readonly sessionIds: ReadonlyArray<string>;
    /** Tests only; the server reads Claude's own root. */
    readonly root?: string;
    readonly tailBytes?: number;
    /** Tests only: stands in for the open, to swap the file around it. */
    readonly open?: OpenTaskOutput;
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

    const read = yield* Effect.tryPromise({
      try: async () => {
        const candidate = await findTaskOutput({ root, sessionIds, taskId: input.taskId });
        if (candidate === null) return null;
        return readContainedTaskOutput({
          root,
          candidate,
          taskId: input.taskId,
          tailBytes: input.tailBytes ?? BACKGROUND_TASK_OUTPUT_TAIL_BYTES,
          open: input.open ?? ((path, flags) => NodeFSP.open(path, flags)),
        });
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
