import { expect, it } from "vite-plus/test";
import { codexReportedPermissions } from "./CodexReportedPermissions.ts";

const reportedAt = "2026-10-12T09:00:00.000Z";

it("retains native policy and strips private response fields", () => {
  const result = codexReportedPermissions(
    {
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
      sandbox: { type: "workspaceWrite", networkAccess: false, writableRoots: ["/private/root"] },
      cwd: "/private/workspace",
      config: { mcp_servers: { private: { token: "test-private-value" } } },
    },
    reportedAt,
  );
  expect(result).toEqual({
    source: "codex",
    reportedAt,
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    sandbox: "workspace-write",
    networkAccess: "restricted",
  });
  expect(JSON.stringify(result)).not.toContain("private");
});

it("accepts granular policies from native settings notifications", () => {
  const approvalPolicy = {
    granular: {
      rules: false,
      sandbox_approval: true,
      mcp_elicitations: false,
      request_permissions: true,
      skill_approval: false,
    },
  };
  expect(
    codexReportedPermissions(
      {
        approvalPolicy,
        approvalsReviewer: "guardian_subagent",
        sandboxPolicy: { type: "readOnly" },
      },
      reportedAt,
    ),
  ).toEqual({
    source: "codex",
    reportedAt,
    approvalPolicy,
    approvalsReviewer: "guardian_subagent",
    sandbox: "read-only",
    networkAccess: "not-reported",
  });
});

it("does not invent native settings for missing or unknown reports", () => {
  for (const input of [
    null,
    {},
    { approvalPolicy: "never" },
    { approvalPolicy: "unknown", approvalsReviewer: "user", sandbox: { type: "dangerFullAccess" } },
  ]) {
    expect(codexReportedPermissions(input, reportedAt)).toBeNull();
  }
});

it("keeps external sandbox and network restrictions distinct from full access", () => {
  expect(
    codexReportedPermissions(
      {
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandbox: { type: "externalSandbox", networkAccess: "restricted" },
      },
      reportedAt,
    ),
  ).toMatchObject({ sandbox: "external-sandbox", networkAccess: "restricted" });
});
