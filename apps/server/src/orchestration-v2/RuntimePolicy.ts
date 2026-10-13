import {
  ModelSelection,
  OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  clampRuntimeModeToHardCap,
  providerInstanceHardCapInForce,
} from "../provider/ProviderInstanceHardCap.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as NightRules from "../night/NightRules.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProjectStore from "./ProjectStore.ts";

/**
 * ERRORS
 */
export class RuntimePolicyResolveError extends Schema.TaggedError<RuntimePolicyResolveError>()(
  "RuntimePolicyResolveError",
  {
    projectId: ProjectId,
    providerInstanceId: ProviderInstanceId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to resolve runtime policy for provider instance ${this.providerInstanceId} in project ${this.projectId}.`;
  }
}

export const RuntimePolicyV2Error = Schema.Union([RuntimePolicyResolveError]);
export type RuntimePolicyV2Error = typeof RuntimePolicyV2Error.Type;

export const RuntimePolicyV2Override = Schema.Struct({
  cwd: Schema.optional(Schema.String),
  approvalPolicy: Schema.optional(Schema.Unknown),
  sandboxPolicy: Schema.optional(Schema.Unknown),
  reasoningEffort: Schema.optional(Schema.String),
});
export type RuntimePolicyV2Override = typeof RuntimePolicyV2Override.Type;

/**
 * SERVICE DEFINITION
 */
export interface RuntimePolicyV2Shape {
  readonly resolve: (input: {
    readonly thread: OrchestrationV2AppThread;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<ProviderAdapter.ProviderAdapterV2RuntimePolicy, RuntimePolicyV2Error>;
}

export class RuntimePolicyV2 extends Context.Service<RuntimePolicyV2, RuntimePolicyV2Shape>()(
  "t3/orchestration-v2/RuntimePolicy/RuntimePolicyV2",
) {}

/**
 * IMPLEMENTATIONS
 */
export const layer: Layer.Layer<RuntimePolicyV2> = Layer.succeed(RuntimePolicyV2, {
  resolve: (input) =>
    Effect.succeed({
      runtimeMode: input.thread.runtimeMode,
      interactionMode: input.thread.interactionMode,
      cwd: input.thread.worktreePath,
    }),
});

/**
 * The mode a provider runs a thread in. A mode the provider does not offer
 * (a thread set before it stopped offering it, or a stale client) runs in
 * Supervised rather than having T3 imitate it.
 */
function providerRuntimeMode(
  runtimeMode: RuntimeMode,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
): RuntimeMode {
  return supportedRuntimeModes === undefined ||
    supportedRuntimeModes.length === 0 ||
    supportedRuntimeModes.includes(runtimeMode)
    ? runtimeMode
    : "approval-required";
}

export const layerFromProjectStore: Layer.Layer<
  RuntimePolicyV2,
  never,
  ProjectStore.ProjectStoreV2 | ProviderInstanceRegistry.ProviderInstanceRegistry
> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const projects = yield* ProjectStore.ProjectStoreV2;
    const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    // Optional so tests that build this layer by hand need no settings stub;
    // production always provides it.
    const serverSettings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
    // FORK: optional the same way; the night mode sets it while the user is away.
    const nightRules = yield* Effect.serviceOption(NightRules.NightRules);
    /**
     * The instance's hard cap holds for every run, however the thread got its
     * mode (the composer, `t3_thread_send`, a schedule, a thread created
     * before the cap). A cap that cannot be read runs Supervised with file
     * changes declined rather than uncapped.
     */
    const hardCapped = (
      runtimeMode: RuntimeMode,
      instanceId: ProviderInstanceId,
    ): Effect.Effect<{
      readonly runtimeMode: RuntimeMode;
      readonly declineFileChanges: boolean;
    }> =>
      Option.isNone(serverSettings)
        ? Effect.succeed({ runtimeMode, declineFileChanges: false })
        : providerInstanceHardCapInForce(serverSettings.value, instanceId).pipe(
            Effect.map((cap) => ({
              runtimeMode: clampRuntimeModeToHardCap(runtimeMode, cap),
              declineFileChanges: cap?.declineFileChanges === true,
            })),
          );
    const resolveInstructions = Effect.fn("RuntimePolicyV2.resolveInstructions")(function* (
      thread: OrchestrationV2AppThread,
    ) {
      const night = Option.isSome(nightRules) ? yield* nightRules.value.current : null;
      const nightText =
        night !== null &&
        thread.id !== night.overseerThreadId &&
        thread.lineage.relationshipToParent !== "subagent"
          ? `<night_rules>\n${night.rules}\n</night_rules>`
          : null;
      const instructions = [thread.instructions ?? null, nightText]
        .filter((part) => part !== null && part.length > 0)
        .join("\n\n");
      return instructions.length > 0 ? { instructions } : {};
    });
    return RuntimePolicyV2.of({
      resolve: Effect.fn("RuntimePolicyV2.resolve")(function* (input) {
        const instance = yield* providerInstances.getInstance(input.modelSelection.instanceId);
        const supportedRuntimeModes =
          instance === undefined
            ? undefined
            : (yield* instance.snapshot.getSnapshot).supportedRuntimeModes;
        const capped = yield* hardCapped(input.thread.runtimeMode, input.modelSelection.instanceId);
        const runtimeMode = providerRuntimeMode(capped.runtimeMode, supportedRuntimeModes);
        const cwd =
          input.thread.worktreePath ??
          (yield* projects.get(input.thread.projectId).pipe(
            Effect.mapError(
              (cause) =>
                new RuntimePolicyResolveError({
                  projectId: input.thread.projectId,
                  providerInstanceId: input.modelSelection.instanceId,
                  cause,
                }),
            ),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new RuntimePolicyResolveError({
                      projectId: input.thread.projectId,
                      providerInstanceId: input.modelSelection.instanceId,
                      cause: "Project not found.",
                    }),
                  ),
                onSome: (project) => Effect.succeed(project.workspaceRoot),
              }),
            ),
          ));
        // FORK: the project's root checkout reaches the provider's hooks as T3CODE_PROJECT_ROOT.
        // Without a worktree it is the cwd; with one, a project that cannot be read leaves it out
        // rather than failing a thread that runs fine.
        const projectRoot =
          input.thread.worktreePath === null
            ? cwd
            : yield* projects.get(input.thread.projectId).pipe(
                Effect.map(
                  Option.match({
                    onNone: () => undefined,
                    onSome: (project) => project.workspaceRoot,
                  }),
                ),
                Effect.orElseSucceed(() => undefined),
              );
        return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode,
          interactionMode: input.thread.interactionMode,
          cwd,
          ...(projectRoot === undefined ? {} : { projectRoot }),
          ...(capped.declineFileChanges ? { declineFileChanges: true } : {}),
          // FORK: the thread's own system instructions reach every adapter here, and while
          // the user is away the night rules join every top-level session's but the overseer's.
          ...(yield* resolveInstructions(input.thread)),
        });
      }),
    });
  }),
);

export function layerWithOverride(
  override: RuntimePolicyV2Override,
): Layer.Layer<RuntimePolicyV2, never, RuntimePolicyV2> {
  return Layer.effect(
    RuntimePolicyV2,
    Effect.gen(function* () {
      const base = yield* RuntimePolicyV2;
      return {
        resolve: (input) =>
          base.resolve(input).pipe(
            Effect.map((policy) =>
              ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
                ...policy,
                ...(override.cwd === undefined ? {} : { cwd: override.cwd }),
                ...(override.approvalPolicy === undefined
                  ? {}
                  : { approvalPolicy: override.approvalPolicy }),
                ...(override.sandboxPolicy === undefined
                  ? {}
                  : { sandboxPolicy: override.sandboxPolicy }),
                ...(override.reasoningEffort === undefined
                  ? {}
                  : { reasoningEffort: override.reasoningEffort }),
              }),
            ),
          ),
      } satisfies RuntimePolicyV2Shape;
    }),
  );
}
