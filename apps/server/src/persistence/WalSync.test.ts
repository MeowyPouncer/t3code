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
import { walPathOf } from "./WalSync.ts";

it.effect("syncs the WAL SQLite uses, behind a symlinked directory", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-wal-sync-"));
  const realDir = NodePath.join(tempDir, "real");
  const linkDir = NodePath.join(tempDir, "link");
  NodeFS.mkdirSync(realDir);
  NodeFS.symlinkSync(realDir, linkDir);

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE wal_sync_probe(value INTEGER)`;
    yield* sql`INSERT INTO wal_sync_probe(value) VALUES (1)`;
    const walPath = yield* walPathOf;
    assert.equal(walPath, NodePath.join(NodeFS.realpathSync(realDir), "state.sqlite-wal"));
    assert.isTrue(NodeFS.existsSync(walPath!));
  }).pipe(
    Effect.provide(
      SqlitePersistence.layerFromPath(NodePath.join(linkDir, "state.sqlite")).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("has no WAL to sync for an in-memory database", () =>
  Effect.gen(function* () {
    assert.isUndefined(yield* walPathOf);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
