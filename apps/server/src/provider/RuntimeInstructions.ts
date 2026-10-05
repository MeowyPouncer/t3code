// @effect-diagnostics nodeBuiltinImport:off - FORK: the plain instruction builders read the local file synchronously
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
When the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: T3 Code wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher.
</pull_request_linking>`;

/** FORK: the user's own rules file is cut here, since Cursor and ACP resend it with every turn. */
const LOCAL_INSTRUCTIONS_LIMIT = 16_000;

let localInstructionsCache: { path: string; mtimeMs: number; text: string } | undefined;

/** FORK: `T3CODE_LOCAL_INSTRUCTIONS_FILE` (empty turns it off), else `~/.config/t3code/instructions.md`. */
export function localInstructionsPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.T3CODE_LOCAL_INSTRUCTIONS_FILE;
  return configured !== undefined
    ? configured.trim()
    : NodePath.join(NodeOS.homedir(), ".config", "t3code", "instructions.md");
}

/**
 * FORK: the user's own rules for every provider, as a `<local_instructions>` block, or "" when the
 * file is missing, empty or unreadable. Re-read only when its mtime changes.
 */
export function localInstructions(path: string = localInstructionsPath()): string {
  try {
    const { mtimeMs } = NodeFS.statSync(path);
    if (localInstructionsCache?.path !== path || localInstructionsCache.mtimeMs !== mtimeMs) {
      const text = NodeFS.readFileSync(path, "utf8").trim().slice(0, LOCAL_INSTRUCTIONS_LIMIT);
      localInstructionsCache = { path, mtimeMs, text };
    }
    const { text } = localInstructionsCache;
    return text ? `<local_instructions>\n${text}\n</local_instructions>` : "";
  } catch {
    return "";
  }
}

/**
 * Shared runtime context; omit model and effort when the harness manages them dynamically.
 * `modelName` is the display name users see in the model picker; `model` is the slug.
 * FORK: the local instructions follow, unless the caller sends them separately (`local: false`).
 */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly local?: boolean | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  const local = runtime.local === false ? "" : localInstructions();
  return `<runtime_info>In case you're asked: you are running in T3 Code through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}${local ? `\n\n${local}` : ""}`;
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
