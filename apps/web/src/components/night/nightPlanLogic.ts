// FORK: the night mode's plan as the client composes it, and its state as the client shows it.
import type {
  ModelSelection,
  NightLaunch,
  NightState,
  ProjectId,
  RuntimeMode,
  TodoBoardCard,
} from "@t3tools/contracts";

import { planTaskAgentLaunches, type TaskAgentsMode } from "../tasks/taskAgentsLogic";

export const NIGHT_BRIEFING_MINUTES = [5, 10, 15, 30, 60] as const;
export const DEFAULT_NIGHT_BRIEFING_MINUTES = 15;

const PROMPT_TITLE_LENGTH = 60;

/** A queued prompt's thread is named after its first line. */
export function nightPromptTitle(text: string): string {
  const firstLine = text.trim().split("\n")[0]?.trim() ?? "";
  return firstLine.length > PROMPT_TITLE_LENGTH
    ? `${firstLine.slice(0, PROMPT_TITLE_LENGTH - 1)}…`
    : firstLine;
}

/**
 * The threads T3 starts once the night's work is done: agents for the picked cards, the way Tasks
 * starts them, then each queued prompt. None starts in plan mode: a plan waits for an approval
 * nobody gives at night.
 */
export function planNightEnd(input: {
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly cards: ReadonlyArray<TodoBoardCard>;
  readonly mode: TaskAgentsMode;
  readonly instructions: string;
  readonly prompts: ReadonlyArray<string>;
}): { readonly agents: ReadonlyArray<NightLaunch>; readonly queue: ReadonlyArray<NightLaunch> } {
  const base = {
    projectId: input.projectId,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: "default" as const,
  };
  const agents = planTaskAgentLaunches({
    mode: input.mode,
    projectTitle: input.projectTitle,
    cards: input.cards,
    instructions: input.instructions,
  }).map((launch) => ({ ...base, ...launch }));
  const queue = input.prompts
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .map((text) => ({ ...base, title: nightPromptTitle(text), text }));
  return { agents, queue };
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** One line for where the night stands. */
export function nightStatusLabel(state: NightState): string {
  switch (state.phase) {
    case "briefing":
      return `Briefing until ${clock(state.briefingEndsAt)}`;
    case "night":
      return `Night since ${clock(state.nightStartedAt ?? state.startedAt)}`;
    case "ending":
      return "Running the end-of-night work";
    case "report":
      return "The overseer writes the morning report";
    case "done":
      return state.poweredOffAt !== null
        ? `Over; powered off at ${clock(state.poweredOffAt)}`
        : state.poweringOffAt !== null
          ? `Over; powering off at ${clock(state.poweringOffAt)}`
          : `Over at ${clock(state.doneAt ?? state.startedAt)}`;
  }
}

/** A night that still runs, as opposed to one that is over and waits to be dismissed. */
export const nightRuns = (state: NightState | null): boolean =>
  state !== null && state.phase !== "done";
