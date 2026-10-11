import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";

// The server commits with synchronous=NORMAL; an effect's claim and settlement
// must commit with FULL so the WAL is synced before the effect acts outside the
// database and before a finished effect could be replayed.
it.effect("claims and settles effects in FULL-synchronous commits", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const workerId = "durable-commit-worker";
    const statements: Array<string> = [];
    const record: Statement.Transformer = (statement) =>
      Effect.sync(() => {
        statements.push(statement.compile()[0].replace(/\s+/g, " ").trim());
        return statement;
      });
    // The UPDATE of each operation, with the synchronous pragma around it.
    const recorded = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        statements.length = 0;
        const result = yield* operation.pipe(
          Effect.provideService(Statement.CurrentTransformer, record),
        );
        const update = statements.findIndex((text) =>
          text.startsWith("UPDATE orchestration_v2_effect_outbox"),
        );
        assert.isAtLeast(update, 1);
        assert.equal(statements[update - 1], "PRAGMA synchronous = FULL");
        assert.equal(statements[update + 1], "PRAGMA synchronous = NORMAL");
        return result;
      });
    const rollback = (id: string) => ({
      id,
      commandId: CommandId.make(`command:${id}`),
      threadId: ThreadId.make(`thread:${id}`),
      request: {
        type: "provider-thread.rollback" as const,
        providerThreadId: ProviderThreadId.make(`provider-thread:${id}`),
        checkpointId: CheckpointId.make(`checkpoint:${id}`),
        scopeId: CheckpointScopeId.make(`scope:${id}`),
      },
    });

    yield* outbox.enqueue([
      rollback("effect:durable-a-succeed"),
      rollback("effect:durable-b-fail"),
    ]);
    const first = yield* recorded(outbox.claimNext({ workerId, leaseDurationMs: 30_000 }));
    assert.equal(Option.getOrUndefined(first)?.id, "effect:durable-a-succeed");
    assert.isTrue(
      yield* recorded(outbox.succeed({ effectId: "effect:durable-a-succeed", workerId })),
    );
    const second = yield* recorded(outbox.claimNext({ workerId, leaseDurationMs: 30_000 }));
    assert.equal(Option.getOrUndefined(second)?.id, "effect:durable-b-fail");
    assert.isTrue(
      yield* recorded(outbox.fail({ effectId: "effect:durable-b-fail", workerId, error: "test" })),
    );
    // An empty claim still runs inside the pragmas and leaves NORMAL behind.
    assert.isTrue(
      Option.isNone(yield* recorded(outbox.claimNext({ workerId, leaseDurationMs: 1 }))),
    );
    const sync = yield* sql<{ readonly synchronous: number }>`PRAGMA synchronous`;
    assert.equal(sync[0]?.synchronous, 1);
  }).pipe(
    Effect.provide(EffectOutbox.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
  ),
);
