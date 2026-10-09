import type {
  OrchestrationV2AppThread,
  OrchestratorMcpDelegateTaskInput,
  ProviderInstanceHardCap,
} from "@t3tools/contracts";

import { hardCapWithheldCapabilities } from "../provider/ProviderInstanceHardCap.ts";
import type { McpCapability } from "./McpInvocationContext.ts";

/**
 * Which T3 MCP capabilities a provider session is minted without, beyond the
 * user's browser and device access settings.
 *
 * A delegated task's role lives only in the prompt T3 writes for the child,
 * so the role is read back from that prompt. A parent that writes the role
 * line by hand only takes capabilities away from its own child.
 */

const rolePrefix = (role: NonNullable<OrchestratorMcpDelegateTaskInput["role"]>) =>
  `Act as the ${role} sub-agent for this task.\n\n`;

/** The prompt a `delegate_task` child starts with. */
export function delegatedTaskPrompt(
  input: Pick<OrchestratorMcpDelegateTaskInput, "role" | "task">,
): string {
  return input.role === undefined || input.role === "general"
    ? input.task
    : `${rolePrefix(input.role)}${input.task}`;
}

export function isReviewTaskPrompt(prompt: string): boolean {
  return prompt.startsWith(rolePrefix("review"));
}

/** A thread `delegate_task` started, whose task record lives on its parent. */
export function isDelegatedTaskThread(
  thread: Pick<OrchestrationV2AppThread, "lineage" | "creationSource">,
): boolean {
  return (
    thread.lineage.parentThreadId !== null &&
    thread.lineage.relationshipToParent === "subagent" &&
    thread.creationSource === "mcp"
  );
}

/** What a session is minted without when its settings cannot be read. */
export const UNREADABLE_TRIM_WITHHELD: ReadonlySet<McpCapability> = new Set([
  "orchestration",
  "pull-requests",
]);

export function withheldMcpCapabilities(input: {
  /** The hard cap of the session's provider instance. */
  readonly cap: ProviderInstanceHardCap | undefined;
  readonly thread: Pick<OrchestrationV2AppThread, "createdBy">;
  /** The task prompt, when the thread is a `delegate_task` child. */
  readonly delegatedTaskPrompt: string | undefined;
  /** `enableChildAgentBrowserAccess`. */
  readonly childAgentBrowserAccess: boolean;
}): ReadonlySet<McpCapability> {
  const withheld = new Set<McpCapability>(hardCapWithheldCapabilities(input.cap));
  // One reviewer per review: it may not start sub-agents of its own.
  if (input.delegatedTaskPrompt !== undefined && isReviewTaskPrompt(input.delegatedTaskPrompt)) {
    withheld.add("orchestration");
  }
  if (!input.childAgentBrowserAccess && input.thread.createdBy === "agent") {
    withheld.add("preview");
  }
  return withheld;
}
