import * as Schema from "effect/Schema";
import { ProjectId } from "./baseSchemas.ts";

const RelativeBoardPath = Schema.String.check(
  Schema.isPattern(/^(?![/\\])(?![A-Za-z]:)(?!.*(?:^|[/\\])\.\.(?:[/\\]|$))[^\0]+$/),
);

export const TodoBoardCard = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["card", "note"]),
  title: Schema.String,
  brief: Schema.String,
  prompt: Schema.String,
  path: RelativeBoardPath,
  line: Schema.optional(Schema.Number),
  status: Schema.String,
  pri: Schema.NullOr(Schema.String),
  size: Schema.NullOr(Schema.String),
  area: Schema.String,
  pack: Schema.String,
  source: Schema.String,
  ord: Schema.Number,
  created: Schema.NullOr(Schema.Number),
  modified: Schema.NullOr(Schema.Number),
  stale: Schema.Boolean,
  origin_only: Schema.Boolean,
  origin_status: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(
    Schema.Struct({
      branch: Schema.String,
      tip_status: Schema.optional(Schema.NullOr(Schema.String)),
      ahead: Schema.optional(Schema.NullOr(Schema.Number)),
      behind: Schema.optional(Schema.NullOr(Schema.Number)),
      dirty: Schema.optional(Schema.NullOr(Schema.Number)),
    }),
  ),
});
export type TodoBoardCard = typeof TodoBoardCard.Type;

export const TodoBoardSnapshot = Schema.Struct({
  root: Schema.String,
  url: Schema.String,
  generated_at: Schema.String,
  generated_ts: Schema.Number,
  cards: Schema.Array(TodoBoardCard),
  backlog_cards: Schema.Array(TodoBoardCard),
  area_order: Schema.Array(Schema.String),
  counts: Schema.Struct({
    total: Schema.Number,
    ready: Schema.Number,
    in_progress: Schema.Number,
    blocked: Schema.Number,
    backlog: Schema.Number,
    backlog_notes: Schema.Number,
  }),
});
export type TodoBoardSnapshot = typeof TodoBoardSnapshot.Type;

export const TodoBoardReadInput = Schema.Struct({ projectId: ProjectId });
export type TodoBoardReadInput = typeof TodoBoardReadInput.Type;

export const TodoBoardReadResult = Schema.Union([
  Schema.Struct({ available: Schema.Literal(true), snapshot: TodoBoardSnapshot }),
  Schema.Struct({ available: Schema.Literal(false) }),
]);
export type TodoBoardReadResult = typeof TodoBoardReadResult.Type;

export class TodoBoardReadError extends Schema.TaggedError<TodoBoardReadError>()(
  "TodoBoardReadError",
  {
    projectId: ProjectId,
    operation: Schema.Literals(["project", "files", "parser", "decode"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "The TODO board could not be read.";
  }
}
