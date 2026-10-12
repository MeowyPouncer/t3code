import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2ProviderThread,
  ProviderInstanceId,
  ProviderReportedPermissions,
} from "@t3tools/contracts";

/** A saved report belongs to the active native thread and the selected instance. */
export function threadReportedPermissions(
  projection:
    | {
        readonly thread: Pick<
          OrchestrationV2ThreadProjection["thread"],
          "id" | "activeProviderThreadId"
        >;
        readonly providerThreads: ReadonlyArray<
          Pick<
            OrchestrationV2ProviderThread,
            "id" | "driver" | "providerInstanceId" | "appThreadId" | "nativeMetadata"
          >
        >;
      }
    | null
    | undefined,
  instanceId: ProviderInstanceId | null | undefined,
): ProviderReportedPermissions | null {
  if (projection == null || instanceId == null) return null;
  const providerThread = projection.providerThreads.find(
    (thread) =>
      thread.id === projection.thread.activeProviderThreadId &&
      thread.providerInstanceId === instanceId &&
      thread.appThreadId === projection.thread.id,
  );
  const permissions = providerThread?.nativeMetadata?.permissions;
  return permissions?.source === providerThread?.driver ? (permissions ?? null) : null;
}

/** Describe core settings without implying that native command rules are bypassed. */
export function describeReportedPermissions(permissions: ProviderReportedPermissions | null) {
  if (permissions === null) {
    return {
      label: "Permissions not reported",
      detail: "The provider has not reported its permissions. The selected mode is a request.",
      approvalNotice: null,
    };
  }
  const sandbox = {
    "danger-full-access": "Sandbox off",
    "workspace-write": "Workspace writes",
    "read-only": "Read-only files",
    "external-sandbox": "External sandbox",
  }[permissions.sandbox];
  const policy = permissions.approvalPolicy;
  const promptsOff = policy === "never";
  const rulesOff = promptsOff || (typeof policy === "object" && !policy.granular.rules);
  const approvals = promptsOff
    ? "prompts off"
    : permissions.approvalsReviewer !== "user"
      ? "automatic review"
      : typeof policy === "object"
        ? "granular approvals"
        : policy === "untrusted"
          ? "untrusted commands ask"
          : policy === "on-failure"
            ? "ask on failure"
            : "ask on request";
  const network = {
    enabled: "enabled",
    restricted: "restricted",
    "not-reported": "not reported",
  }[permissions.networkAccess];
  const approvalDetail =
    typeof policy === "string"
      ? `approval policy ${policy}`
      : Object.entries(policy.granular)
          .map(([name, enabled]) => `${name.replaceAll("_", " ")} ${enabled ? "on" : "off"}`)
          .join("; ");
  return {
    label: `${sandbox} · ${approvals}`,
    detail: `Last reported by Codex: ${sandbox}; network ${network}; ${approvalDetail}; reviewer ${permissions.approvalsReviewer}. Command rules and external restrictions still apply.`,
    approvalNotice: rulesOff
      ? "Commands that require approval under a rule are blocked because rule approvals are disabled."
      : null,
  };
}
