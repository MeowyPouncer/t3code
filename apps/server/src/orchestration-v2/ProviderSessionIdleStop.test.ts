// FORK (T3MIG-FORK-014): what keeps a thread's idle provider session open.
import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  idleStopHoldsFromRecords,
  type IdleStopThreadRecords,
  idleStopTimeoutMs,
  threadIdleStopHolds,
} from "./ProviderSessionIdleStop.ts";
import {
  ProjectionStoreReadError,
  ProjectionStoreThreadNotFoundError,
  type ProjectionStoreV2Shape,
} from "./ProjectionStore.ts";

const EMPTY: IdleStopThreadRecords = { runs: [], runtimeRequests: [], subagents: [] };

const delegated = (
  status: IdleStopThreadRecords["subagents"][number]["status"],
  childThreadId: string | null = null,
) => ({
  origin: "app_owned" as const,
  status,
  childThreadId: childThreadId === null ? null : ThreadId.make(childThreadId),
});

const storeOf = (
  threads: Record<string, IdleStopThreadRecords | "unreadable">,
): Pick<ProjectionStoreV2Shape, "getThreadRecords"> => ({
  getThreadRecords: (threadId) => {
    const records = threads[threadId];
    if (records === undefined)
      return Effect.fail(new ProjectionStoreThreadNotFoundError({ threadId }));
    if (records === "unreadable") return Effect.fail(new ProjectionStoreReadError({ threadId }));
    return Effect.succeed(records as never);
  },
});

describe("idle stop window", () => {
  it("turns minutes into milliseconds, and off, null or 0 into never", () => {
    assert.equal(idleStopTimeoutMs(30), 30 * 60 * 1000);
    assert.equal(idleStopTimeoutMs(1), 60 * 1000);
    assert.isNull(idleStopTimeoutMs(0));
    assert.isNull(idleStopTimeoutMs(null));
    assert.isNull(idleStopTimeoutMs(undefined));
  });
});

describe("idle stop holds of one thread", () => {
  it("holds nothing for a settled thread", () => {
    assert.deepEqual(
      idleStopHoldsFromRecords({
        runs: [{ status: "completed" }, { status: "interrupted" }],
        runtimeRequests: [{ status: "resolved" }, { status: "expired" }],
        subagents: [delegated("completed"), { ...delegated("running"), origin: "provider_native" }],
      }).holds,
      [],
    );
  });

  it.each(["preparing", "queued", "starting", "running", "waiting"] as const)(
    "holds while a run is %s",
    (status) => {
      assert.deepEqual(idleStopHoldsFromRecords({ ...EMPTY, runs: [{ status }] }).holds, [
        "active_run",
      ]);
    },
  );

  it("lets a queue held after a restart go", () => {
    assert.deepEqual(
      idleStopHoldsFromRecords({ ...EMPTY, runs: [{ status: "queued", queueHeld: true }] }).holds,
      [],
    );
  });

  it("holds while an approval or question is pending", () => {
    assert.deepEqual(
      idleStopHoldsFromRecords({ ...EMPTY, runtimeRequests: [{ status: "pending" }] }).holds,
      ["pending_request"],
    );
  });

  it.each(["idle", "pending", "running", "waiting"] as const)(
    "holds while a delegated child is %s",
    (status) => {
      assert.deepEqual(
        idleStopHoldsFromRecords({ ...EMPTY, subagents: [delegated(status, "child")] }).holds,
        ["delegated_work"],
      );
    },
  );

  it("names finished children so their own children can be read", () => {
    const result = idleStopHoldsFromRecords({
      ...EMPTY,
      subagents: [delegated("completed", "child-a"), delegated("failed", "child-b")],
    });
    assert.deepEqual(result.holds, []);
    assert.deepEqual(result.finishedChildThreadIds, [
      ThreadId.make("child-a"),
      ThreadId.make("child-b"),
    ]);
  });
});

describe("idle stop holds through delegation", () => {
  const parent = ThreadId.make("parent");

  it.effect("holds an orchestrator while its child works", () =>
    Effect.gen(function* () {
      const holds = yield* threadIdleStopHolds(
        storeOf({ parent: { ...EMPTY, subagents: [delegated("running", "child")] } }),
        parent,
      );
      assert.deepEqual(holds, ["delegated_work"]);
    }),
  );

  it.effect("holds an orchestrator while a finished child waits for its own children", () =>
    Effect.gen(function* () {
      const holds = yield* threadIdleStopHolds(
        storeOf({
          parent: { ...EMPTY, subagents: [delegated("completed", "child")] },
          child: { ...EMPTY, subagents: [delegated("running", "grandchild")] },
        }),
        parent,
      );
      assert.deepEqual(holds, ["delegated_work"]);
    }),
  );

  it.effect("lets go once every child and grandchild has finished", () =>
    Effect.gen(function* () {
      const holds = yield* threadIdleStopHolds(
        storeOf({
          parent: { ...EMPTY, subagents: [delegated("completed", "child")] },
          child: { ...EMPTY, subagents: [delegated("completed", "grandchild")] },
          grandchild: { ...EMPTY, runs: [{ status: "completed" }] },
        }),
        parent,
      );
      assert.deepEqual(holds, []);
    }),
  );

  it.effect("lets go of a thread that no longer exists", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* threadIdleStopHolds(storeOf({}), parent), []);
      const holds = yield* threadIdleStopHolds(
        storeOf({ parent: { ...EMPTY, subagents: [delegated("completed", "deleted-child")] } }),
        parent,
      );
      assert.deepEqual(holds, []);
    }),
  );

  it.effect("holds when a thread or child cannot be read", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* threadIdleStopHolds(storeOf({ parent: "unreadable" }), parent), [
        "unknown",
      ]);
      const holds = yield* threadIdleStopHolds(
        storeOf({
          parent: { ...EMPTY, subagents: [delegated("completed", "child")] },
          child: "unreadable",
        }),
        parent,
      );
      assert.deepEqual(holds, ["unknown"]);
    }),
  );

  it.effect("reads a delegation cycle once", () =>
    Effect.gen(function* () {
      const holds = yield* threadIdleStopHolds(
        storeOf({
          parent: { ...EMPTY, subagents: [delegated("completed", "child")] },
          child: { ...EMPTY, subagents: [delegated("completed", "parent")] },
        }),
        parent,
      );
      assert.deepEqual(holds, []);
    }),
  );
});
