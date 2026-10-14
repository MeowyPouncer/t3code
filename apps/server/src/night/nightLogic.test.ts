import {
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type NightState,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  idleWhileCompacting,
  nextNightStep,
  nightSessions,
  nothingWorks,
  stoppedSessions,
  threadWorks,
  type NightThread,
} from "./nightLogic.ts";

const NOW = Date.parse("2026-10-13T22:00:00.000Z");
const at = (iso: string) => DateTime.makeUnsafe(iso);

const thread = (id: string, overrides: Partial<NightThread> = {}): NightThread => ({
  id: ThreadId.make(id),
  title: id,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
  archivedAt: null,
  settledOverride: null,
  status: "completed",
  activityRunStatus: null,
  pendingRuntimeRequest: null,
  pendingBackgroundTasks: [],
  latestUserMessageAt: at("2026-10-13T20:00:00.000Z"),
  latestRunId: RunId.make(`${id}-run`),
  latestRunRequestedAt: at("2026-10-13T20:00:01.000Z"),
  latestRunStartedAt: at("2026-10-13T20:00:02.000Z"),
  latestRunCompletedAt: at("2026-10-13T21:00:00.000Z"),
  lastErrorClass: null,
  usageLimitResetAt: null,
  limitRecovery: null,
  ...overrides,
});

const request = (kind: "user_input" | "auth_refresh") => ({
  id: RuntimeRequestId.make(`request-${kind}`),
  kind,
  createdAt: at("2026-10-13T21:30:00.000Z"),
});

const limited = (resetAt: string): Partial<NightThread> => ({
  status: "failed",
  lastErrorClass: "usage_limit",
  usageLimitResetAt: resetAt,
});

const launchedBy = (parent: string): Partial<NightThread> => ({
  launchedByThreadId: ThreadId.make(parent),
});

const subagentOf = (parent: string): Partial<NightThread> => ({
  lineage: {
    parentThreadId: ThreadId.make(parent),
    relationshipToParent: "subagent",
    rootThreadId: ThreadId.make(parent),
  },
});

describe("threadWorks", () => {
  it("counts live, queued and waking work, but not a thread waiting for a person", () => {
    expect(threadWorks(thread("a", { activityRunStatus: "running" }), NOW, false)).toBe(true);
    expect(threadWorks(thread("a", { status: "queued" }), NOW, false)).toBe(true);
    expect(
      threadWorks(
        thread("a", { pendingBackgroundTasks: [{ kind: "subagent", taskId: "task-1" }] }),
        NOW,
        false,
      ),
    ).toBe(true);
    expect(
      threadWorks(
        thread("a", { activityRunStatus: "running", pendingRuntimeRequest: request("user_input") }),
        NOW,
        false,
      ),
    ).toBe(false);
    expect(threadWorks(thread("a"), NOW, false)).toBe(false);
  });

  it("does not count T3's idle compaction as a session's work", () => {
    const threads = [thread("a", { activityRunStatus: "running" }), thread("b")];
    expect(nothingWorks(threads, NOW, false)).toBe(false);
    expect(
      nothingWorks(idleWhileCompacting(threads, new Set([ThreadId.make("a")])), NOW, false),
    ).toBe(true);
    expect(idleWhileCompacting(threads, new Set())).toBe(threads);
  });

  it("does not wait for a dev server the agent left running", () => {
    expect(
      threadWorks(
        thread("a", { pendingBackgroundTasks: [{ kind: "command", taskId: "server" }] }),
        NOW,
        false,
      ),
    ).toBe(false);
  });

  it("waits for a usage limit T3 resumes within the night, not for a weekly one", () => {
    expect(threadWorks(thread("a", limited("2026-10-14T01:00:00.000Z")), NOW, true)).toBe(true);
    expect(threadWorks(thread("a", limited("2026-10-14T01:00:00.000Z")), NOW, false)).toBe(false);
    expect(threadWorks(thread("a", limited("2026-10-16T21:00:00.000Z")), NOW, true)).toBe(false);
    // The reset passed long ago and no resume came.
    expect(threadWorks(thread("a", limited("2026-10-13T21:30:00.000Z")), NOW, true)).toBe(false);
  });

  it("follows the choice armed for the failed run over the setting", () => {
    const armed = (autoResume: boolean) =>
      thread("a", {
        ...limited("2026-10-14T01:00:00.000Z"),
        limitRecovery: {
          runId: RunId.make("a-run"),
          resetAt: "2026-10-14T01:00:00.000Z",
          autoResume,
        },
      });
    expect(threadWorks(armed(false), NOW, true)).toBe(false);
    expect(threadWorks(armed(true), NOW, false)).toBe(true);
  });
});

