import { ProviderReportedPermissions } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Decode only public permission facts. Native responses also contain private
// paths, environment configuration and MCP credentials which must stay here.
const NativeSandbox = Schema.Union([
  Schema.Struct({ type: Schema.Literal("dangerFullAccess") }),
  Schema.Struct({
    type: Schema.Literal("readOnly"),
    networkAccess: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("workspaceWrite"),
    networkAccess: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("externalSandbox"),
    networkAccess: Schema.optional(Schema.Literals(["enabled", "restricted"])),
  }),
]);
const decodeNativePermissions = Schema.decodeUnknownOption(
  Schema.Struct({
    approvalPolicy: ProviderReportedPermissions.fields.approvalPolicy,
    approvalsReviewer: ProviderReportedPermissions.fields.approvalsReviewer,
    sandbox: Schema.optional(NativeSandbox),
    sandboxPolicy: Schema.optional(NativeSandbox),
  }),
);

export function codexReportedPermissions(
  value: unknown,
  reportedAt: string,
): ProviderReportedPermissions | null {
  const decoded = decodeNativePermissions(value);
  if (Option.isNone(decoded)) return null;
  const { approvalPolicy, approvalsReviewer } = decoded.value;
  const sandbox = decoded.value.sandboxPolicy ?? decoded.value.sandbox;
  if (sandbox === undefined) return null;
  const common = { source: "codex" as const, reportedAt, approvalPolicy, approvalsReviewer };
  switch (sandbox.type) {
    case "dangerFullAccess":
      return { ...common, sandbox: "danger-full-access", networkAccess: "enabled" };
    case "externalSandbox":
      return {
        ...common,
        sandbox: "external-sandbox",
        networkAccess: sandbox.networkAccess ?? "not-reported",
      };
    case "readOnly":
    case "workspaceWrite":
      return {
        ...common,
        sandbox: sandbox.type === "readOnly" ? "read-only" : "workspace-write",
        networkAccess:
          sandbox.networkAccess === undefined
            ? "not-reported"
            : sandbox.networkAccess
              ? "enabled"
              : "restricted",
      };
  }
}
