import {
  TodoBoardReadError,
  TodoBoardSnapshot,
  type TodoBoardReadInput,
  type TodoBoardReadResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProcessRunner from "../processRunner.ts";

export class TodoBoard extends Context.Service<
  TodoBoard,
  {
    readonly read: (
      input: TodoBoardReadInput,
    ) => Effect.Effect<TodoBoardReadResult, TodoBoardReadError>;
  }
>()("t3/project/TodoBoard") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const files = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const permits = yield* Semaphore.make(2);
  const decode = Schema.decodeEffect(Schema.fromJsonString(TodoBoardSnapshot));

  const read = Effect.fn("TodoBoard.read")(function* (input: TodoBoardReadInput) {
    const fail = (operation: TodoBoardReadError["operation"], cause: unknown) =>
      new TodoBoardReadError({ projectId: input.projectId, operation, cause });
    const project = yield* projects
      .get(input.projectId)
      .pipe(Effect.mapError((cause) => fail("project", cause)));
    if (Option.isNone(project)) return yield* fail("project", "Project not found");
    const root = project.value.workspaceRoot;
    const script = path.join(root, "scripts", "dev", "todo-board", "todo-board.py");
    const present = yield* Effect.all([
      files.exists(script),
      files.exists(path.join(root, "TODO.md")),
    ]).pipe(Effect.mapError((cause) => fail("files", cause)));
    if (!present.every(Boolean)) return { available: false } as const;

    // The same parser serves the standalone module. Never launch its daemon or
    // fetch/merge Git refs as a side effect of opening a native Tasks surface.
    const output = yield* runner
      .run({
        command: "python3",
        args: [script, "--root", root, "dump"],
        cwd: root,
        env: { TODO_BOARD_FETCH_EVERY: "0", PYTHONDONTWRITEBYTECODE: "1", GIT_OPTIONAL_LOCKS: "0" },
        timeout: "30 seconds",
        maxOutputBytes: 4_000_000,
        outputMode: "error",
      })
      .pipe(Effect.mapError((cause) => fail("parser", cause)));
    if (
      output.code !== 0 ||
      output.timedOut ||
      output.stdoutTruncated ||
      output.stdoutInvalidUtf8
    ) {
      return yield* fail("parser", "Parser did not produce a complete snapshot");
    }
    const snapshot = yield* decode(output.stdout).pipe(
      Effect.mapError((cause) => fail("decode", cause)),
    );
    if (path.normalize(snapshot.root) !== path.normalize(root)) {
      return yield* fail("decode", "Parser returned another workspace");
    }
    return { available: true, snapshot } as const;
  }, permits.withPermit);
  return TodoBoard.of({ read });
});

export const layer = Layer.effect(TodoBoard, make);
