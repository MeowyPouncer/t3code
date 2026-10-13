// FORK: the night mode. The user leaves agents working; one overseer thread watches every session
// and answers what it can, T3 starts what the user queued once nothing works any more, asks the
// overseer for a morning report, and can power the computer off. Decisions live in nightLogic.ts.
import {
  CommandId,
  MessageId,
  NightError,
  NightState,
  type NightLaunch,
  type NightPlan,
  type NightStreamItem,
  type OrchestrationV2DomainEvent,
  type ThreadId,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { ProcessRunner } from "../processRunner.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  CONTEXT_REARM_RATIO,
  CONTEXT_WARN_RATIO,
  contextRatio,
  isNightSession,
  nextNightStep,
  nightRulesApply,
  nightSessions,
  nothingWorks,
  overseerAnswersRequest,
  overseerWatches,
  stoppedSessions,
} from "./nightLogic.ts";
import * as NightRules from "./NightRules.ts";
import {
  NIGHT_ENDED_MESSAGE,
  nightBriefingMessage,
  nightContextMessage,
  nightEndStartedMessage,
  nightLeftMessage,
  nightOverseerInstructions,
  nightReportMessage,
  nightRequestMessage,
  nightRules,
  nightStoppedMessage,
} from "./nightTexts.ts";

/** How often T3 looks at every thread while the night's work runs. */
const CHECK_INTERVAL_MS = 30_000;
/** Nothing may work, and no run may change, for this long before the night moves on. */
const QUIET_MS = 60_000;
/** Between the report and powering off; the user can still end the night. */
const POWER_OFF_GRACE_MS = 60_000;

const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

export class NightService extends Context.Service<
  NightService,
  {
    readonly start: (plan: NightPlan) => Effect.Effect<NightState, NightError>;
    /** The user is leaving: the briefing ends and the night starts. */
    readonly leave: () => Effect.Effect<NightState, NightError>;
    /** Ends a running night, or dismisses a finished one. */
    readonly stop: () => Effect.Effect<void, NightError>;
    readonly subscribe: () => Stream.Stream<NightStreamItem>;
  }
>()("t3/night/NightService") {}

const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(NightState));

const powerOffCommand = (platform: NodeJS.Platform) =>
  platform === "linux"
    ? { command: "systemctl", args: ["poweroff"] }
    : platform === "darwin"
      ? { command: "osascript", args: ["-e", 'tell application "System Events" to shut down'] }
      : platform === "win32"
        ? { command: "shutdown", args: ["/s", "/t", "0"] }
        : null;

