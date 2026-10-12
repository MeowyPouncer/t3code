// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  type ModelSelection,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { makeAntigravityAcpRuntime } from "../../provider/acp/AntigravityAcpSupport.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { makeAntigravityAdapterV2 } from "./AntigravityAdapterV2.ts";

/**
 * A provider instance's hard cap reaches a live Antigravity session through
 * each turn's runtime policy: its native permission mode and the file writes
 * T3 serves for the agent.
 */

const layerSession = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

const decodeRequestLine = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.optional(Schema.String),
      params: Schema.optional(
        Schema.Struct({
          configId: Schema.optional(Schema.String),
          value: Schema.optional(Schema.Unknown),
        }),
      ),
    }),
  ),
);

/** The mode sets and prompts the agent received, in order. */
function agentModeLog(requestLogPath: string): ReadonlyArray<string> {
  if (!NodeFS.existsSync(requestLogPath)) return [];
  return NodeFS.readFileSync(requestLogPath, "utf8")
    .split("\n")
    .flatMap((line) => {
      const decoded = decodeRequestLine(line);
      if (decoded._tag === "None") return [];
      const request = decoded.value;
      if (request.method === "session/prompt") return ["prompt"];
      if (request.method === "session/set_config_option" && request.params?.configId === "mode") {
        return [`mode:${String(request.params.value)}`];
      }
      return [];
    });
}

/** What the agent was set to between the previous prompt and prompt `ordinal` (1-based). */
function modesBeforePrompt(log: ReadonlyArray<string>, ordinal: number): ReadonlyArray<string> {
  const prompts = log.flatMap((entry, index) => (entry === "prompt" ? [index] : []));
  const start = ordinal === 1 ? 0 : prompts[ordinal - 2]! + 1;
  return log.slice(start, prompts[ordinal - 1]).filter((entry) => entry !== "prompt");
}

const policy = (
  runtimeMode: "full-access" | "approval-required",
  interactionMode: "default" | "plan" = "default",
) => ProviderAdapterV2RuntimePolicy.make({ runtimeMode, interactionMode, cwd: process.cwd() });

const openAntigravitySession = (input: {
  readonly name: string;
  readonly requestLogPath?: string;
  readonly modelOptions?: ReadonlyArray<{ readonly id: string; readonly value: string }>;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
  readonly onWriteHandler?: (
    handler: Parameters<AcpSessionRuntime.AcpSessionRuntime["Service"]["handleWriteTextFile"]>[0],
  ) => void;
}) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const mockAgentPath = yield* path.fromFileUrl(
      new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
    );
    const instanceId = ProviderInstanceId.make(`antigravity-${input.name}`);
    const threadId = ThreadId.make(`thread-antigravity-${input.name}`);
    const adapter = yield* makeAntigravityAdapterV2({
      instanceId,
      selfInvocation: yield* resolveSelfInvocation(),
      makeRuntime: (runtimeInput) =>
        makeAntigravityAcpRuntime({
          ...runtimeInput,
          childProcessSpawner,
          spawn: {
            command: process.execPath,
            args: [mockAgentPath],
            cwd: runtimeInput.cwd,
            env: {
              T3_ACP_ANTIGRAVITY: "1",
              ...(input.requestLogPath === undefined
                ? {}
                : { T3_ACP_REQUEST_LOG_PATH: input.requestLogPath }),
            },
          },
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.map((runtime): AcpSessionRuntime.AcpSessionRuntime["Service"] => ({
            ...runtime,
            handleWriteTextFile: (handler) =>
              Effect.sync(() => input.onWriteHandler?.(handler)).pipe(
                Effect.andThen(runtime.handleWriteTextFile(handler)),
              ),
          })),
        ),
      withProcess: (_stop, task) => task,
      defaultModel: Effect.succeed(undefined),
    });
    const modelSelection = {
      instanceId,
      model: "gemini-test-low",
      ...(input.modelOptions === undefined ? {} : { options: input.modelOptions }),
    };
    const session = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`provider-session-antigravity-${input.name}`),
      modelSelection,
      runtimePolicy: input.runtimePolicy,
    });
    const providerThread = yield* session.ensureThread({
      threadId,
      modelSelection,
      runtimePolicy: input.runtimePolicy,
    });
    return { session, providerThread, threadId, instanceId, modelSelection };
  });