describe("nightSessions", () => {
  const overseer = ThreadId.make("overseer");

  it("keeps the overseer, subagents and launched threads out, and counts their work for the session", () => {
    const sessions = nightSessions(
      [
        thread("orchestrator"),
        thread("writer", { ...launchedBy("orchestrator"), activityRunStatus: "running" }),
        thread("reviewer", subagentOf("writer")),
        thread("overseer", { activityRunStatus: "running" }),
        thread("solo"),
      ],
      overseer,
      NOW,
      false,
    );
    expect(sessions.map((session) => [session.thread.id, session.works])).toEqual([
      ["orchestrator", true],
      ["solo", false],
    ]);
  });

  it("names a descendant that waits for an answer", () => {
    const [session] = nightSessions(
      [
        thread("orchestrator"),
        thread("writer", {
          ...launchedBy("orchestrator"),
          pendingRuntimeRequest: request("user_input"),
        }),
      ],
      overseer,
      NOW,
      false,
    );
    expect(session?.works).toBe(false);
    expect(session?.waitingDescendants.map((waiting) => waiting.id)).toEqual(["writer"]);
  });
});

describe("stoppedSessions", () => {
  it("reports a session that stopped, unless its own question already woke the overseer", () => {
    const sessions = nightSessions(
      [
        thread("done"),
        thread("asks", { pendingRuntimeRequest: request("user_input") }),
        thread("signed-out", { pendingRuntimeRequest: request("auth_refresh") }),
        thread("busy", { activityRunStatus: "running" }),
        thread("was-idle"),
      ],
      null,
      NOW,
      false,
    );
    const previous = new Set(["done", "asks", "signed-out", "busy"].map((id) => ThreadId.make(id)));
    expect(stoppedSessions(previous, sessions).map((session) => session.thread.id)).toEqual([
      "done",
      "signed-out",
    ]);
  });
});

describe("nextNightStep", () => {
  const launch = (title: string) => ({
    projectId: ProjectId.make("project"),
    title,
    text: `/take-card ${title}`,
    modelSelection: {
      instanceId: ProviderInstanceId.make("claude"),
      model: "claude-opus-5-5",
    } satisfies ModelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
  });
  const state = (overrides: Partial<NightState>): NightState => ({
    id: "night",
    phase: "night",
    plan: {
      overseer: {
        projectId: ProjectId.make("project"),
        modelSelection: launch("x").modelSelection,
        runtimeMode: "full-access",
      },
      briefingMinutes: 15,
      end: {
        agents: [launch("CARD-1"), launch("CARD-2")],
        queue: [launch("a"), launch("b")],
        powerOff: true,
      },
    },
    overseerThreadId: ThreadId.make("overseer"),
    startedAt: "2026-10-13T21:00:00.000Z",
    briefingEndsAt: "2026-10-13T21:15:00.000Z",
    nightStartedAt: "2026-10-13T21:10:00.000Z",
    agentsStarted: false,
    queueStarted: 0,
    endThreadIds: [],
    reportRequestedAt: null,
    doneAt: null,
    poweringOffAt: null,
    poweredOffAt: null,
    powerOffError: null,
    ...overrides,
  });

  it("starts the agents together, then the queue one prompt at a time, then asks for the report", () => {
    expect(nextNightStep(state({}))).toEqual({ type: "start-agents" });
    expect(nextNightStep(state({ phase: "ending", agentsStarted: true }))).toEqual({
      type: "start-queued",
      index: 0,
    });
    expect(nextNightStep(state({ phase: "ending", agentsStarted: true, queueStarted: 1 }))).toEqual(
      {
        type: "start-queued",
        index: 1,
      },
    );
    expect(nextNightStep(state({ phase: "ending", agentsStarted: true, queueStarted: 2 }))).toEqual(
      {
        type: "request-report",
      },
    );
    expect(nextNightStep(state({ phase: "report" }))).toEqual({ type: "finish" });
  });

  it("does nothing while the user is still in the briefing or after the night", () => {
    expect(nextNightStep(state({ phase: "briefing" }))).toBeNull();
    expect(nextNightStep(state({ phase: "done" }))).toBeNull();
  });
});
