import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { IsoDateTime, ProjectId, TodoBoardReadError, TodoBoardSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as TodoBoard from "./TodoBoard.ts";

const projectId = ProjectId.make("board-project");
const snapshot = (root: string) => ({
  root,
  url: "http://127.0.0.1:8021/",
  generated_at: "2026-10-07 06:00 UTC",
  generated_ts: 1_791_352_800,
  cards: [],
  backlog_cards: [],
  area_order: ["core"],
  counts: { total: 0, ready: 0, in_progress: 0, blocked: 0, backlog: 0, backlog_notes: 0 },
});
const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(TodoBoardSnapshot));

const withBoard = Effect.fnUntraced(function* (
  options: {
    missing?: "script" | "todo";
    missingProject?: boolean;
    output?: (root: string) => string;
    exitCode?: number;
    timedOut?: boolean;
    stdoutTruncated?: boolean;
    stdoutInvalidUtf8?: boolean;
  },
  check: (
    board: TodoBoard.TodoBoard["Service"],
    calls: ProcessRunner.ProcessRunInput[],
    root: string,
  ) => Effect.Effect<void, TodoBoardReadError>,
) {
  const files = yield* FileSystem.FileSystem;
  const root = yield* files.makeTempDirectoryScoped({ prefix: "t3-todo-board-test-" });
  yield* files.makeDirectory(`${root}/scripts/dev/todo-board`, { recursive: true });
  if (options.missing !== "script")
    yield* files.writeFileString(`${root}/scripts/dev/todo-board/todo-board.py`, "# parser");
  if (options.missing !== "todo") yield* files.writeFileString(`${root}/TODO.md`, "# TODO");
  const now = IsoDateTime.make("2026-10-07T06:00:00Z");
  const project = {
    projectId,
    title: "Board",
    workspaceRoot: root,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    autoPull: false,
    faviconPath: null,
    projectIcon: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  const calls: ProcessRunner.ProcessRunInput[] = [];
  const dependencies = Layer.mergeAll(
    Layer.succeed(ProjectStore.ProjectStoreV2, {
      get: (id) =>
        Effect.succeed(
          !options.missingProject && id === projectId ? Option.some(project) : Option.none(),
        ),
      apply: () => Effect.void,
      list: () => Effect.succeed([]),
      findActiveByWorkspaceRoot: () => Effect.succeed(Option.none()),
      getShell: () => Effect.succeed(Option.none()),
      listShells: () => Effect.succeed([]),
    }),
    Layer.succeed(ProcessRunner.ProcessRunner, {
      run: (input) =>
        Effect.sync(() => {
          calls.push(input);
          return {
            stdout: options.output?.(root) ?? encodeSnapshot(snapshot(root)),
            stderr: "private process output",
            code: (options.exitCode ?? 0) as ChildProcessSpawner.ExitCode,
            timedOut: options.timedOut ?? false,
            stdoutTruncated: options.stdoutTruncated ?? false,
            stderrTruncated: false,
            stdoutInvalidUtf8: options.stdoutInvalidUtf8 ?? false,
            stderrInvalidUtf8: false,
          };
        }),
    }),
  );
  yield* Effect.gen(function* () {
    const board = yield* TodoBoard.TodoBoard;
    yield* check(board, calls, root);
  }).pipe(Effect.provide(TodoBoard.layer.pipe(Layer.provide(dependencies))));
});

it.layer(NodeServices.layer)("TodoBoard", (it) => {
  it.effect(
    "reads the registered integration root without starting the external module or fetching refs",
    () =>
      withBoard({}, (board, calls, root) =>
        Effect.gen(function* () {
          const result = yield* board.read({ projectId });
          expect(result).toEqual({ available: true, snapshot: snapshot(root) });
          expect(calls).toHaveLength(1);
          expect(calls[0]).toMatchObject({
            command: "python3",
            args: [`${root}/scripts/dev/todo-board/todo-board.py`, "--root", root, "dump"],
            cwd: root,
            env: {
              TODO_BOARD_FETCH_EVERY: "0",
              PYTHONDONTWRITEBYTECODE: "1",
              GIT_OPTIONAL_LOCKS: "0",
            },
            outputMode: "error",
          });
        }),
      ),
  );

  it.effect.each(["script", "todo"] as const)(
    "does not execute a project with a missing %s",
    (missing) =>
      withBoard({ missing }, (board, calls) =>
        Effect.gen(function* () {
          expect(yield* board.read({ projectId })).toEqual({ available: false });
          expect(calls).toEqual([]);
        }),
      ),
  );

  it.effect("does not execute unregistered or deleted projects", () =>
    withBoard({ missingProject: true }, (board, calls) =>
      Effect.gen(function* () {
        expect(yield* board.read({ projectId }).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "TodoBoardReadError", operation: "project" },
        });
        expect(calls).toEqual([]);
      }),
    ),
  );

  describe("parser failures", () => {
    it.effect.each([
      ["a failed parser", { exitCode: 1 }, "parser"],
      ["a timed-out parser", { timedOut: true }, "parser"],
      ["a truncated snapshot", { stdoutTruncated: true }, "parser"],
      ["invalid UTF-8", { stdoutInvalidUtf8: true }, "parser"],
      ["incomplete JSON", { output: (): string => "{" }, "decode"],
      [
        "another workspace",
        { output: (): string => encodeSnapshot(snapshot("/another/project")) },
        "decode",
      ],
    ] as const)("rejects %s", ([_name, options, operation]) =>
      withBoard(options, (board) =>
        Effect.gen(function* () {
          const result = yield* board.read({ projectId }).pipe(Effect.result);
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "TodoBoardReadError", operation },
          });
          if (Result.isFailure(result))
            expect(result.failure.message).not.toContain("private process output");
        }),
      ),
    );
  });
});