const runTurn = (
  opened: {
    readonly session: ProviderAdapterV2SessionRuntime;
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly threadId: ThreadId;
    readonly instanceId: ProviderInstanceId;
    readonly modelSelection: ModelSelection;
  },
  ordinal: number,
  runtimePolicy: ProviderAdapterV2RuntimePolicy,
) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const suffix = `${opened.threadId}:${ordinal}`;
    yield* opened.session.startTurn({
      appThread: {
        createdBy: "user",
        creationSource: "web",
        id: opened.threadId,
        projectId: ProjectId.make(`project:${opened.threadId}`),
        title: "Antigravity hard cap",
        providerInstanceId: opened.instanceId,
        modelSelection: opened.modelSelection,
        runtimeMode: runtimePolicy.runtimeMode,
        interactionMode: runtimePolicy.interactionMode,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: opened.providerThread.id,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: opened.threadId,
        },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      threadId: opened.threadId,
      runId: RunId.make(`run:${suffix}`),
      runOrdinal: ordinal,
      providerTurnOrdinal: ordinal,
      attemptId: RunAttemptId.make(`attempt:${suffix}`),
      rootNodeId: NodeId.make(`node:${suffix}`),
      providerThread: opened.providerThread,
      message: {
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make(`message:${suffix}`),
        text: `Turn ${ordinal}`,
        attachments: [],
      },
      modelSelection: opened.modelSelection,
      runtimePolicy,
    });
    yield* opened.session.events.pipe(
      Stream.takeUntil((event) => event.type === "turn.terminal"),
      Stream.runDrain,
    );
  });

describe("AntigravityAdapterV2 under a provider instance's hard cap", () => {
  it.live("puts a live session in the lowered policy's mode on its next turn", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const logDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ag-cap-mode-" });
      const requestLogPath = path.join(logDir, "requests.ndjson");
      const opened = yield* openAntigravitySession({
        name: "cap-lowered",
        requestLogPath,
        runtimePolicy: policy("full-access"),
      });
      yield* runTurn(opened, 1, policy("full-access"));
      // The cap drops to Supervised; the model and interaction mode stay.
      yield* runTurn(opened, 2, policy("approval-required"));
      const log = agentModeLog(requestLogPath);
      assert.deepEqual(modesBeforePrompt(log, 1).at(-1), "mode:yolo");
      assert.deepEqual(modesBeforePrompt(log, 2), ["mode:default"]);
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );

  it.live("leaves Plan in the policy's mode, not the one saved on entering it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const logDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ag-cap-plan-" });
      const requestLogPath = path.join(logDir, "requests.ndjson");
      const opened = yield* openAntigravitySession({
        name: "cap-plan",
        requestLogPath,
        runtimePolicy: policy("full-access"),
      });
      yield* runTurn(opened, 1, policy("full-access"));
      yield* runTurn(opened, 2, policy("full-access", "plan"));
      // Lowered while in Plan, then back to Default.
      yield* runTurn(opened, 3, policy("approval-required"));
      const log = agentModeLog(requestLogPath);
      const leavingPlan = modesBeforePrompt(log, 3);
      assert.notInclude(leavingPlan, "mode:yolo", "the cached full-access mode is not restored");
      assert.equal(leavingPlan.at(-1), "mode:default");
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );

  it.live("keeps a stored mode selection from widening the policy's mode", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const logDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ag-cap-option-" });
      const requestLogPath = path.join(logDir, "requests.ndjson");
      // Antigravity offers its permission modes as the "mode" option; a
      // parent can pass either id in a child's model options.
      const opened = yield* openAntigravitySession({
        name: "cap-option",
        requestLogPath,
        runtimePolicy: policy("approval-required"),
        modelOptions: [
          { id: "mode", value: "yolo" },
          { id: "_t3/session-mode", value: "yolo" },
        ],
      });
      yield* runTurn(opened, 1, policy("approval-required"));
      assert.notInclude(agentModeLog(requestLogPath), "mode:yolo");
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );

  it.live("refuses the file writes T3 serves for the agent when file changes are declined", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ag-cap-fs-" });
      let writeTextFile:
        | Parameters<AcpSessionRuntime.AcpSessionRuntime["Service"]["handleWriteTextFile"]>[0]
        | undefined;
      const declining = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: workspace,
        declineFileChanges: true,
      });
      yield* openAntigravitySession({
        name: "cap-fs",
        runtimePolicy: declining,
        onWriteHandler: (handler) => {
          writeTextFile = handler;
        },
      });
      if (writeTextFile === undefined) {
        return yield* Effect.die("Antigravity sessions must serve client file requests");
      }
      const target = path.join(workspace, "src", "edited.ts");
      const written = yield* writeTextFile(
        { sessionId: "mock-session-1", path: target, content: "edited" },
        { requestId: "test-fs/write_text_file", method: "fs/write_text_file" },
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(written));
      assert.isFalse(yield* fileSystem.exists(target));
    }).pipe(Effect.provide(layerSession), Effect.scoped),
  );
});
