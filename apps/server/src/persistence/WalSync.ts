// @effect-diagnostics nodeBuiltinImport:off - a worker thread that fdatasyncs the WAL, which effect/FileSystem does not expose
import * as NodeWorkerThreads from "node:worker_threads";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

// FORK: the server commits with synchronous=NORMAL, where SQLite syncs the WAL
// only at checkpoints (every ~40 MB). Syncing it once a second bounds what a
// power loss or OS crash can take to the last second (group commit), at one
// fdatasync a second instead of one per commit; with nothing new to write, the
// call does no I/O. A worker thread does it, so a main thread blocked in a
// synchronous SQLite call (a busy wait lasts up to busy_timeout) cannot delay
// it. Only the -wal is opened: SQLite keeps POSIX locks on the database and
// -shm files, and closing any descriptor of those in this process would drop them.
export const WAL_SYNC_INTERVAL = Duration.seconds(1);

const WORKER_SOURCE = `
const { workerData, parentPort } = require("node:worker_threads");
const fs = require("node:fs");
let reported = false;
const report = (error) => {
  if (reported) return;
  reported = true;
  parentPort.postMessage(String((error && error.message) || error));
};
setInterval(() => {
  let fd;
  try {
    // Write access: Windows needs it to flush a file.
    fd = fs.openSync(workerData.walPath, "r+");
  } catch (error) {
    if (error.code !== "ENOENT") report(error);
    return;
  }
  try {
    fs.fdatasyncSync(fd);
    reported = false;
  } catch (error) {
    report(error);
  } finally {
    fs.closeSync(fd);
  }
}, workerData.intervalMs);
`;

/** The WAL SQLite itself uses: its canonical database path (symlinks resolved) plus "-wal". */
export const walPathOf = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const databases = yield* sql<{ readonly name: string; readonly file: string }>`
    PRAGMA database_list
  `;
  const file = databases.find((database) => database.name === "main")?.file;
  return file === undefined || file === "" ? undefined : `${file}-wal`;
});

export const layer: Layer.Layer<never, never, SqlClient.SqlClient> = Layer.effectDiscard(
  Effect.gen(function* () {
    const walPath = yield* walPathOf.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Cannot locate the SQLite WAL to sync", { cause }).pipe(
          Effect.as(undefined),
        ),
      ),
    );
    if (walPath === undefined) return;
    const worker = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new NodeWorkerThreads.Worker(WORKER_SOURCE, {
            eval: true,
            workerData: { walPath, intervalMs: Duration.toMillis(WAL_SYNC_INTERVAL) },
          }),
      ),
      (worker) => Effect.promise(() => worker.terminate()),
    );
    // Logging with this layer's context keeps the server's loggers. The worker
    // reports the first failure of a run of failures.
    const log = Effect.runForkWith(yield* Effect.context<never>());
    worker.unref();
    worker.on("message", (message) => {
      log(Effect.logWarning("Failed to sync the SQLite WAL", { walPath, message }));
    });
    worker.on("error", (cause) => {
      log(Effect.logWarning("The SQLite WAL sync worker stopped", { walPath, cause }));
    });
  }),
);
