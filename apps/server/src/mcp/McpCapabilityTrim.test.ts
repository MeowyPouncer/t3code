import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";

import {
  delegatedTaskPrompt,
  isDelegatedTaskThread,
  isReviewTaskPrompt,
  withheldMcpCapabilities,
} from "./McpCapabilityTrim.ts";

const parentThreadId = ThreadId.make("thread:trim-parent");
const rootThreadId = ThreadId.make("thread:trim-root");

describe("McpCapabilityTrim", () => {
  it("writes the role line for every role but general, and reads review back", () => {
    assert.equal(delegatedTaskPrompt({ task: "Do it." }), "Do it.");
    assert.equal(delegatedTaskPrompt({ task: "Do it.", role: "general" }), "Do it.");
    const review = delegatedTaskPrompt({ task: "Check it.", role: "review" });
    assert.equal(review, "Act as the review sub-agent for this task.\n\nCheck it.");
    assert.isTrue(isReviewTaskPrompt(review));
    assert.isFalse(isReviewTaskPrompt(delegatedTaskPrompt({ task: "Look.", role: "research" })));
    assert.isFalse(isReviewTaskPrompt("Please review the diff."));
  });

  it("recognizes only delegate_task children as delegated tasks", () => {
    const lineage = {
      parentThreadId,
      relationshipToParent: "subagent" as const,
      rootThreadId,
    };
    assert.isTrue(isDelegatedTaskThread({ lineage, creationSource: "mcp" }));
    // A provider's own subagent mirror shares the parent's session.
    assert.isFalse(isDelegatedTaskThread({ lineage, creationSource: "provider" }));
    assert.isFalse(
      isDelegatedTaskThread({
        lineage: { ...lineage, relationshipToParent: "fork" },
        creationSource: "mcp",
      }),
    );
    assert.isFalse(
      isDelegatedTaskThread({
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId },
        creationSource: "mcp",
      }),
    );
  });

  it("withholds orchestration from a review child only", () => {
    const base = { cap: undefined, thread: { createdBy: "agent" as const } };
    assert.deepEqual(
      withheldMcpCapabilities({
        ...base,
        delegatedTaskPrompt: delegatedTaskPrompt({ task: "Check it.", role: "review" }),
        childAgentBrowserAccess: true,
      }),
      new Set(["orchestration"]),
    );
    assert.deepEqual(
      withheldMcpCapabilities({
        ...base,
        delegatedTaskPrompt: delegatedTaskPrompt({ task: "Build it.", role: "implementation" }),
        childAgentBrowserAccess: true,
      }),
      new Set(),
    );
  });

  it("withholds the browser from agent-started threads only when child access is off", () => {
    const off = { cap: undefined, delegatedTaskPrompt: undefined, childAgentBrowserAccess: false };
    assert.deepEqual(
      withheldMcpCapabilities({ ...off, thread: { createdBy: "agent" } }),
      new Set(["preview"]),
    );
    // The orchestrator a person started keeps its browser.
    assert.deepEqual(withheldMcpCapabilities({ ...off, thread: { createdBy: "user" } }), new Set());
    assert.deepEqual(
      withheldMcpCapabilities({
        ...off,
        childAgentBrowserAccess: true,
        thread: { createdBy: "agent" },
      }),
      new Set(),
    );
  });

  it("adds the instance cap's withheld capabilities", () => {
    assert.deepEqual(
      withheldMcpCapabilities({
        cap: { withheldCapabilities: ["orchestration", "pull-requests"] },
        thread: { createdBy: "user" },
        delegatedTaskPrompt: undefined,
        childAgentBrowserAccess: true,
      }),
      new Set(["orchestration", "pull-requests"]),
    );
  });
});
