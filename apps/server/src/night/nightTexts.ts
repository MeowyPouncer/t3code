// FORK: the night mode's built-in texts. A file in ~/.config/t3code replaces each of them.
// @effect-diagnostics nodeBuiltinImport:off - the plain text readers stat and read synchronously
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { NightPlan, OrchestrationV2RuntimeRequest } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { NightSessionView, NightThread } from "./nightLogic.ts";

/** What every top-level session gets on top of its own instructions while the user is away. */
export const DEFAULT_NIGHT_RULES = `The user is away until morning and nobody answers questions before then. T3 Code's night overseer watches every session.

- Do not call anything that waits for a person: question tools, plan approval, worktree prompts, or commands that ask for confirmation. Settle what your project's rules settle and keep working.
- If your project has night rules of its own (for example the "Night rules" section of .claude/skills/afk/SKILL.md), follow them. Skip their preflight and question batch: the overseer did that before the user left.
- A decision that belongs to the user (product, data, money, access, deploys, anything destructive) becomes a P0 question for the morning, in the form your project uses (a QUESTION-* card, or the open questions of your final message). Work that does not depend on it goes on; work that does stops cleanly.
- Commit after each finished step and keep your notes current, so a usage limit or a restart loses nothing.
- When you finish, end with a short summary: what is done, what is left, and the questions for the morning.`;

/** The overseer's own system instructions. */
export const DEFAULT_NIGHT_OVERSEER_INSTRUCTIONS = `You are T3 Code's night overseer. The user is leaving their agents working and will read your morning report. You do not implement anything yourself.

Briefing (until the user says they are leaving): read every working or waiting top-level session with t3_thread_list and t3_thread_read, gather the questions they have now and the ones they will likely hit tonight, and ask the user all of them in one batch. Relay each answer to its session with t3_pending_request_respond or t3_thread_send. Do not interrupt a running turn: queue the message instead.

Night: T3 wakes you with a message when a session asks something, stops, fails, hits a usage limit, or nears its context limit, and when the night's work is done.
- A pending request: answer it with t3_pending_request_respond when your project's rules, the cards and the briefing settle it. Otherwise leave it for the morning and note it; the user's questions become P0 items, never guesses.
- A session that stopped with a question in its last message: reply with t3_thread_send when the rules settle it, otherwise note it for the morning.
- A failure or a usage limit: note it; restart the work only when it is safe and clearly what the user wanted.
- A session near its context limit: when it is idle between turns, send it /compact with t3_thread_send; never interrupt a running turn for it.
- End every turn with one log line: the time, the session, what happened and what you did. T3 compacts your context when it fills up, and these lines keep the night for your report. Keep your context lean: read only what an event needs.

Morning report: when T3 asks for it, write one concise report: per session what got done, what failed, what is waiting, and every question for the user with a recommended answer and links to the threads. Then stop: T3 handles the rest.`;

function readOverride(name: string, fallback: string): string {
  const path = NodePath.join(NodeOS.homedir(), ".config", "t3code", name);
  try {
    const text = NodeFS.readFileSync(path, "utf8").trim();
    return text.length > 0 ? text.slice(0, 32_000) : fallback;
  } catch {
    return fallback;
  }
}

/** ~/.config/t3code/night-rules.md replaces the built-in night rules. */
export const nightRules = (): string => readOverride("night-rules.md", DEFAULT_NIGHT_RULES);

/** ~/.config/t3code/night-overseer.md replaces the overseer's built-in instructions. */
export const nightOverseerInstructions = (): string =>
  readOverride("night-overseer.md", DEFAULT_NIGHT_OVERSEER_INSTRUCTIONS);

/** Local time of the machine T3 runs on, which is where the user sleeps. */
const hhmm = (iso: string) =>
  DateTime.formatLocal(DateTime.makeUnsafe(iso), {
    locale: "en-GB",
    hour: "2-digit",
    minute: "2-digit",
  });

const link = (thread: Pick<NightThread, "id" | "title">) =>
  `[${thread.title.replaceAll(/[[\]]/g, "")}](t3-thread://v1/${thread.id})`;

const REQUEST_LABELS: Record<OrchestrationV2RuntimeRequest["kind"], string> = {
  user_input: "a question",
  command: "approval to run a command",
  "file-read": "approval to read a file",
  "file-change": "approval to change files",
  "mcp-elicitation": "input for an MCP tool",
  permission: "a permission",
  dynamic_tool_call: "a tool call",
  auth_refresh: "the user to sign in again",
};

