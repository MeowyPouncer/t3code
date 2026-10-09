import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceHardCap,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import {
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

const antigravity = ProviderInstanceId.make("antigravity");
const agyWork = ProviderInstanceId.make("agy-work");
const codex = ProviderInstanceId.make("codex");
const agyCap: ProviderInstanceHardCap = {
  maxRuntimeMode: "approval-required",
  declineFileChanges: true,
  withheldCapabilities: ["orchestration", "pull-requests"],
};

const validSettingsJson = JSON.stringify({
  providerInstances: {
    [antigravity]: { driver: "antigravity", hardCap: agyCap },
    [agyWork]: { driver: "antigravity", displayName: "Work", hardCap: agyCap },
    [codex]: { driver: "codex" },
  },
});

/** A settings service that has not read the file yet, as after a restart. */
const freshSettingsService = Effect.gen(function* () {
  const context = yield* Layer.build(Layer.fresh(ServerSettingsModule.layer));
  return Context.get(context, ServerSettingsModule.ServerSettingsService);
});

const hardCapsPath = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(path.dirname(config.settingsPath), "provider-hard-caps.json");
});

it.layer(NodeServices.layer)("server settings hard caps", (it) => {
  it.effect("keeps the last valid hard caps when settings.json later fails to decode", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(config.settingsPath, validSettingsJson);
        const valid = yield* freshSettingsService;
        assert.deepEqual(
          (yield* valid.getSettings).providerInstances[antigravity]?.hardCap,
          agyCap,
        );
        assert.isTrue(yield* fs.exists(yield* hardCapsPath), "the caps are remembered");

        for (const broken of [
          // Malformed JSON.
          `{ "providerInstances": { "antigravity": `,
          // Valid JSON with an invalid, unrelated field.
          `${validSettingsJson.slice(0, -1)}, "responseStreamingMode": 42 }`,
        ]) {
          yield* fs.writeFileString(config.settingsPath, broken);
          const service = yield* freshSettingsService;
          const settings = yield* service.getSettings;
          // The built-in instance keeps its cap; the custom one is gone with
          // the settings that named it, so there is nothing left to cap.
          assert.deepEqual(settings.providerInstances[antigravity]?.hardCap, agyCap, broken);
          assert.isUndefined(settings.providerInstances[agyWork], broken);
          const caps = yield* service.getHardCaps!;
          assert.deepEqual(caps[antigravity], agyCap, broken);
          // An uncapped instance stays uncapped: the orchestrator keeps its tools.
          assert.isUndefined(yield* providerInstanceHardCapInForce(service, codex), broken);
          assert.deepEqual(
            yield* providerInstanceHardCapInForce(service, antigravity),
            agyCap,
            broken,
          );
        }

        // Valid settings without caps are the user's word: the caps go.
        yield* fs.writeFileString(
          config.settingsPath,
          JSON.stringify({ providerInstances: { [codex]: { driver: "codex" } } }),
        );
        const uncapped = yield* freshSettingsService;
        assert.deepEqual(yield* uncapped.getHardCaps!, {});
        yield* fs.writeFileString(config.settingsPath, `{ "providerInstances": `);
        assert.deepEqual(yield* (yield* freshSettingsService).getHardCaps!, {});
      }),
    ).pipe(Effect.provide(layerEnvironment)),
  );

  it.effect("remembers caps a settings write sets", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const service = yield* freshSettingsService;
        yield* service.updateSettings({
          providerInstances: {
            [antigravity]: { driver: ProviderDriverKind.make("antigravity"), hardCap: agyCap },
          },
        });
        yield* fs.writeFileString(config.settingsPath, "not json");
        assert.deepEqual((yield* (yield* freshSettingsService).getHardCaps!)[antigravity], agyCap);
      }),
    ).pipe(Effect.provide(layerEnvironment)),
  );

  it.effect("applies the remembered caps when settings.json cannot be read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(config.settingsPath, validSettingsJson);
        yield* (yield* freshSettingsService).getSettings;
        // A directory where the file should be makes the read itself fail.
        yield* fs.remove(config.settingsPath);
        yield* fs.makeDirectory(config.settingsPath);

        const service = yield* freshSettingsService;
        const error = yield* Effect.flip(service.getSettings);
        assert.equal(error.operation, "read-file");
        const caps = yield* service.getHardCaps!;
        assert.deepEqual(caps[antigravity], agyCap);
        assert.deepEqual(caps[agyWork], agyCap);
        assert.isUndefined(yield* providerInstanceHardCapInForce(service, codex));
      }),
    ).pipe(Effect.provide(layerEnvironment)),
  );

  it.effect("fails closed when settings.json is invalid and no caps are remembered", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(config.settingsPath, `{ "providerInstances": `);
        const service = yield* freshSettingsService;
        // The rest of the server still gets defaults.
        yield* service.getSettings;
        assert.equal((yield* Effect.flip(service.getHardCaps!))._tag, "ServerSettingsError");
        assert.deepEqual(yield* providerInstanceHardCapInForce(service, codex), UNKNOWN_HARD_CAP);

        // A fresh start (no file, nothing remembered) caps nothing.
        yield* fs.remove(config.settingsPath);
        const fresh = yield* freshSettingsService;
        assert.deepEqual(yield* fresh.getHardCaps!, {});
        assert.isUndefined(yield* providerInstanceHardCapInForce(fresh, codex));
      }),
    ).pipe(Effect.provide(layerEnvironment)),
  );
});
