import {
  ChatImageAttachment,
  ChatFileAttachment,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "./chatAttachment.ts";
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ProviderApprovalPolicy = Schema.Literals([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
]);
export type ProviderApprovalPolicy = typeof ProviderApprovalPolicy.Type;

export const ProviderSandboxMode = Schema.Literals([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
export type ProviderSandboxMode = typeof ProviderSandboxMode.Type;

/** Native core permissions, separate from T3's requested preset and command rules. */
export const ProviderReportedPermissions = Schema.Struct({
  source: Schema.Literal("codex"),
  reportedAt: IsoDateTime,
  sandbox: Schema.Literals([
    "read-only",
    "workspace-write",
    "danger-full-access",
    "external-sandbox",
  ]),
  networkAccess: Schema.Literals(["enabled", "restricted", "not-reported"]),
  approvalPolicy: Schema.Union([
    ProviderApprovalPolicy,
    Schema.Struct({
      granular: Schema.Struct({
        rules: Schema.Boolean,
        sandbox_approval: Schema.Boolean,
        mcp_elicitations: Schema.Boolean,
        skill_approval: Schema.optional(Schema.Boolean),
        request_permissions: Schema.optional(Schema.Boolean),
      }),
    }),
  ]),
  approvalsReviewer: Schema.Literals(["user", "auto_review", "guardian_subagent"]),
});
export type ProviderReportedPermissions = typeof ProviderReportedPermissions.Type;

export const RuntimeMode = Schema.Literals([
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
]);
export type RuntimeMode = typeof RuntimeMode.Type;
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

export const ProviderInteractionMode = Schema.Literals(["default", "plan"]);
export type ProviderInteractionMode = typeof ProviderInteractionMode.Type;
export const DEFAULT_PROVIDER_INTERACTION_MODE: ProviderInteractionMode = "default";

export const ProviderRequestKind = Schema.Literals([
  "command",
  "file-read",
  "file-change",
  "mcp-elicitation",
  "permission",
]);
export type ProviderRequestKind = typeof ProviderRequestKind.Type;

export const AssistantDeliveryMode = Schema.Literals(["buffered", "streaming"]);
export type AssistantDeliveryMode = typeof AssistantDeliveryMode.Type;

export const ProviderApprovalDecision = Schema.Literals([
  "accept",
  "acceptForSession",
  "acceptAlways",
  "decline",
  "cancel",
]);
export type ProviderApprovalDecision = typeof ProviderApprovalDecision.Type;

export const ProviderApprovalOption = Schema.Struct({
  decision: ProviderApprovalDecision,
  label: TrimmedNonEmptyString,
  /** Provider-supplied caution shown next to the option, such as a prompt injection warning. */
  warning: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderApprovalOption = typeof ProviderApprovalOption.Type;

export const ProviderUserInputAnswers = Schema.Record(Schema.String, Schema.Unknown);
export type ProviderUserInputAnswers = typeof ProviderUserInputAnswers.Type;

export const UserInputAttachments = Schema.Record(
  Schema.String,
  Schema.Array(Schema.Union([ChatImageAttachment, ChatFileAttachment])).pipe(
    Schema.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
);
export type UserInputAttachments = typeof UserInputAttachments.Type;

export const UserInputAttachmentAnswerPayload = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  questionTextById: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  answers: ProviderUserInputAnswers,
  attachmentsByQuestionId: UserInputAttachments,
});
export type UserInputAttachmentAnswerPayload = typeof UserInputAttachmentAnswerPayload.Type;