/** How a session stands, for the briefing and for stop reports. */
export function describeNightSession(session: NightSessionView): string {
  const { thread } = session;
  const parts: string[] = [];
  if (thread.pendingRuntimeRequest !== null) {
    parts.push(`waits for ${REQUEST_LABELS[thread.pendingRuntimeRequest.kind]}`);
  } else if (session.works) {
    parts.push("working");
  } else if (thread.lastErrorClass === "usage_limit" && thread.usageLimitResetAt != null) {
    parts.push(`hit a usage limit that resets at ${hhmm(thread.usageLimitResetAt)}`);
  } else if (thread.status === "failed") {
    parts.push(`failed${thread.lastErrorClass == null ? "" : ` (${thread.lastErrorClass})`}`);
  } else if (thread.status === "interrupted" || thread.status === "cancelled") {
    parts.push(`was ${thread.status}`);
  } else {
    parts.push("finished its turn");
  }
  for (const waiting of session.waitingDescendants) {
    const request = waiting.pendingRuntimeRequest;
    if (request === null) continue;
    parts.push(`${link(waiting)}, working for it, waits for ${REQUEST_LABELS[request.kind]}`);
  }
  return `- ${link(thread)}: ${parts.join("; ")}`;
}

/** The overseer's first message: what the night is and what runs at its end. */
export function nightBriefingMessage(input: {
  readonly plan: NightPlan;
  readonly briefingEndsAt: string;
  readonly sessions: ReadonlyArray<NightSessionView>;
}): string {
  const { end } = input.plan;
  const sessions =
    input.sessions.length === 0
      ? "No session is working or waiting right now."
      : input.sessions.map(describeNightSession).join("\n");
  const ending = [
    end.agents.length > 0
      ? `- start ${end.agents.length === 1 ? "an agent" : `${end.agents.length} agents`}: ${end.agents.map((launch) => launch.title).join("; ")}`
      : null,
    end.queue.length > 0
      ? `- then run ${end.queue.length === 1 ? "a queued prompt" : `${end.queue.length} queued prompts`}, one at a time, each once nothing works`
      : null,
    "- ask you for the morning report",
    end.powerOff ? "- power the computer off a minute after your report" : null,
  ].filter((line) => line !== null);
  return [
    `The user is getting ready to leave for the night. The briefing lasts until they press "I'm leaving", or until ${hhmm(input.briefingEndsAt)} at the latest.`,
    `Working or waiting sessions:\n${sessions}`,
    `When all of tonight's work is done, T3 will:\n${ending.join("\n")}`,
    "Start the briefing now: gather the questions and ask the user in one batch.",
  ].join("\n\n");
}

export const nightLeftMessage = (trigger: "leave" | "timer"): string =>
  [
    trigger === "leave"
      ? "The user has left. The night starts now."
      : "The briefing time ran out before the user said they were leaving. Treat them as gone: the night starts now.",
    "Every session's instructions now carry the night rules. Relay any briefing answers you have not passed on yet, then wait: T3 wakes you with events.",
  ].join(" ");

export const nightRequestMessage = (
  thread: NightThread,
  request: Pick<OrchestrationV2RuntimeRequest, "id" | "kind">,
): string =>
  `${link(thread)} waits for ${REQUEST_LABELS[request.kind]} (request ${request.id}). Read it with t3_pending_request_read. Answer with t3_pending_request_respond when the rules, the cards or the briefing settle it; otherwise leave it for the morning and log it.`;

export const nightStoppedMessage = (sessions: ReadonlyArray<NightSessionView>): string =>
  [
    sessions.length === 1 ? "A session stopped:" : "Sessions stopped:",
    sessions.map(describeNightSession).join("\n"),
    "Read the end of each. When it ends with a question the rules settle, or work that is clearly wanted should go on, reply with t3_thread_send. Otherwise log it for the morning.",
  ].join("\n");

export const nightContextMessage = (thread: NightThread, ratio: number): string =>
  `${link(thread)} has used ${Math.round(ratio * 100)}% of its context. If it stops between turns before it is done, you may send it /compact with t3_thread_send. Never interrupt a running turn for it.`;

export const nightEndStartedMessage = (input: {
  readonly what: "agents" | "queued";
  readonly started: ReadonlyArray<Pick<NightThread, "id" | "title">>;
  readonly failed: ReadonlyArray<{ readonly title: string; readonly reason: string }>;
  readonly position?: { readonly index: number; readonly total: number };
}): string =>
  [
    input.what === "agents"
      ? "Nothing works any more, so T3 started the end-of-night agents:"
      : `Nothing works any more, so T3 started queued prompt ${(input.position?.index ?? 0) + 1} of ${input.position?.total ?? 1}:`,
    ...input.started.map((thread) => `- ${link(thread)}`),
    ...input.failed.map((launch) => `- could not start "${launch.title}": ${launch.reason}`),
    "Watch them like the other sessions.",
  ].join("\n");

export const nightReportMessage = (powerOff: boolean): string =>
  `All of tonight's work is done. Write the morning report now, as your instructions describe, then stop.${powerOff ? " T3 powers the computer off a minute after your report." : ""}`;

export const NIGHT_ENDED_MESSAGE =
  "The user is back and ended the night. Stop watching: the night rules no longer apply.";