const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const errorDetail = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threadLaunch = yield* ThreadLaunch.ThreadLaunchService;
  const rules = yield* NightRules.NightRules;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const processRunner = yield* ProcessRunner;
  const scheduler = yield* Scheduler.Scheduler;
  const platform = yield* HostProcess.Platform;

  const statePath = path.join(config.stateDir, "night-mode.json");
  const stateRef = yield* Ref.make<NightState | null>(null);
  const changes = yield* PubSub.sliding<NightState | null>(1);
  const lock = yield* Semaphore.make(1);
  const locked = lock.withPermits(1);

  // What the night needs only while this server runs.
  const runtime = {
    lastRunEventAtMs: yield* Clock.currentTimeMillis,
    lastCheckAtMs: 0,
    /** Sessions working at the last look; null until the first look of this run. */
    workingSessions: null as ReadonlySet<ThreadId> | null,
    /** Threads already reported near their context limit. */
    contextWarned: new Set<ThreadId>(),
    overseerNeedsCompact: false,
  };

  const persist = (state: NightState | null) =>
    (state === null
      ? fs.remove(statePath, { force: true })
      : writeFileStringAtomically({
          filePath: statePath,
          contents: `${JSON.stringify(state)}\n`,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        )
    ).pipe(
      Effect.mapError(
        (cause) =>
          new NightError({
            operation: "persist",
            detail: `Could not save the night: ${errorDetail(cause)}`,
          }),
      ),
    );

  const setState = (state: NightState | null) =>
    Effect.gen(function* () {
      yield* persist(state);
      yield* Ref.set(stateRef, state);
      yield* rules.set(
        nightRulesApply(state) && state !== null
          ? { rules: nightRules(), overseerThreadId: state.overseerThreadId }
          : null,
      );
      yield* PubSub.publish(changes, state);
    });

  const wakeOverseer = (state: NightState, key: string, text: string) =>
    threads
      .sendToThread({
        projectId: state.plan.overseer.projectId,
        commandId: CommandId.make(`night:${state.id}:${key}`),
        threadId: state.overseerThreadId,
        messageId: MessageId.make(`night:${state.id}:${key}`),
        text,
        attachments: [],
        // Never steer: a wake waits for the overseer's current turn.
        mode: "queue",
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(
        Effect.asVoid,
        Effect.catchCause((cause) => Effect.logWarning("night.wake-failed", { key, cause })),
      );

  const launchEnd = (state: NightState, key: string, launch: NightLaunch) =>
    threadLaunch
      .launch({
        commandId: CommandId.make(`night:${state.id}:${key}`),
        projectId: launch.projectId,
        title: launch.title,
        modelSelection: launch.modelSelection,
        runtimeMode: launch.runtimeMode,
        interactionMode: launch.interactionMode,
        workspaceStrategy: { type: "root" },
        initialMessage: {
          messageId: MessageId.make(`night:${state.id}:${key}`),
          text: launch.text,
          attachments: [],
        },
        createdBy: "user",
        creationSource: "server",
        ...(launch.instructions === undefined ? {} : { instructions: launch.instructions }),
      })
      .pipe(
        Effect.map((result) => ({ id: result.threadId, title: launch.title })),
        Effect.mapError((error) => ({ title: launch.title, reason: errorDetail(error) })),
      );

  const readThreads = Effect.gen(function* () {
    const snapshot = yield* orchestrator.getShellSnapshot({
      location: "active",
      // A settled thread works for nobody; skipping them keeps the look cheap.
      unsettledOnly: true,
    });
    const settings = yield* serverSettings.getSettings;
    return { threads: snapshot.threads, autoResume: settings.autoResumeLimitedThreads };
  });

  const beginNight = (state: NightState, trigger: "leave" | "timer") =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const next: NightState = { ...state, phase: "night", nightStartedAt: isoAt(nowMs) };
      yield* setState(next);
      runtime.workingSessions = null;
      yield* wakeOverseer(next, "night", nightLeftMessage(trigger));
      return next;
    });

  const startAgents = (state: NightState) =>
    Effect.gen(function* () {
      const results = yield* Effect.forEach(
        state.plan.end.agents,
        (launch, index) => Effect.result(launchEnd(state, `agent:${index}`, launch)),
        { concurrency: 4 },
      );
      const started = results.flatMap((result) =>
        result._tag === "Success" ? [result.success] : [],
      );
      const failed = results.flatMap((result) =>
        result._tag === "Failure" ? [result.failure] : [],
      );
      const next: NightState = {
        ...state,
        phase: "ending",
        agentsStarted: true,
        endThreadIds: [...state.endThreadIds, ...started.map((thread) => thread.id)],
      };
      yield* setState(next);
      yield* wakeOverseer(
        next,
        "agents",
        nightEndStartedMessage({ what: "agents", started, failed }),
      );
    });

  const startQueued = (state: NightState, index: number) =>
    Effect.gen(function* () {
      const launch = state.plan.end.queue[index];
      if (launch === undefined) return;
      const result = yield* Effect.result(launchEnd(state, `queue:${index}`, launch));
      const next: NightState = {
        ...state,
        phase: "ending",
        queueStarted: index + 1,
        endThreadIds:
          result._tag === "Success"
            ? [...state.endThreadIds, result.success.id]
            : state.endThreadIds,
      };
      yield* setState(next);
      yield* wakeOverseer(
        next,
        `queued:${index}`,
        nightEndStartedMessage({
          what: "queued",
          started: result._tag === "Success" ? [result.success] : [],
          failed: result._tag === "Failure" ? [result.failure] : [],
          position: { index, total: state.plan.end.queue.length },
        }),
      );
    });

  const requestReport = (state: NightState) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const next: NightState = { ...state, phase: "report", reportRequestedAt: isoAt(nowMs) };
      yield* setState(next);
      yield* wakeOverseer(
        next,
        "report",
        nightReportMessage(next.plan.end.powerOff && next.powerOffError === null),
      );
    });

  const finish = (state: NightState) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const powerOff = state.plan.end.powerOff && state.powerOffError === null;
      yield* setState({
        ...state,
        phase: "done",
        doneAt: isoAt(nowMs),
        poweringOffAt: powerOff ? isoAt(nowMs + POWER_OFF_GRACE_MS) : null,
      });
    });

  /** At the time set after the report: powers off, or waits a minute more while anything works. */
  const powerOff = (state: NightState) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const { threads: shells, autoResume } = yield* readThreads;
      if (!nothingWorks(shells, nowMs, autoResume) || nowMs - runtime.lastRunEventAtMs < QUIET_MS) {
        yield* setState({ ...state, poweringOffAt: isoAt(nowMs + POWER_OFF_GRACE_MS) });
        return;
      }
      const command = powerOffCommand(platform);
      if (command === null) {
        yield* setState({
          ...state,
          poweringOffAt: null,
          powerOffError: `T3 cannot power off a ${platform} computer.`,
        });
        return;
      }
      // Recorded first, so a T3 that starts again never powers off for an old night.
      yield* setState({ ...state, poweringOffAt: null, poweredOffAt: isoAt(nowMs) });
      yield* Effect.logInfo("night.power-off", { command: command.command });
      const outcome = yield* Effect.result(
        processRunner.run({ ...command, timeout: "30 seconds" }),
      );
      const failure =
        outcome._tag === "Failure"
          ? errorDetail(outcome.failure)
          : outcome.success.code !== 0
            ? outcome.success.stderr.trim() ||
              `${command.command} exited with ${outcome.success.code}`
            : null;
      if (failure !== null) {
        const current = yield* Ref.get(stateRef);
        if (current !== null && current.id === state.id) {
          yield* setState({ ...current, poweredOffAt: null, powerOffError: failure });
        }
      }
    });

  /** Runs every scheduler tick; does work only when something is due. */
  const runDueWork = locked(
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      if (state === null) return;
      const nowMs = yield* Clock.currentTimeMillis;
      switch (state.phase) {
        case "briefing":
          if (nowMs >= Date.parse(state.briefingEndsAt)) yield* beginNight(state, "timer");
          return;
        case "done":
          if (state.poweringOffAt !== null && nowMs >= Date.parse(state.poweringOffAt)) {
            yield* powerOff(state);
          }
          return;
        case "night":
        case "ending":
        case "report":
          break;
      }
      if (nowMs - runtime.lastCheckAtMs < CHECK_INTERVAL_MS) return;
      runtime.lastCheckAtMs = nowMs;
      const { threads: shells, autoResume } = yield* readThreads;
      if (overseerWatches(state)) {
        const sessions = nightSessions(shells, state.overseerThreadId, nowMs, autoResume);
        const previous = runtime.workingSessions;
        runtime.workingSessions = new Set(
          sessions.filter((session) => session.works).map((session) => session.thread.id),
        );
        const stopped = previous === null ? [] : stoppedSessions(previous, sessions);
        if (stopped.length > 0) {
          // The overseer may set the work going again; the next look decides.
          yield* wakeOverseer(state, `stopped:${nowMs}`, nightStoppedMessage(stopped));
          return;
        }
      }
      if (!nothingWorks(shells, nowMs, autoResume) || nowMs - runtime.lastRunEventAtMs < QUIET_MS) {
        return;
      }
      const step = nextNightStep(state);
      if (step === null) return;
      yield* Effect.logInfo("night.step", { night: state.id, step: step.type });
      switch (step.type) {
        case "start-agents":
          return yield* startAgents(state);
        case "start-queued":
          return yield* startQueued(state, step.index);
        case "request-report":
          return yield* requestReport(state);
        case "finish":
          return yield* finish(state);
      }
    }),
  ).pipe(Effect.catchCause((cause) => Effect.logWarning("night.check-failed", { cause })));

  const onRequest = (
    event: Extract<OrchestrationV2DomainEvent, { readonly type: "runtime-request.updated" }>,
  ) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      if (!overseerWatches(state) || event.threadId === state.overseerThreadId) return;
      const shell = yield* threads.getThreadShell(event.threadId);
      if (shell === null || !isNightSession(shell, state.overseerThreadId)) return;
      yield* wakeOverseer(
        state,
        `request:${event.payload.id}`,
        nightRequestMessage(shell, event.payload),
      );
    });

  const onContext = (
    event: Extract<OrchestrationV2DomainEvent, { readonly type: "provider-turn.updated" }>,
    ratio: number,
  ) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      if (!overseerWatches(state)) return;
      runtime.contextWarned.add(event.threadId);
      if (event.threadId === state.overseerThreadId) {
        // Compacted between its turns, so the overseer never loses one mid-way.
        runtime.overseerNeedsCompact = true;
        return;
      }
      const shell = yield* threads.getThreadShell(event.threadId);
      if (shell === null || !isNightSession(shell, state.overseerThreadId)) return;
      yield* wakeOverseer(
        state,
        `context:${event.threadId}:${event.payload.id}`,
        nightContextMessage(shell, ratio),
      );
    });

  const onRun = (event: Extract<OrchestrationV2DomainEvent, { readonly type: "run.updated" }>) =>
    Effect.gen(function* () {
      if (!runtime.overseerNeedsCompact || !TERMINAL_RUN_STATUSES.has(event.payload.status)) return;
      const state = yield* Ref.get(stateRef);
      if (!overseerWatches(state) || event.threadId !== state.overseerThreadId) return;
      runtime.overseerNeedsCompact = false;
      yield* wakeOverseer(state, `compact:${event.payload.id}`, "/compact");
    });

  /** Sees every domain event, so anything it does not need returns at once. */
  const onEvent = (event: OrchestrationV2DomainEvent): Effect.Effect<void> => {
    switch (event.type) {
      case "run.created":
        return Clock.currentTimeMillis.pipe(
          Effect.map((nowMs) => {
            runtime.lastRunEventAtMs = nowMs;
          }),
        );
      case "run.updated":
        return Clock.currentTimeMillis.pipe(
          Effect.flatMap((nowMs) => {
            runtime.lastRunEventAtMs = nowMs;
            return onRun(event);
          }),
        );
      case "runtime-request.updated":
        return event.payload.status === "pending" && overseerAnswersRequest(event.payload.kind)
          ? onRequest(event).pipe(
              Effect.catchCause((cause) => Effect.logWarning("night.request-failed", { cause })),
            )
          : Effect.void;
      case "provider-turn.updated": {
        const ratio = contextRatio(event.payload.tokenUsage);
        if (ratio === null) return Effect.void;
        if (ratio < CONTEXT_REARM_RATIO) {
          runtime.contextWarned.delete(event.threadId);
          return Effect.void;
        }
        if (ratio < CONTEXT_WARN_RATIO || runtime.contextWarned.has(event.threadId)) {
          return Effect.void;
        }
        return onContext(event, ratio).pipe(
          Effect.catchCause((cause) => Effect.logWarning("night.context-failed", { cause })),
        );
      }
      default:
        return Effect.void;
    }
  };

  const start = (plan: NightPlan) =>
    locked(
      Effect.gen(function* () {
        const current = yield* Ref.get(stateRef);
        if (current !== null && current.phase !== "done") {
          return yield* new NightError({
            operation: "start",
            detail: "A night is already running.",
          });
        }
        const nowMs = yield* Clock.currentTimeMillis;
        const id = nowMs.toString(36);
        const briefingEndsAt = isoAt(nowMs + plan.briefingMinutes * 60_000);
        const { threads: shells, autoResume } = yield* readThreads.pipe(
          Effect.mapError(
            (error) => new NightError({ operation: "start", detail: errorDetail(error) }),
          ),
        );
        const sessions = nightSessions(shells, null, nowMs, autoResume).filter(
          (session) =>
            session.works ||
            session.thread.pendingRuntimeRequest !== null ||
            session.waitingDescendants.length > 0,
        );
        const launched = yield* threadLaunch
          .launch({
            commandId: CommandId.make(`night:${id}:overseer`),
            projectId: plan.overseer.projectId,
            title: "Night overseer",
            modelSelection: plan.overseer.modelSelection,
            runtimeMode: plan.overseer.runtimeMode,
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            initialMessage: {
              messageId: MessageId.make(`night:${id}:briefing`),
              text: nightBriefingMessage({ plan, briefingEndsAt, sessions }),
              attachments: [],
            },
            createdBy: "user",
            creationSource: "server",
            instructions: nightOverseerInstructions(),
          })
          .pipe(
            Effect.mapError(
              (error) => new NightError({ operation: "start", detail: errorDetail(error) }),
            ),
          );
        const state: NightState = {
          id,
          phase: "briefing",
          plan,
          overseerThreadId: launched.threadId,
          startedAt: isoAt(nowMs),
          briefingEndsAt,
          nightStartedAt: null,
          agentsStarted: false,
          queueStarted: 0,
          endThreadIds: [],
          reportRequestedAt: null,
          doneAt: null,
          poweringOffAt: null,
          poweredOffAt: null,
          powerOffError: null,
        };
        yield* setState(state);
        runtime.workingSessions = null;
        runtime.contextWarned.clear();
        runtime.overseerNeedsCompact = false;
        return state;
      }),
    );

  const leave = () =>
    locked(
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef);
        if (state === null || state.phase !== "briefing") {
          return yield* new NightError({ operation: "leave", detail: "No briefing is running." });
        }
        return yield* beginNight(state, "leave");
      }),
    );

  const stop = () =>
    locked(
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef);
        if (state === null) return;
        yield* setState(null);
        if (state.phase !== "done") yield* wakeOverseer(state, "ended", NIGHT_ENDED_MESSAGE);
      }),
    );

  const subscribe = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe first so a change between the two is not lost.
        const subscription = yield* PubSub.subscribe(changes);
        const current = yield* Ref.get(stateRef);
        return Stream.concat(
          Stream.make({ state: current }),
          Stream.fromSubscription(subscription).pipe(Stream.map((state) => ({ state }))),
        );
      }),
    );

  // A night saved by an earlier run of this server goes on, but a power off it had armed does
  // not: T3 never powers off right after it starts.
  const saved = yield* fs
    .readFileString(statePath)
    .pipe(Effect.flatMap(decodeState), Effect.option);
  if (saved._tag === "Some") {
    const state = saved.value;
    const away = state.phase === "night" || state.phase === "ending" || state.phase === "report";
    const restarted =
      state.poweringOffAt !== null ||
      (away && state.plan.end.powerOff && state.powerOffError === null)
        ? {
            ...state,
            poweringOffAt: null,
            powerOffError: "T3 restarted during the night, so it does not power the computer off.",
          }
        : state;
    yield* setState(restarted).pipe(
      Effect.catchCause((cause) => Effect.logWarning("night.restore-failed", { cause })),
    );
  }

  yield* forkParked(Stream.runForEach(threads.streamDomainEvents, onEvent));
  yield* scheduler.register("night-mode", runDueWork);

  return NightService.of({ start, leave, stop, subscribe });
});

export const layer = Layer.effect(NightService, make);
