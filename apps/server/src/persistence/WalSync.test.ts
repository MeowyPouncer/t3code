// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "./Sqlite.ts";
import { makeWalSync } from "./WalSync.ts";

it.effect("syncs the WAL once per batch of commits and skips it when nothing committed", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-wal-sync-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // The layer's own once-a-second loop shares the file; this instance keeps its own counter.
    const walSync = makeWalSync(dbPath);
    yield* sql`CREATE TABLE wal_sync_probe(value INTEGER)`;
    yield* sql`INSERT INTO wal_sync_probe(value) VALUES (1)`;
    assert.isTrue(yield* walSync.syncIfChanged);
    assert.isFalse(yield* walSync.syncIfChanged);
    yield* sql`INSERT INTO wal_sync_probe(value) VALUES (2)`;
    yield* sql`INSERT INTO wal_sync_probe(value) VALUES (3)`;
    assert.isTrue(yield* walSync.syncIfChanged);
    assert.isFalse(yield* walSync.syncIfChanged);
    assert.isFalse(yield* makeWalSync(NodePath.join(tempDir, "missing.sqlite")).syncIfChanged);
  }).pipe(
    Effect.provide(SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});
