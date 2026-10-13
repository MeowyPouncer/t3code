// FORK: how many of a queue's waiting launches start now. AgentQueueService does the I/O.
import type { AgentQueue, ThreadId } from "@t3tools/contracts";

/**
 * A queue's free slots, at most what still waits. A started thread holds its slot while it, its
 * subagents or the threads it launched work; one that waits for an answer, finished, or is gone
 * frees it.
 */
export function launchesToStart(
  queue: Pick<AgentQueue, "maxRunning" | "started" | "waiting">,
  works: (threadId: ThreadId) => boolean,
): number {
  const running = queue.started.filter((thread) => works(thread.threadId)).length;
  return Math.max(0, Math.min(queue.maxRunning - running, queue.waiting.length));
}
