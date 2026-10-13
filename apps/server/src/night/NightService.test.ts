import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ModelSelection,
  type NightPlan,
  type NightState,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as AgentQueue from "../agentQueue/AgentQueueService.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as NightRules from "./NightRules.ts";
import * as NightService from "./NightService.ts";

const projectId = ProjectId.make("project-night");
const modelSelection = {
  instanceId: ProviderInstanceId.make("claude"),
  model: "claude-opus-5-5",
} satisfies ModelSelection;

const launch = (title: string) => ({
  projectId,
  title,
  text: `/take-card ${title}`,
  modelSelection,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
});

const plan: NightPlan = {
  overseer: { projectId, modelSelection, runtimeMode: "full-access" },
  briefingMinutes: 15,
  end: { agents: [launch("CARD-1")], queue: [], powerOff: true },
};

/** A thread whose agent is mid-turn, as the shell snapshot shows it. */
const workingThread = (id: string) =>
  ({
    id: ThreadId.make(id),
    title: id,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: ThreadId.make(id),
    },
    archivedAt: null,
    settledOverride: null,
    status: "running",
    activityRunStatus: "running",
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestUserMessageAt: null,
    latestRunId: RunId.make("run-working"),
    latestRunRequestedAt: DateTime.makeUnsafe(0),
    latestRunStartedAt: DateTime.makeUnsafe(0),
    latestRunCompletedAt: null,
  }) as unknown as OrchestrationV2ThreadShell;

const makeHarness = (baseDir: string) =>
  Effect.gen(function* () {
    const sent: Array<ThreadManagement.ThreadManagementSendInput> = [];
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const commands: Array<string> = [];
    const shells = yield* Ref.make<ReadonlyArray<OrchestrationV2ThreadShell>>([]);
    const due: Array<Effect.Effect<void>> = [];
    const register = <E, R>(_name: string, work: Effect.Effect<void, E, R>) =>
      Effect.context<R>().pipe(
        Effect.map((context) => {
          due.push(work.pipe(Effect.provideContext(context), Effect.ignore));
        }),
      );
    const base = Layer.mergeAll(
      NightRules.layer,
      Layer.succeed(HostProcess.Platform, "linux"),
      Layer.succeed(Scheduler.Scheduler, Scheduler.Scheduler.of({ register })),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        sendToThread: (input) =>
          Effect.sync(() => {
            sent.push(input);
            return {} as unknown as ThreadManagement.ThreadManagementSendResult;
          }),
        streamDomainEvents: Stream.never,
        getThreadShell: () => Effect.succeed(null),
      }),
      Layer.mock(Orchestrator.OrchestratorV2)({
        getShellSnapshot: () =>
          Ref.get(shells).pipe(
            Effect.map((threads) => ({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads,
              archivedThreads: [],
            })),
          ),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (input) =>
          Effect.sync(() => {
            launched.push(input);
            return {
              threadId: ThreadId.make(`thread-${launched.length}`),
              resumed: false,
            } as unknown as ThreadLaunch.ThreadLaunchResult;
          }),
      }),
      Layer.succeed(
        ProcessRunner.ProcessRunner,
        ProcessRunner.ProcessRunner.of({
          run: (input) =>
            Effect.sync(() => {
              commands.push([input.command, ...input.args].join(" "));
              return {
                stdout: "",
                stderr: "",
                code: ChildProcessSpawner.ExitCode(0),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              };
            }),
        }),
      ),
      ServerSettings.layerTest(),
      ServerConfig.layerTest(process.cwd(), baseDir),
    ).pipe(Layer.provideMerge(NodeServices.layer));
    const context = yield* Layer.build(AgentQueue.layer.pipe(Layer.provideMerge(base)));
    const service = yield* NightService.make.pipe(Effect.provideContext(context));
    return {
      service,
      rules: Context.get(context, NightRules.NightRules),
      config: Context.get(context, ServerConfig.ServerConfig),
      sent,
      launched,
      commands,
      shells,
      runDue: Effect.forEach(due, (work) => work, { discard: true }),
    };
  });

const tempDir = FileSystem.FileSystem.pipe(
  Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "t3-night-" })),
);

const stateOf = (harness: Effect.Success<ReturnType<typeof makeHarness>>) =>
  harness.service.subscribe().pipe(
    Stream.take(1),
    Stream.runHead,
    Effect.map((item) => (item._tag === "Some" ? item.value.night : null)),
  );

