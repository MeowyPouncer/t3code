import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  type ProviderInstanceHardCap,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/compat";

import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import {
  acpMcpToolApprovalElicitationDisposition,
  acpPermissionDisposition,
} from "@t3tools/provider-acp/server/clientPolicy";
import {
  clampRuntimeModeToHardCap,
  shouldAutoDeclineRuntimeRequest,
} from "./ProviderInstanceHardCap.ts";

/**
 * The approval-required allowlist path. The MCP live check saw no approval
 * prompt only because its children ran with full access; a capped child runs
 * Supervised. Under the cap, T3's own `t3-code` tools stay pre-approved for
 * Claude while every other tool goes through the approval callback, an ACP
 * child (agy) asks before edits and MCP tool calls, and its file changes are
 * declined for the user.
 */
const cap: ProviderInstanceHardCap = {
  maxRuntimeMode: "approval-required",
  declineFileChanges: true,
  withheldCapabilities: ["orchestration", "pull-requests"],
};
const cwd = process.cwd();

// What RuntimePolicyV2 hands the adapter for a full-access thread on the
// capped instance, against what it hands an uncapped one.
const policyFor = (capped: boolean) =>
  ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: clampRuntimeModeToHardCap("full-access", capped ? cap : undefined),
    interactionMode: "default",
    cwd,
  });

const acpPermission = (
  kind: NonNullable<EffectAcpSchema.RequestPermissionRequest["toolCall"]["kind"]>,
): EffectAcpSchema.RequestPermissionRequest => ({
  options: [],
  sessionId: "hard-cap-session",
  toolCall: { kind, locations: [{ path: "src/index.ts" }], toolCallId: "hard-cap-tool-call" },
});

const mcpToolApproval = {
  mode: "form",
  message: "Allow the t3-code tool?",
  requestedSchema: { type: "object", properties: {} },
  _meta: { codex_approval_kind: "mcp_tool_call" },
} as unknown as EffectAcpSchema.CreateElicitationRequest;

describe("ProviderInstanceHardCap approval-required allowlist path", () => {
  it("runs a full-access request Supervised on the capped instance", () => {
    assert.equal(policyFor(true).runtimeMode, "approval-required");
    assert.equal(policyFor(false).runtimeMode, "full-access");
  });

  it("keeps Claude's t3-code tools pre-approved while every other tool asks", () => {
    const capped = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(policyFor(true));
    assert.equal(capped.permissionMode, "default");
    assert.isTrue(capped.installPermissionCallback);
    assert.isUndefined(capped.allowDangerouslySkipPermissions);
    // Full access asks for nothing: the live check's "no approval asked".
    const uncapped = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(policyFor(false));
    assert.equal(uncapped.permissionMode, "bypassPermissions");
    assert.isFalse(uncapped.installPermissionCallback);

    const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
      mcpSession: {
        environmentId: EnvironmentId.make("environment:hard-cap-allowlist"),
        threadId: ThreadId.make("thread:hard-cap-allowlist"),
        providerSessionId: "mcp-session:hard-cap-allowlist",
        providerInstanceId: ProviderInstanceId.make("ClaudeCatz"),
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer hard-cap-token",
        browserToolsAvailable: false,
      },
      readOnlySandbox: false,
      ...(capped.allowedTools === undefined ? {} : { allowedTools: capped.allowedTools }),
    });
    assert.deepEqual(overrides.allowedTools, [ClaudeAdapterV2.CLAUDE_T3_MCP_TOOL_WILDCARD]);
  });

  it("makes an ACP child ask before edits and MCP tool calls, then declines the edit", () => {
    const capped = policyFor(true);
    assert.equal(acpPermissionDisposition(capped, acpPermission("edit")), "ask");
    assert.equal(acpPermissionDisposition(capped, acpPermission("execute")), "ask");
    assert.equal(acpMcpToolApprovalElicitationDisposition(capped, mcpToolApproval), "ask");
    // The edit becomes a pending file-change request, which T3 declines.
    assert.isTrue(
      shouldAutoDeclineRuntimeRequest(cap, {
        kind: "file-change",
        status: "pending",
        responseCapability: { type: "message" },
      }),
    );

    const uncapped = policyFor(false);
    assert.equal(acpPermissionDisposition(uncapped, acpPermission("edit")), "allow");
    assert.equal(acpMcpToolApprovalElicitationDisposition(uncapped, mcpToolApproval), "allow");
  });
});
