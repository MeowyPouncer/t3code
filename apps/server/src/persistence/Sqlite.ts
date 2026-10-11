import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "./Migrations.ts";
import { initializeV2Database } from "./initializeV2Database.ts";
import * as WalSync from "./WalSync.ts";
import * as ServerConfig from "../config.ts";

// Size the -wal file is cut back to on the first commit after a WAL reset.
// Above the auto-checkpoint size, so a normal cycle never truncates and regrows it.
export const WAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;
// WAL pages that trigger a PASSIVE checkpoint (SQLite's default is 1000, about 4 MB).
// Every event rewrites the same hot pages (rightmost index leaves, sqlite_sequence,
// projection metadata, the thread row); a longer WAL copies each of them back into
// the database once per ~40 MB instead of once per ~4 MB.
export const WAL_AUTOCHECKPOINT_PAGES = 10_000;
// Page cache per connection in KiB (SQLite's default is 2 MiB for a 5 GB database).
export const PAGE_CACHE_KIB = 64 * 1024;

const layerSetup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // CLI and server write from separate processes; wait rather than fail with SQLITE_BUSY.
    yield* sql`PRAGMA busy_timeout = 5000;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    yield* sql`PRAGMA journal_mode = WAL;`;
    // The default FULL fsyncs the WAL on every commit, which is about one fsync per
    // event. NORMAL syncs at checkpoints, and layerFromPath adds a sync at most once
    // a second (WalSync.ts): a power loss or OS crash can drop the last second of
    // commits, an application crash cannot, and the database stays intact. Outbox
    // claims and settlements still commit with FULL (EffectOutbox.ts).
    yield* sql`PRAGMA synchronous = NORMAL;`;
    yield* sql.unsafe(`PRAGMA wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES};`);
    yield* sql.unsafe(`PRAGMA cache_size = -${PAGE_CACHE_KIB};`);
    yield* sql`PRAGMA temp_store = MEMORY;`;
    // PASSIVE checkpoints never shrink the -wal file, so it otherwise keeps its
    // largest size until the last connection closes.
    yield* sql.unsafe(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};`);
    yield* runMigrations();
  }),
);

export const layerFromPath = Effect.fn("makeSqlitePersistenceLive")(function* (dbPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

  return Layer.merge(
    Layer.provideMerge(
      layerSetup,
      NodeSqliteClient.layer({
        filename: dbPath,
        spanAttributes: {
          "db.name": path.basename(dbPath),
          "service.name": "t3code-server",
        },
      }),
    ),
    WalSync.layer(dbPath),
  );
}, Layer.unwrap);

export const layerMemory = Layer.provideMerge(
  layerSetup,
  NodeSqliteClient.layer({ filename: ":memory:" }),
);

export const layerConfig = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig.ServerConfig;
    yield* initializeV2Database(dbPath);
    return layerFromPath(dbPath);
  }),
);
