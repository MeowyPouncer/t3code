// FORK: composer assist, after OpenCues: a draft that ends with " _" is rewritten or filled in, and
// a pause in typing brings cues (contradictions, typos, better sentences, clarifying questions).
// The client sends the draft as text with each file, skill or attachment chip replaced by a ⟦n⟧
// marker; the server never returns text that drops one.
import * as Schema from "effect/Schema";

import { ProjectId, ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const COMPOSER_ASSIST_MAX_DRAFT_CHARS = 40_000;

export const ComposerAssistCueKind = Schema.Literals([
  "contradiction",
  "spelling",
  "sentence",
  "ask",
]);
export type ComposerAssistCueKind = typeof ComposerAssistCueKind.Type;

export const ComposerAssistRequest = Schema.Struct({
  /** The thread the draft continues: its decisions and preferred account in automatic mode. */
  threadId: Schema.optional(ThreadId),
  /** Whose AGENTS.md rules apply when the draft starts a new thread. */
  projectId: Schema.optional(ProjectId),
  /** The provider instance the composer sends with, to pick an account in automatic mode. */
  instanceId: Schema.optional(ProviderInstanceId),
  text: Schema.String.check(Schema.isMaxLength(COMPOSER_ASSIST_MAX_DRAFT_CHARS)),
});
export type ComposerAssistRequest = typeof ComposerAssistRequest.Type;

/** `rewrite` replaces the whole draft; `fill` replaces only the trailing "_". */
export const ComposerAssistBlankResult = Schema.Union([
  Schema.TaggedStruct("rewrite", { text: Schema.String }),
  Schema.TaggedStruct("fill", { text: Schema.String }),
  Schema.TaggedStruct("none", { reason: Schema.optional(Schema.String) }),
]);
export type ComposerAssistBlankResult = typeof ComposerAssistBlankResult.Type;

/** A span of the request text, in UTF-16 offsets, with what to say and what it could become. */
export const ComposerAssistCue = Schema.Struct({
  kind: ComposerAssistCueKind,
  start: Schema.Int,
  end: Schema.Int,
  note: Schema.String,
  alternatives: Schema.Array(Schema.String),
});
export type ComposerAssistCue = typeof ComposerAssistCue.Type;

export const ComposerAssistCuesResult = Schema.Struct({
  cues: Schema.Array(ComposerAssistCue),
  /** The auditor's rewrite of the whole draft, when the auditor is on and found something. */
  audit: Schema.optional(Schema.String),
});
export type ComposerAssistCuesResult = typeof ComposerAssistCuesResult.Type;

export class ComposerAssistError extends Schema.TaggedError<ComposerAssistError>()(
  "ComposerAssistError",
  {
    operation: Schema.Literals(["blank", "cues"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/** What the last request of one kind did. */
export const ComposerAssistActivity = Schema.Struct({
  operation: Schema.Literals(["blank", "cues"]),
  ok: Schema.Boolean,
  durationMs: Schema.Int,
  at: Schema.String,
  /** Why it failed. */
  detail: Schema.optional(Schema.String),
});
export type ComposerAssistActivity = typeof ComposerAssistActivity.Type;

const ComposerAssistCounts = Schema.Struct({ requests: Schema.Int, failures: Schema.Int });

/** What composer assist has done since the server started, and who would answer a draft now. */
export const ComposerAssistStatus = Schema.Struct({
  /** The model in use; the alias, never empty. */
  model: Schema.String,
  /** The provider account that answers a draft with no thread; null when none can. */
  account: Schema.NullOr(Schema.Struct({ instanceId: ProviderInstanceId, label: Schema.String })),
  /** Automatic account selection; a thread's Claude account takes precedence when available. */
  followsThread: Schema.Boolean,
  /** Cues wait because that account is near a usage limit; a blank still runs. */
  cuesPaused: Schema.Boolean,
  blanks: ComposerAssistCounts,
  cues: ComposerAssistCounts,
  /** The newest requests that asked the model, newest first. */
  recent: Schema.Array(ComposerAssistActivity),
  since: Schema.String,
  /** The rules contradiction cues check the asked-for project's drafts against. */
  projectRules: Schema.optional(
    Schema.Struct({
      /** AGENTS.md or CLAUDE.md, whichever the rules come from; null when the project has neither. */
      fileName: Schema.NullOr(Schema.String),
      /** Null: this version of the file was not read yet. */
      rules: Schema.NullOr(Schema.Array(Schema.String)),
    }),
  ),
});
export type ComposerAssistStatus = typeof ComposerAssistStatus.Type;

export const ComposerAssistStatusRequest = Schema.Struct({
  /** Include this project's rules. */
  projectId: Schema.optional(ProjectId),
  /** Read the project's rules file now when its rules were never worked out; runs the selected model. */
  readRules: Schema.optional(Schema.Boolean),
});
export type ComposerAssistStatusRequest = typeof ComposerAssistStatusRequest.Type;

/**
 * Composer assist is one RPC with an `operation`, not one per operation: the WS RPC group is at the
 * size where a further method overflows TypeScript's inference and types the server's layers as `any`.
 */
export const ComposerAssistRunRequest = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("blank"), ...ComposerAssistRequest.fields }),
  Schema.Struct({ operation: Schema.Literal("cues"), ...ComposerAssistRequest.fields }),
  Schema.Struct({ operation: Schema.Literal("status"), ...ComposerAssistStatusRequest.fields }),
]);
export type ComposerAssistRunRequest = typeof ComposerAssistRunRequest.Type;

export const ComposerAssistRunResult = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("blank"), blank: ComposerAssistBlankResult }),
  Schema.Struct({ operation: Schema.Literal("cues"), cues: ComposerAssistCuesResult }),
  Schema.Struct({ operation: Schema.Literal("status"), status: ComposerAssistStatus }),
]);
export type ComposerAssistRunResult = typeof ComposerAssistRunResult.Type;
