// FORK (T3MIG-FORK-014): what keeps a thread's idle provider session open.
import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
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
const at = (ms: number) => DateTime.makeUnsafe(ms);
const T0 = at(1_000_000);

type Task = IdleStopThreadRecords["subagents"][number];

const delegated = (
  status: Task["status"],
  childThreadId: string | null = null,
  completedAt: DateTime.Utc | null = null,
): Task => ({
  origin: "app_owned",
  status,
  childThreadId: childThreadId === null ? null : ThreadId.make(childThreadId),
  completedAt,
  updatedAt: completedAt ?? T0,
});

const run = (
  status: IdleStopThreadRecords["runs"][number]["status"],
  completedAt: number | null,
) => ({
  status,
  completedAt: completedAt === null ? null : at(completedAt),
});

const storeOf = (
  threads: Record<string, IdleStopThreadRecords | "unreadable">,
): Pick<ProjectionStoreV2Shape, "getThreadRecords"> => ({
  getThreadRecords: (threadId) => {
    const records = threads[threadId];
    if (records === undefined) {
      return Effect.fail(new ProjectionStoreThreadNotFoundError({ threadId }));
    }
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
        runs: [run("completed", 1), run("interrupted", 2)],
        runtimeRequests: [
          { status: "resolved", resolvedAt: at(3) },
          { status: "expired", resolvedAt: at(4) },
        ],
        subagents: [delegated("completed"), { ...delegated("running"), origin: "provider_native" }],
      }).holds,
      [],
    );
  });

  it.each(["preparing", "queued", "starting", "running", "waiting"] as const)(
    "holds while a run is %s",
    (status) => {
      assert.deepEqual(idleStopHoldsFromRecords({ ...EMPTY, runs: [run(status, null)] }).holds, [
        "active_run",
      ]);
    },
  );

  it("lets a queue held after a restart go", () => {
    assert.deepEqual(
      idleStopHoldsFromRecords({
        ...EMPTY,
        runs: [{ status: "queued", queueHeld: true, completedAt: null }],
      }).holds,
      [],
    );
  });

  it("holds while an approval or question is pending", () => {
    assert.deepEqual(
      idleStopHoldsFromRecords({
        ...EMPTY,
        runtimeRequests: [{ status: "pending", resolvedAt: null }],
      }).holds,
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

  it("dates the last hold's end: a run's completion, an answer, a child's end", () => {
    const records: IdleStopThreadRecords = {
      runs: [run("completed", 1_000)],
      runtimeRequests: [{ status: "resolved", resolvedAt: at(5_000) }],
      subagents: [delegated("completed", null, at(3_000))],
    };
    assert.equal(idleStopHoldsFromRecords(records).lastHeldAtMs, 5_000);
    assert.equal(
      idleStopHoldsFromRecords({ ...records, subagents: [delegated("completed", null, at(9_000))] })
        .lastHeldAtMs,
      9_000,
    );
    assert.isNull(idleStopHoldsFromRecords(EMPTY).lastHeldAtMs);
  });
});

describe("idle stop holds through delegation", () => {
  const parent = ThreadId.make("parent");

  it.effect("holds an orchestrator while its child works", () =>
    Effect.gen(function* () {
      const result = yield* threadIdleStopHolds(
        storeOf({ parent: { ...EMPTY, subagents: [delegated("running", "child")] } }),
        parent,
      );
      assert.deepEqual(result.holds, ["delegated_work"]);
    }),
  );

  it.effect("holds an orchestrator while a finished child waits for its own children", () =>
    Effect.gen(function* () {
      const result = yield* threadIdleStopHolds(
        storeOf({
          parent: { ...EMPTY, subagents: [delegated("completed", "child")] },
          child: { ...EMPTY, subagents: [delegated("running", "grandchild")] },
        }),
        parent,
      );
      assert.deepEqual(result.holds, ["delegated_work"]);
    }),
  );

  it.effect("lets go once every child and grandchild has finished, dated by the last", () =>
    Effect.gen(function* () {
      const result = yield* threadIdleStopHolds(
        storeOf({
          parent: { ...EMPTY, subagents: [delegated("completed", "child", at(2_000))] },
          child: { ...EMPTY, subagents: [delegated("completed", "grandchild", at(4_000))] },
          grandchild: { ...EMPTY, runs: [run("completed", 7_000)] },
        }),
        parent,
      );
      assert.deepEqual(result, { holds: [], lastHeldAtMs: 7_000 });
    }),
  );

  it.effect("lets go of a thread that no longer exists", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* threadIdleStopHolds(storeOf({}), parent), {
        holds: [],
        lastHeldAtMs: null,
      });
      const result = yield* threadIdleStopHolds(
        storeOf({ parent: { ...EMPTY, subagents: [delegated("completed", "deleted-child")] } }),
        parent,
      );
      assert.deepEqual(result.holds, []);
    }),
  );

  it.effect("holds when a thread or child cannot be read", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        (yield* threadIdleStopHolds(storeOf({ parent: "unreadable" }), parent)).holds,
        ["unknown"],
      );
      const result = yield* threadIdleStopHolds(
        storeOf({
          parent: { ...EMPTY, subagents: [delegated("completed", "child")] },
          child: "unreadable",
        }),
        parent,
      );
      assert.deepEqual(result.holds, ["unknown"]);
    }),
  );

  it.effect("reads a delegation cycle once", () =>
    Effect.gen(function* () {
      const result = yield* threadIdleStopHolds(
        storeOf({
          parent: { ...EMPTY, subagents: [delegated("completed", "child")] },
          child: { ...EMPTY, subagents: [delegated("completed", "parent")] },
        }),
        parent,
      );
      assert.deepEqual(result.holds, []);
    }),
  );
});
