import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceHardCap,
  ServerSettings,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import {
  hardCapFor,
  providerInstanceHardCapInForce,
  UNKNOWN_HARD_CAP,
} from "./provider/ProviderInstanceHardCap.ts";
import * as ServerSettingsModule from "./serverSettings.ts";

const layerEnvironment = Layer.mergeAll(
  ServerSecretStore.layer,
  Layer.fresh(SqlitePersistence.layerMemory),
).pipe(
  Layer.provideMerge(
    Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-hard-caps-test-" })),
  ),
);

const decodeSettingsJson = Schema.decodeUnknownEffect(Schema.fromJsonString(ServerSettings));

const antigravity = ProviderInstanceId.make("antigravity");
const agyWork = ProviderInstanceId.make("agy-work");
const codex = ProviderInstanceId.make("codex");
const unknown = ProviderInstanceId.make("never-configured");
const agyCap: ProviderInstanceHardCap = {
  maxRuntimeMode: "approval-required",
  declineFileChanges: true,
  withheldCapabilities: ["orchestration", "pull-requests"],
};

const settingsJson = (cap: ProviderInstanceHardCap | undefined) =>
  JSON.stringify({
    providerInstances: {
      [antigravity]: { driver: "antigravity", ...(cap === undefined ? {} : { hardCap: cap }) },
      [agyWork]: {
        driver: "antigravity",
        displayName: "Work",
        ...(cap === undefined ? {} : { hardCap: cap }),
      },
      [codex]: { driver: "codex" },
    },
  });
const cappedSettingsJson = settingsJson(agyCap);
const uncappedSettingsJson = settingsJson(undefined);

/** A settings service that has not read the file yet, as after a restart. */
const freshSettingsService = Effect.gen(function* () {
  const context = yield* Layer.build(Layer.fresh(ServerSettingsModule.layer));
  return Context.get(context, ServerSettingsModule.ServerSettingsService);
});

const capsIn = (service: ServerSettingsModule.ServerSettingsService["Service"]) =>
  Effect.gen(function* () {
    const caps = yield* service.getHardCaps!;
    return (instanceId: ProviderInstanceId) => hardCapFor(caps, instanceId);
  });

const paths = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const directory = path.dirname(config.settingsPath);
  return {
    settings: config.settingsPath,
    hardCaps: path.join(directory, "provider-hard-caps.json"),
    readOnly: path.join(directory, "read-only"),
  };
});

/**
 * Leaves the remembered caps readable but not replaceable: moved into a
 * read-only directory and linked back, so a rewrite fails at the rename.
 */
const freezeRememberedHardCaps = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { hardCaps, readOnly } = yield* paths;
  yield* fs.makeDirectory(readOnly);
  const frozen = path.join(readOnly, "provider-hard-caps.json");
  yield* fs.rename(hardCaps, frozen);
  yield* fs.symlink(frozen, hardCaps);
  yield* fs.chmod(readOnly, 0o500);
  yield* Effect.addFinalizer(() => fs.chmod(readOnly, 0o700).pipe(Effect.ignore));
});

