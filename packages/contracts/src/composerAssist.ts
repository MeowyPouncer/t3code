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
  /** The thread the draft continues: its decisions and its Claude account. */
  threadId: Schema.optional(ThreadId),
  /** Whose AGENTS.md rules apply when the draft starts a new thread. */
  projectId: Schema.optional(ProjectId),
  /** The provider instance the composer sends with, to pick the matching Claude account. */
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
