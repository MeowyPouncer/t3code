// FORK: start agents for TODO board cards, one thread per card or one orchestrator for them all.
import type { TodoBoardCard } from "@t3tools/contracts";

import { taskPrompt } from "./taskBoardLogic";

export type TaskAgentsMode = "separate" | "orchestrator";

/** How many card agents may work at once; the rest wait for a free slot. */
export const TASK_AGENT_LIMITS = [1, 2, 3, 4, 5, 6, 8, 10] as const;
export const DEFAULT_TASK_AGENT_LIMIT = 3;

/** Where a project keeps the system instructions for orchestrators started from Tasks. */
export const ORCHESTRATOR_INSTRUCTIONS_PATH = ".t3/orchestrator.md";

/** What an orchestrator gets when the project has no instructions file. */
export const DEFAULT_ORCHESTRATOR_INSTRUCTIONS = `You orchestrate the TODO cards listed in the user's first message. Do not implement them in this thread.

- Read the project's agent rules (AGENTS.md and what it points to) and each card before you start anything.
- Start one writer per card in its own T3 thread with t3_thread_launch: give it the card's start prompt and brief, and keep its threadId. Never let two writers share a worktree.
- Run cards that do not depend on each other in parallel, dependent ones in order. When the order or a card is unclear, ask the user before starting it.
- Follow the writers with t3_thread_read and t3_thread_wait. Answer what the cards and rules settle, and bring everything else to the user.
- Finish with a short report per card: done, blocked or not started, with a link to its thread.`;

/** Cards an agent can start from; a card known only on origin has no local file. */
export function canStartTaskAgent(card: TodoBoardCard): boolean {
  return !card.origin_only;
}

/** The card ID leads the title, so the thread is easy to match to its card. */
export function taskAgentThreadTitle(card: TodoBoardCard): string {
  return `${card.id} · ${card.title}`;
}

export function orchestratorThreadTitle(cards: ReadonlyArray<TodoBoardCard>): string {
  return `${cards.map((card) => card.id).join(" + ")} · orchestrator`;
}

/**
 * The orchestrator's first message: every card with its brief, file and start prompt, and how many
 * writers may work at once when that is fewer than the cards.
 */
export function orchestratorMessage(
  projectTitle: string,
  cards: ReadonlyArray<TodoBoardCard>,
  maxRunning?: number,
): string {
  const entries = cards.map((card, index) => {
    const start =
      card.kind === "note" ? card.prompt : (card.prompt || `/take-card ${card.id}`).trim();
    return [
      `${index + 1}. ${card.id} — ${card.title}`,
      ...(card.brief && card.brief !== card.title ? [`   Brief: ${card.brief}`] : []),
      ...(card.path ? [`   Card file: ${card.path}`] : []),
      `   Start prompt: ${start}`,
    ].join("\n");
  });
  return [
    `Orchestrate ${cards.length === 1 ? "this card" : `these ${cards.length} cards`} from the ${projectTitle} TODO board:`,
    ...entries,
    ...(maxRunning !== undefined && maxRunning < cards.length
      ? [
          `Run at most ${maxRunning} ${maxRunning === 1 ? "writer" : "writers"} at a time: start the next card only when one of them has finished.`,
        ]
      : []),
  ].join("\n\n");
}

/** One thread per card with the card's own prompt, or one orchestrator thread for all of them. */
export function planTaskAgentLaunches(input: {
  readonly mode: TaskAgentsMode;
  readonly projectTitle: string;
  readonly cards: ReadonlyArray<TodoBoardCard>;
  readonly instructions: string;
  /** How many may work at once; the orchestrator gets it in its message. */
  readonly maxRunning?: number;
}): ReadonlyArray<{
  readonly title: string;
  readonly text: string;
  readonly instructions?: string;
}> {
  if (input.cards.length === 0) return [];
  return input.mode === "orchestrator"
    ? [
        {
          title: orchestratorThreadTitle(input.cards),
          text: orchestratorMessage(input.projectTitle, input.cards, input.maxRunning),
          instructions: input.instructions,
        },
      ]
    : input.cards.map((card) => ({ title: taskAgentThreadTitle(card), text: taskPrompt(card) }));
}
