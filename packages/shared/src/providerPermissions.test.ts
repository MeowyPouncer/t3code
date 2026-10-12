import { expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderThreadId,
  ThreadId,
  type ProviderReportedPermissions,
} from "@t3tools/contracts";
import { describeReportedPermissions, threadReportedPermissions } from "./providerPermissions.ts";

const permissions: ProviderReportedPermissions = {
  source: "codex",
  reportedAt: "2026-10-12T09:00:00.000Z",
  sandbox: "danger-full-access",
  networkAccess: "enabled",
  approvalPolicy: "never",
  approvalsReviewer: "user",
};
const instanceId = ProviderInstanceId.make("codex");
const threadId = ThreadId.make("thread");
const providerThreadId = ProviderThreadId.make("native-thread");
const projection = {
  thread: { id: threadId, activeProviderThreadId: providerThreadId },
  providerThreads: [
    {
      id: providerThreadId,
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: instanceId,
      appThreadId: threadId,
      nativeMetadata: { permissions },
    },
  ],
};

it("keeps native reports scoped to the selected instance and active app thread", () => {
  expect(threadReportedPermissions(projection, instanceId)).toEqual(permissions);
  expect(threadReportedPermissions(projection, ProviderInstanceId.make("codex-other"))).toBeNull();
  expect(
    threadReportedPermissions(
      { ...projection, thread: { ...projection.thread, activeProviderThreadId: null } },
      instanceId,
    ),
  ).toBeNull();
  expect(
    threadReportedPermissions(
      {
        ...projection,
        providerThreads: [
          { ...projection.providerThreads[0]!, driver: ProviderDriverKind.make("claude") },
        ],
      },
      instanceId,
    ),
  ).toBeNull();
  expect(
    threadReportedPermissions(
      {
        ...projection,
        providerThreads: [
          { ...projection.providerThreads[0]!, appThreadId: ThreadId.make("another-thread") },
        ],
      },
      instanceId,
    ),
  ).toBeNull();
});

it("does not derive effective access from the full-access preset or a missing report", () => {
  expect(threadReportedPermissions(null, instanceId)).toBeNull();
  expect(
    threadReportedPermissions(
      {
        ...projection,
        providerThreads: [{ ...projection.providerThreads[0]!, nativeMetadata: null }],
      },
      instanceId,
    ),
  ).toBeNull();
  const description = describeReportedPermissions(null);
  expect(description.label).toBe("Permissions not reported");
  expect(description.approvalNotice).toBeNull();
});

it("explains blocked rule approvals while preserving sandbox and reviewer facts", () => {
  const description = describeReportedPermissions(permissions);
  expect(description.label).toBe("Sandbox off · prompts off");
  expect(description.approvalNotice).toContain("blocked");
  const supervised = describeReportedPermissions({
    ...permissions,
    sandbox: "read-only",
    approvalPolicy: "on-request",
  });
  expect(supervised.label).toBe("Read-only files · ask on request");
  expect(supervised.approvalNotice).toBeNull();
  const auto = describeReportedPermissions({
    ...permissions,
    approvalPolicy: "on-request",
    approvalsReviewer: "guardian_subagent",
  });
  expect(auto.label).toContain("automatic review");
});

it("exposes granular rule conflicts without claiming every approval is disabled", () => {
  const description = describeReportedPermissions({
    ...permissions,
    approvalPolicy: { granular: { rules: false, sandbox_approval: true, mcp_elicitations: true } },
  });
  expect(description.label).toContain("granular approvals");
  expect(description.label).not.toContain("prompts off");
  expect(description.approvalNotice).toContain("rule approvals are disabled");
});
