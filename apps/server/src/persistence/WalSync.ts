// @effect-diagnostics nodeBuiltinImport:off - fdatasync on the WAL, which effect/FileSystem does not expose
import * as NodeFSP from "node:fs/promises";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

// FORK: the server commits with synchronous=NORMAL, where SQLite syncs the WAL
// only at checkpoints (every ~40 MB). Syncing it at most once a second bounds
// what a power loss or OS crash can take to the last second (group commit), at
// one fdatasync a second under load instead of one per commit. The sync runs on
// the libuv pool, so the main thread never waits for it.
export const WAL_SYNC_INTERVAL = Duration.seconds(1);

// iChange in the wal-index header (<db>-shm, byte 8): SQLite bumps it on every commit.
const readCommitCounter = async (shmPath: string) => {
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(shmPath, "r");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  }
  try {
    const counter = Buffer.alloc(4);
    const { bytesRead } = await handle.read(counter, 0, 4, 8);
    return bytesRead === 4 ? counter.readUInt32LE(0) : undefined;
  } finally {
    await handle.close();
  }
};

export const makeWalSync = (dbPath: string) => {
  let syncedCounter: number | undefined;
  /** Syncs the WAL when a commit happened since the last sync; true when it synced. */
  const syncIfChanged = Effect.tryPromise(async () => {
    // Read before the sync: a commit landing during it bumps the counter again,
    // so the next tick syncs it.
    const counter = await readCommitCounter(`${dbPath}-shm`);
    if (counter === undefined || counter === syncedCounter) return false;
    let wal: NodeFSP.FileHandle;
    try {
      wal = await NodeFSP.open(`${dbPath}-wal`, "r");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw cause;
    }
    try {
      await wal.datasync();
    } finally {
      await wal.close();
    }
    syncedCounter = counter;
    return true;
  });
  return { syncIfChanged };
};

export const layer = (dbPath: string) =>
  Layer.effectDiscard(
    Effect.forkScoped(
      makeWalSync(dbPath).syncIfChanged.pipe(
        Effect.catch((cause) => Effect.logWarning("Failed to sync the SQLite WAL", { cause })),
        Effect.repeat(Schedule.spaced(WAL_SYNC_INTERVAL)),
      ),
    ),
  );
