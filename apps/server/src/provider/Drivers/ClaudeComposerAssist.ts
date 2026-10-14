// FORK: composer assist on Claude Haiku with the instance's own `claude` login (the tasks come from
// composerAssist/ComposerAssistService.ts). Claude Code takes about a second to start, so a process
// is started ahead and the next task finds it ready. Each process takes one task over stream-json
// and exits: a draft never shares a model context with another thread's draft.
import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import type { ProviderComposerAssist } from "@t3tools/provider-core/server/driver";
import { ProviderComposerAssistError } from "@t3tools/provider-core/server/errors";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import type * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** The fastest Claude; the alias follows Anthropic's newest Haiku. */
const COMPOSER_ASSIST_MODEL = "haiku";
/** A process started ahead and left unused this long is stopped; the next task starts cold. */
const WARM_IDLE_MS = 3 * 60_000;
/** Near a usage limit, what is left goes to the agents' own work. */
const NEAR_LIMIT_PERCENT = 90;
const MAX_STDERR_CHARS = 2_000;

/**
 * `--safe-mode` leaves out CLAUDE.md, skills, plugins, hooks and MCP servers while the login keeps
 * working (`--bare` would refuse the subscription login). No tools, no saved session.
 */
export function claudeComposerAssistArgs(system: string): ReadonlyArray<string> {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    COMPOSER_ASSIST_MODEL,
    "--system-prompt",
    system,
    "--safe-mode",
    "--settings",
    JSON.stringify({ disableAllHooks: true, alwaysThinkingEnabled: false }),
    "--tools",
    "",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
  ];
}