it.layer(NodeServices.layer)("server settings hard caps", (it) => {
  it.effect(
    "keeps the last valid hard caps by instance id when settings.json fails to decode",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const { settings, hardCaps } = yield* paths;
          yield* fs.writeFileString(settings, cappedSettingsJson);
          const valid = yield* freshSettingsService;
          assert.deepEqual((yield* capsIn(valid))(antigravity), agyCap);
          assert.isTrue(yield* fs.exists(hardCaps), "the caps are remembered");

          for (const broken of [
            // Malformed JSON.
            `{ "providerInstances": { "antigravity": `,
            // Valid JSON with an invalid, unrelated field.
            `${cappedSettingsJson.slice(0, -1)}, "responseStreamingMode": 42 }`,
          ]) {
            yield* fs.writeFileString(settings, broken);
            const service = yield* freshSettingsService;
            const loaded = yield* service.getSettings;
            // The built-in instance shows its cap; the custom one is not listed.
            assert.deepEqual(loaded.providerInstances[antigravity]?.hardCap, agyCap, broken);
            assert.isUndefined(loaded.providerInstances[agyWork], broken);
            const capOf = yield* capsIn(service);
            assert.deepEqual(capOf(antigravity), agyCap, broken);
            // A custom instance keeps its cap by id, so a session minted before
            // the settings broke does not get its tools back.
            assert.deepEqual(capOf(agyWork), agyCap, broken);
            assert.deepEqual(
              yield* providerInstanceHardCapInForce(service, agyWork),
              agyCap,
              broken,
            );
            // An instance the last valid settings knew uncapped stays uncapped:
            // the orchestrator keeps its tools.
            assert.deepEqual(capOf(codex), {}, broken);
            // One they did not know runs under the strictest cap.
            assert.deepEqual(capOf(unknown), UNKNOWN_HARD_CAP, broken);
          }

          // Valid settings without caps are the user's word: the caps go.
          yield* fs.writeFileString(settings, uncappedSettingsJson);
          const uncapped = yield* freshSettingsService;
          assert.isUndefined((yield* capsIn(uncapped))(agyWork));
          yield* fs.writeFileString(settings, `{ "providerInstances": `);
          const capOf = yield* capsIn(yield* freshSettingsService);
          assert.deepEqual(capOf(agyWork), {});
          assert.deepEqual(capOf(codex), {});
        }),
      ).pipe(Effect.provide(layerEnvironment)),
  );

  it.effect("remembers caps a settings write sets", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { settings } = yield* paths;
        const service = yield* freshSettingsService;
        yield* service.updateSettings({
          providerInstances: {
            [antigravity]: { driver: ProviderDriverKind.make("antigravity"), hardCap: agyCap },
          },
        });
        yield* fs.writeFileString(settings, "not json");
        assert.deepEqual((yield* capsIn(yield* freshSettingsService))(antigravity), agyCap);
      }),
    ).pipe(Effect.provide(layerEnvironment)),
  );

  it.effect("does not save settings whose caps cannot be remembered", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { settings, hardCaps } = yield* paths;
        yield* fs.writeFileString(settings, uncappedSettingsJson);
        const service = yield* freshSettingsService;
        yield* service.getSettings;
        yield* freezeRememberedHardCaps;

        const error = yield* Effect.flip(
          service.updateSettings({
            providerInstances: {
              [antigravity]: { driver: ProviderDriverKind.make("antigravity"), hardCap: agyCap },
            },
          }),
        );
        assert.deepInclude(error, { operation: "write-file", settingsPath: hardCaps });
        // Neither file took the new cap, so no remembered caps are older
        // than the settings, and the service still serves the old ones.
        const onDisk = yield* decodeSettingsJson(yield* fs.readFileString(settings));
        assert.isUndefined(onDisk.providerInstances[antigravity]?.hardCap);
        assert.isUndefined((yield* service.getSettings).providerInstances[antigravity]?.hardCap);
      }),
    ).pipe(Effect.provide(layerEnvironment)),
  );

  it.effect("puts the remembered caps back when the settings write fails after them", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { settings, readOnly } = yield* paths;
        yield* fs.writeFileString(settings, cappedSettingsJson);
        const service = yield* freshSettingsService;
        yield* service.getSettings;
        // settings.json stays readable but cannot be replaced.
        yield* fs.makeDirectory(readOnly);
        const frozen = path.join(readOnly, "settings.json");
        yield* fs.rename(settings, frozen);
        yield* fs.symlink(frozen, settings);
        yield* fs.chmod(readOnly, 0o500);
        yield* Effect.addFinalizer(() => fs.chmod(readOnly, 0o700).pipe(Effect.ignore));

        // A save that drops the caps remembers that first, then fails.
        const error = yield* Effect.flip(
          service.updateSettings({
            providerInstances: { [codex]: { driver: ProviderDriverKind.make("codex") } },
          }),
        );
        assert.deepInclude(error, { operation: "write-file", settingsPath: settings });

        yield* fs.chmod(readOnly, 0o700);
        yield* fs.writeFileString(frozen, `{ "providerInstances": `);
        const capOf = yield* capsIn(yield* freshSettingsService);
        assert.deepEqual(capOf(antigravity), agyCap, "the caps of the file still on disk");
        assert.deepEqual(capOf(agyWork), agyCap);
      }),
    ).pipe(Effect.provide(layerEnvironment)),
  );

  it.effect("discards remembered caps it cannot bring up to date with valid settings", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { settings, hardCaps } = yield* paths;
        yield* fs.writeFileString(settings, uncappedSettingsJson);
        yield* (yield* freshSettingsService).getSettings;
        yield* freezeRememberedHardCaps;
        // Caps added by hand; the uncapped ones remembered cannot be replaced.
        yield* fs.writeFileString(settings, cappedSettingsJson);
        yield* (yield* freshSettingsService).getSettings;
        assert.isFalse(yield* fs.exists(hardCaps), "the older caps are discarded");

        // The older, uncapped caps never come back: nothing is remembered,
        // so broken settings run every instance under the strictest cap.
        yield* fs.writeFileString(settings, `{ "providerInstances": `);
        const service = yield* freshSettingsService;
        assert.deepEqual(
          yield* providerInstanceHardCapInForce(service, antigravity),
          UNKNOWN_HARD_CAP,
        );
        assert.deepEqual(yield* providerInstanceHardCapInForce(service, agyWork), UNKNOWN_HARD_CAP);
      }),
    ).pipe(Effect.provide(layerEnvironment)),
  );

  it.effect("prefers a valid settings file to older remembered caps when loading fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const sql = yield* SqlClient.SqlClient;
        const { settings } = yield* paths;
        yield* fs.writeFileString(settings, uncappedSettingsJson);
        yield* (yield* freshSettingsService).getSettings;
        // Caps added by hand, then loading fails before they are remembered.
        yield* fs.writeFileString(settings, cappedSettingsJson);
        yield* sql`DROP TABLE projection_thread_sessions`;
        const service = yield* freshSettingsService;
        assert.equal((yield* Effect.flip(service.getSettings)).operation, "read-provider-history");
        const capOf = yield* capsIn(service);
        assert.deepEqual(capOf(antigravity), agyCap);
        assert.deepEqual(capOf(agyWork), agyCap);
      }),
    ).pipe(Effect.provide(layerEnvironment)),
  );

  it.effect("applies the remembered caps when settings.json cannot be read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { settings } = yield* paths;
        yield* fs.writeFileString(settings, cappedSettingsJson);
        yield* (yield* freshSettingsService).getSettings;
        // A directory where the file should be makes the read itself fail.
        yield* fs.remove(settings);
        yield* fs.makeDirectory(settings);

        const service = yield* freshSettingsService;
        assert.equal((yield* Effect.flip(service.getSettings)).operation, "read-file");
        const capOf = yield* capsIn(service);
        assert.deepEqual(capOf(antigravity), agyCap);
        assert.deepEqual(capOf(agyWork), agyCap);
        assert.deepEqual(capOf(codex), {});
        assert.deepEqual(capOf(unknown), UNKNOWN_HARD_CAP);
      }),
    ).pipe(Effect.provide(layerEnvironment)),
  );

  it.effect("fails closed when settings.json is invalid and no caps are remembered", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { settings } = yield* paths;
        yield* fs.writeFileString(settings, `{ "providerInstances": `);
        const service = yield* freshSettingsService;
        // The rest of the server still gets defaults.
        yield* service.getSettings;
        assert.equal((yield* Effect.flip(service.getHardCaps!))._tag, "ServerSettingsError");
        assert.deepEqual(yield* providerInstanceHardCapInForce(service, codex), UNKNOWN_HARD_CAP);

        // A fresh start (no file, nothing remembered) caps nothing.
        yield* fs.remove(settings);
        const fresh = yield* freshSettingsService;
        assert.isUndefined((yield* capsIn(fresh))(codex));
        assert.isUndefined(yield* providerInstanceHardCapInForce(fresh, codex));
      }),
    ).pipe(Effect.provide(layerEnvironment)),
  );
});
