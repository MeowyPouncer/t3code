import type {
  OrchestrationV2RuntimeRequest,
  ProviderInstanceCappedCapability,
  ProviderInstanceConfigMap,
  ProviderInstanceHardCap,
  ProviderInstanceId,
  RuntimeMode,
} from "@t3tools/contracts";

import type { McpCapability } from "../mcp/McpInvocationContext.ts";

/**
 * A provider instance's hard cap (`providerInstances.<id>.hardCap` in server
 * settings): the most any thread on that instance may be granted, whoever
 * starts it and whatever its parent's own mode. A delegation is otherwise
 * capped only by its parent, so a full-access parent could hand a weaker
 * agent full access too. Absent fields cap nothing.
 */

const RUNTIME_MODE_RANK: Record<RuntimeMode, number> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};

export function readProviderInstanceHardCap(
  providerInstances: ProviderInstanceConfigMap,
  instanceId: ProviderInstanceId,
): ProviderInstanceHardCap | undefined {
  return providerInstances[instanceId]?.hardCap;
}

/**
 * The broadest runtime mode the cap allows. Declining file changes needs the
 * provider to ask before edits, which only Supervised does, so it caps the
 * mode at `approval-required` as well.
 */
export function hardCapRuntimeModeCeiling(
  cap: ProviderInstanceHardCap | undefined,
): RuntimeMode | undefined {
  if (cap === undefined) return undefined;
  if (cap.declineFileChanges === true) return "approval-required";
  return cap.maxRuntimeMode;
}

export function clampRuntimeModeToHardCap(
  runtimeMode: RuntimeMode,
  cap: ProviderInstanceHardCap | undefined,
): RuntimeMode {
  const ceiling = hardCapRuntimeModeCeiling(cap);
  return ceiling !== undefined && RUNTIME_MODE_RANK[runtimeMode] > RUNTIME_MODE_RANK[ceiling]
    ? ceiling
    : runtimeMode;
}

export type HardCappedChildRuntimeMode =
  | { readonly _tag: "allowed"; readonly runtimeMode: RuntimeMode }
  | { readonly _tag: "refused"; readonly runtimeMode: RuntimeMode; readonly ceiling: RuntimeMode };

/**
 * The mode a thread an agent starts on a capped instance gets. `resolved` is
 * the mode after the parent's own ceiling. An inherited mode above the cap is
 * lowered to it; a mode the caller asked for by name is refused, as one above
 * the parent's mode is, so the caller learns the child will not run as asked.
 */
export function resolveHardCappedChildRuntimeMode(input: {
  readonly resolved: RuntimeMode;
  readonly explicit: boolean;
  readonly cap: ProviderInstanceHardCap | undefined;
}): HardCappedChildRuntimeMode {
  const ceiling = hardCapRuntimeModeCeiling(input.cap);
  if (ceiling === undefined || RUNTIME_MODE_RANK[input.resolved] <= RUNTIME_MODE_RANK[ceiling]) {
    return { _tag: "allowed", runtimeMode: input.resolved };
  }
  return input.explicit
    ? { _tag: "refused", runtimeMode: input.resolved, ceiling }
    : { _tag: "allowed", runtimeMode: ceiling };
}

// Typed as the server's capabilities, so a contract value the server does not
// know fails to compile here.
export function hardCapWithheldCapabilities(
  cap: ProviderInstanceHardCap | undefined,
): ReadonlyArray<McpCapability> {
  const withheld: ReadonlyArray<ProviderInstanceCappedCapability> = cap?.withheldCapabilities ?? [];
  return withheld;
}

/** Whether T3 declines this runtime request for the user, without asking. */
export function shouldAutoDeclineRuntimeRequest(
  cap: ProviderInstanceHardCap | undefined,
  request: Pick<OrchestrationV2RuntimeRequest, "kind" | "status" | "responseCapability">,
): boolean {
  return (
    cap?.declineFileChanges === true &&
    request.kind === "file-change" &&
    request.status === "pending" &&
    request.responseCapability.type !== "not_resumable"
  );
}
