// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
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

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";

// The wal-index header in <db>-shm: mxFrame (last valid WAL frame) at byte 16,
// nBackfill (frames already copied into the database) at byte 96.
const walFrames = (dbPath: string) => {
  const header = NodeFS.readFileSync(`${dbPath}-shm`).subarray(0, 136);
  return { mxFrame: header.readUInt32LE(16), nBackfill: header.readUInt32LE(96) };
};

it.effect("syncs the WAL when a rollback settles, not when other effects do", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-outbox-durable-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const workerId = "durable-settlement-worker";

  return Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const settle = (id: string, how: "succeed" | "fail") =>
      Effect.gen(function* () {
        const claimed = yield* outbox.claimNext({ workerId, leaseDurationMs: 30_000 });
        assert.equal(Option.getOrUndefined(claimed)?.id, id);
        const settled =
          how === "succeed"
            ? yield* outbox.succeed({ effectId: id, workerId })
            : yield* outbox.fail({ effectId: id, workerId, error: "test" });
        assert.isTrue(settled);
        return walFrames(dbPath);
      });
    const enqueueRollback = (id: string) =>
      outbox.enqueue([
        {
          id,
          commandId: CommandId.make(`command:${id}`),
          threadId: ThreadId.make(`thread:${id}`),
          request: {
            type: "provider-thread.rollback",
            providerThreadId: ProviderThreadId.make(`provider-thread:${id}`),
            checkpointId: CheckpointId.make(`checkpoint:${id}`),
            scopeId: CheckpointScopeId.make(`scope:${id}`),
          },
        },
      ]);

    yield* enqueueRollback("effect:durable-rollback-succeeded");
    const afterRollback = yield* settle("effect:durable-rollback-succeeded", "succeed");
    assert.isAbove(afterRollback.mxFrame, 0);
    assert.equal(afterRollback.nBackfill, afterRollback.mxFrame);

    yield* enqueueRollback("effect:durable-rollback-failed");
    const afterFailedRollback = yield* settle("effect:durable-rollback-failed", "fail");
    assert.equal(afterFailedRollback.nBackfill, afterFailedRollback.mxFrame);

    yield* outbox.enqueue([
      {
        id: "effect:durable-title",
        commandId: CommandId.make("command:durable-title"),
        threadId: ThreadId.make("thread:durable-title"),
        request: { type: "thread-title.generate", kind: { type: "regenerate" } },
      },
    ]);
    const afterTitle = yield* settle("effect:durable-title", "succeed");
    assert.isBelow(afterTitle.nBackfill, afterTitle.mxFrame);
  }).pipe(
    Effect.provide(
      EffectOutbox.layer.pipe(
        Layer.provideMerge(
          SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    ),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});