describe("NightService", () => {
  it.effect("runs a night from the briefing to powering off, waiting while anything works", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness(yield* tempDir);
        const started = yield* harness.service.start(plan);
        assert.equal(started.phase, "briefing");
        assert.equal(harness.launched[0]?.title, "Night overseer");
        assert.include(harness.launched[0]?.instructions ?? "", "night overseer");
        assert.isNull(yield* harness.rules.current);

        const night = yield* harness.service.leave();
        assert.equal(night.phase, "night");
        assert.equal((yield* harness.rules.current)?.overseerThreadId, started.overseerThreadId);
        assert.equal(harness.sent.at(-1)?.commandId, `night:${started.id}:night`);
        assert.equal(harness.sent.at(-1)?.mode, "queue");

        // Something works: the night waits.
        yield* Ref.set(harness.shells, [workingThread("thread-working")]);
        yield* TestClock.adjust("61 seconds");
        yield* harness.runDue;
        assert.lengthOf(harness.launched, 1);

        // Nothing works: the end-of-night agents start.
        yield* Ref.set(harness.shells, []);
        yield* TestClock.adjust("31 seconds");
        yield* harness.runDue;
        assert.deepEqual(
          harness.launched.map((input) => input.title),
          ["Night overseer", "CARD-1"],
        );
        assert.equal((yield* stateOf(harness))?.phase, "ending");

        yield* TestClock.adjust("31 seconds");
        yield* harness.runDue;
        assert.equal((yield* stateOf(harness))?.phase, "report");
        assert.equal(harness.sent.at(-1)?.commandId, `night:${started.id}:report`);

        yield* TestClock.adjust("31 seconds");
        yield* harness.runDue;
        const done = yield* stateOf(harness);
        assert.equal(done?.phase, "done");
        assert.isNotNull(done?.poweringOffAt);
        assert.isNull(yield* harness.rules.current);
        assert.lengthOf(harness.commands, 0);

        // The grace minute passes with nothing working.
        yield* TestClock.adjust("61 seconds");
        yield* harness.runDue;
        assert.deepEqual(harness.commands, ["systemctl poweroff"]);
        const off = yield* stateOf(harness);
        assert.isNull(off?.poweringOffAt);
        assert.isNotNull(off?.poweredOffAt);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("starts the end-of-night agents a few at a time", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness(yield* tempDir);
        yield* harness.service.start({
          ...plan,
          end: {
            agents: [launch("CARD-1"), launch("CARD-2")],
            maxAgents: 1,
            queue: [],
            powerOff: false,
          },
        });
        yield* harness.service.leave();
        yield* TestClock.adjust("61 seconds");
        yield* harness.runDue;
        assert.deepEqual(
          harness.launched.map((input) => input.title),
          ["Night overseer", "CARD-1"],
        );

        // CARD-1 (thread-2) still works: CARD-2 waits and the night does not move on.
        yield* Ref.set(harness.shells, [workingThread("thread-2")]);
        yield* TestClock.adjust("31 seconds");
        yield* harness.runDue;
        assert.lengthOf(harness.launched, 2);
        assert.equal((yield* stateOf(harness))?.phase, "ending");

        // CARD-1 is done: CARD-2 takes its slot.
        yield* Ref.set(harness.shells, []);
        yield* TestClock.adjust("31 seconds");
        yield* harness.runDue;
        assert.deepEqual(
          harness.launched.map((input) => input.title),
          ["Night overseer", "CARD-1", "CARD-2"],
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("never powers off for a night saved before T3 started again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const baseDir = yield* tempDir;
        const first = yield* makeHarness(baseDir);
        const started = yield* first.service.start(plan);
        yield* first.service.leave();

        // A second server on the same state, as after a restart in the night.
        const second = yield* makeHarness(baseDir);
        const restored = yield* stateOf(second);
        assert.equal(restored?.id, started.id);
        assert.equal(restored?.phase, "night");
        assert.isNotNull(restored?.powerOffError);
        assert.equal((yield* second.rules.current)?.overseerThreadId, started.overseerThreadId);

        // The night still ends, but the computer stays on.
        for (let step = 0; step < 4; step++) {
          yield* TestClock.adjust("61 seconds");
          yield* second.runDue;
        }
        const done = yield* stateOf(second);
        assert.equal(done?.phase, "done");
        assert.isNull(done?.poweringOffAt);
        yield* TestClock.adjust("120 seconds");
        yield* second.runDue;
        assert.lengthOf(second.commands, 0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("cancels a power off that was due when T3 stopped", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const baseDir = yield* tempDir;
        const first = yield* makeHarness(baseDir);
        yield* first.service.start(plan);
        const saved = yield* stateOf(first);
        assert.isNotNull(saved);
        if (saved === null) return;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const pending: NightState = {
          ...saved,
          phase: "done",
          doneAt: saved.startedAt,
          poweringOffAt: saved.startedAt,
        };
        yield* fs.writeFileString(
          path.join(first.config.stateDir, "night-mode.json"),
          JSON.stringify(pending),
        );

        const second = yield* makeHarness(baseDir);
        const restored = yield* stateOf(second);
        assert.isNull(restored?.poweringOffAt);
        assert.isNotNull(restored?.powerOffError);
        yield* TestClock.adjust("120 seconds");
        yield* second.runDue;
        assert.lengthOf(second.commands, 0);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("ending the night clears the rules and tells the overseer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness(yield* tempDir);
        const started = yield* harness.service.start(plan);
        yield* harness.service.leave();
        yield* harness.service.stop();
        assert.isNull(yield* harness.rules.current);
        assert.isNull(yield* stateOf(harness));
        assert.equal(harness.sent.at(-1)?.commandId, `night:${started.id}:ended`);

        // A new night can start once the old one is gone.
        const next = yield* harness.service.start(plan);
        assert.equal(next.phase, "briefing");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
