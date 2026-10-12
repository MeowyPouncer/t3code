import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createInboxReturnTracker,
  sortWorkingThreadsBySend,
  workingFamilyByThread,
} from "./threadInbox.ts";

const environmentId = EnvironmentId.make("environment-1");

function thread(id: string, working: boolean) {
  return {
    id: ThreadId.make(id),
    environmentId,
    createdAt: "2026-06-01T00:00:00.000Z",
    unsettledAt: null,
    latestRun: null,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    runtime: working
      ? {
          status: "running" as const,
          activeRunId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: "Codex",
          lastError: null,
          updatedAt: "2026-06-01T00:00:00.000Z",
        }
      : null,
  };
}

describe("createInboxReturnTracker", () => {
  it("stamps a thread when it stops working, but never on the first observation", () => {
    const tracker = createInboxReturnTracker();
    tracker.observe([thread("a", true), thread("b", false)]);
    expect(tracker.returnedAt(thread("a", true))).toBeUndefined();
    expect(tracker.returnedAt(thread("b", false))).toBeUndefined();

    tracker.observe([thread("a", false), thread("b", false)]);
    expect(tracker.returnedAt(thread("a", false))).toBeDefined();
    expect(tracker.returnedAt(thread("b", false))).toBeUndefined();
  });

  it("forgets deleted threads and resets when the beta turns off", () => {
    const tracker = createInboxReturnTracker();
    tracker.observe([thread("a", true), thread("b", true)]);
    tracker.observe([thread("a", false), thread("b", false)]);
    tracker.observe([thread("b", false)]);
    expect(tracker.returnedAt(thread("a", false))).toBeUndefined();
    expect(tracker.returnedAt(thread("b", false))).toBeDefined();

    tracker.observe(null);
    expect(tracker.returnedAt(thread("b", false))).toBeUndefined();
    // After a reset the next call is a fresh baseline again.
    tracker.observe([thread("b", true)]);
    tracker.observe([thread("b", false)]);
    expect(tracker.returnedAt(thread("b", false))).toBeDefined();
  });
});

describe("sortWorkingThreadsBySend", () => {
  it("orders by the last message the user sent, not by later runs", () => {
    const sentFirst = {
      ...thread("sent-first", true),
      latestUserAuthoredMessageAt: "2026-06-01T01:00:00.000Z",
      // A wake run requested after the other thread's send.
      latestRun: {
        runId: RunId.make("run:wake"),
        status: "running" as const,
        requestedAt: "2026-06-01T04:00:00.000Z",
        startedAt: "2026-06-01T04:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    };
    const sentLast = {
      ...thread("sent-last", true),
      latestUserAuthoredMessageAt: "2026-06-01T02:00:00.000Z",
    };
    // Launched by an agent: no user message, so creation time is the send.
    const launched = { ...thread("launched", true), latestUserAuthoredMessageAt: null };
    expect(
      sortWorkingThreadsBySend([launched, sentFirst, sentLast]).map((thread) => thread.id),
    ).toEqual(["sent-last", "sent-first", "launched"]);
  });
});

// FORK: a parent reads as working while the threads working for it do.
describe("workingFamilyByThread", () => {
  const member = (
    id: string,
    working: boolean,
    relation:
      | { readonly kind: "top" }
      | { readonly kind: "launched"; readonly by: string }
      | { readonly kind: "subagent" | "fork"; readonly of: string },
  ) => ({
    id: ThreadId.make(id),
    environmentId,
    working,
    lineage:
      relation.kind === "subagent" || relation.kind === "fork"
        ? {
            parentThreadId: ThreadId.make(relation.of),
            relationshipToParent: relation.kind,
            rootThreadId: ThreadId.make(relation.of),
          }
        : { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
    ...(relation.kind === "launched" ? { launchedByThreadId: ThreadId.make(relation.by) } : {}),
  });
  const keyOf = (thread: { readonly environmentId: string; readonly id: string }) =>
    `${thread.environmentId}:${thread.id}`;
  const family = (threads: ReadonlyArray<ReturnType<typeof member>>) => {
    const byThread = workingFamilyByThread(threads, (thread) => thread.working, keyOf);
    return Object.fromEntries(
      [...byThread].map(([key, members]) => [key.split(":")[1], members.map((m) => m.id)]),
    );
  };

  it("lists working subagents and launched threads under every ancestor", () => {
    expect(
      family([
        member("orchestrator", false, { kind: "top" }),
        member("writer", false, { kind: "launched", by: "orchestrator" }),
        member("helper", true, { kind: "launched", by: "writer" }),
        member("review", true, { kind: "subagent", of: "orchestrator" }),
      ]),
    ).toEqual({
      writer: ["helper"],
      orchestrator: ["helper", "review"],
    });
  });

  it("leaves out finished children and forks", () => {
    expect(
      family([
        member("orchestrator", false, { kind: "top" }),
        member("writer", false, { kind: "launched", by: "orchestrator" }),
        member("fork", true, { kind: "fork", of: "orchestrator" }),
      ]),
    ).toEqual({});
  });

  it("stops at a launch cycle", () => {
    expect(
      family([
        member("a", true, { kind: "launched", by: "b" }),
        member("b", false, { kind: "launched", by: "a" }),
      ]),
    ).toEqual({ b: ["a"] });
  });
});