/** The user message Claude Code reads from stdin in stream-json mode. */
export function claudeComposerAssistMessage(task: string): string {
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: task }] },
  })}\n`;
}

/** The answer in one stream-json line, or the failure it reports; undefined for other lines. */
export function readClaudeComposerAssistLine(
  line: string,
):
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly detail: string }
  | undefined {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof record !== "object" || record === null) return undefined;
  const value = record as Record<string, unknown>;
  if (value.type !== "result") return undefined;
  const text = typeof value.result === "string" ? value.result : "";
  if (value.subtype === "success" && value.is_error !== true) return { ok: true, text };
  return {
    ok: false,
    detail: text.trim().length > 0 ? text.trim() : `Claude stopped (${String(value.subtype)}).`,
  };
}

export function claudeNearUsageLimit(
  usageLimits: ServerProviderUsageLimits | undefined,
  nowMs: number,
): boolean {
  return (usageLimits?.windows ?? []).some(
    (window) =>
      window.usedPercent >= NEAR_LIMIT_PERCENT &&
      (window.resetsAt === undefined || Date.parse(window.resetsAt) > nowMs),
  );
}

interface StartedClaude {
  readonly system: string;
  readonly scope: Scope.Closeable;
  readonly stdin: Queue.Queue<Uint8Array, Cause.Done>;
  readonly reply: Deferred.Deferred<string, ProviderComposerAssistError>;
  readonly startedAtMs: number;
}

export const makeClaudeComposerAssist = Effect.fn("makeClaudeComposerAssist")(function* (input: {
  readonly binaryPath: string;
  /** The instance's environment, CLAUDE_CONFIG_DIR included. */
  readonly environment: NodeJS.ProcessEnv;
  readonly usageLimits: Effect.Effect<ServerProviderUsageLimits | undefined>;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  // The instance's scope: removing or reconfiguring the instance stops its processes.
  const instanceScope = yield* Effect.scope;
  // An empty directory, so no project configuration is picked up from the working directory.
  const workingDirectory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-composer-assist-",
  });
  const environment = {
    ...input.environment,
    CLAUDE_CODE_DISABLE_THINKING: "1",
    MAX_THINKING_TOKENS: "0",
  };
  const lock = yield* Semaphore.make(1);
  let ready: StartedClaude | null = null;
  let lastUsedAtMs = 0;

  const fail = (detail: string, cause?: unknown) =>
    new ProviderComposerAssistError({ detail, ...(cause === undefined ? {} : { cause }) });

  const start = (system: string) =>
    Effect.gen(function* () {
      const scope = yield* Scope.fork(instanceScope);
      const stdin = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      const reply = yield* Deferred.make<string, ProviderComposerAssistError>();
      const spawnCommand = yield* resolveSpawnCommand(
        input.binaryPath || "claude",
        [...claudeComposerAssistArgs(system)],
        { env: environment },
      );
      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            env: environment,
            cwd: workingDirectory,
            shell: spawnCommand.shell,
            stdin: { stream: Stream.fromQueue(stdin) },
          }),
        )
        .pipe(Scope.provide(scope));
      let stderr = "";
      yield* child.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            if (stderr.length < MAX_STDERR_CHARS) stderr += chunk;
          }),
        ),
        Effect.ignore,
        Effect.forkIn(scope),
      );
      yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) => {
          const read = readClaudeComposerAssistLine(line);
          if (read === undefined) return Effect.void;
          return read.ok
            ? Deferred.succeed(reply, read.text)
            : Deferred.fail(reply, fail(read.detail));
        }),
        // Exiting without a result line: say why if Claude Code did.
        Effect.ensuring(
          Effect.suspend(() =>
            Deferred.fail(
              reply,
              fail(
                stderr.trim().length > 0
                  ? `Claude exited without an answer: ${stderr.trim().slice(0, 500)}`
                  : "Claude exited without an answer.",
              ),
            ),
          ),
        ),
        Effect.ignore,
        Effect.forkIn(scope),
      );
      return {
        system,
        scope,
        stdin,
        reply,
        startedAtMs: yield* Clock.currentTimeMillis,
      } satisfies StartedClaude;
    }).pipe(Effect.mapError((cause) => fail("Could not start Claude for composer assist.", cause)));

  const stop = (process: StartedClaude) => Scope.close(process.scope, Exit.void);

  /** Takes the process started ahead when it fits, and starts the next one in the background. */
  const take = (system: string) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        let taken: StartedClaude | null = null;
        if (ready !== null) {
          const fresh = ready.system === system && nowMs - lastUsedAtMs < WARM_IDLE_MS;
          if (fresh && Deferred.isDoneUnsafe(ready.reply) === false) taken = ready;
          else yield* stop(ready);
          ready = null;
        }
        lastUsedAtMs = nowMs;
        const process = taken ?? (yield* start(system));
        ready = yield* start(system).pipe(Effect.orElseSucceed(() => null));
        return process;
      }),
    );

  const complete: ProviderComposerAssist["complete"] = ({ system, task, timeoutMs }) =>
    Effect.gen(function* () {
      const process = yield* take(system);
      return yield* Effect.gen(function* () {
        yield* Queue.offer(
          process.stdin,
          new TextEncoder().encode(claudeComposerAssistMessage(task)),
        );
        yield* Queue.end(process.stdin);
        return yield* Deferred.await(process.reply).pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(timeoutMs),
            orElse: () => Effect.fail(fail("Claude took too long to answer.")),
          }),
        );
      }).pipe(Effect.ensuring(stop(process)));
    });

  // A process started ahead and never used is stopped once it has waited too long.
  yield* Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        if (ready !== null && nowMs - lastUsedAtMs >= WARM_IDLE_MS) {
          yield* stop(ready);
          ready = null;
        }
      }),
    );
  }).pipe(
    Effect.delay(Duration.millis(WARM_IDLE_MS / 3)),
    Effect.forever,
    Effect.forkIn(instanceScope),
  );

  return {
    complete,
    roomForBackground: Effect.all([input.usageLimits, Clock.currentTimeMillis]).pipe(
      Effect.map(([usageLimits, nowMs]) => !claudeNearUsageLimit(usageLimits, nowMs)),
    ),
  } satisfies ProviderComposerAssist;
});
