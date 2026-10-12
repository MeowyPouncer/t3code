import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  type ProviderInstanceHardCap,
  ServerSettingsError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ServerSettingsService } from "../serverSettings.ts";
import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";
import {
  clampRuntimeModeToHardCap,
  DEFAULT_INSTANCE_DRIVERS,
  hardCapFor,
  hardCapRuntimeModeCeiling,
  hardCapWithheldCapabilities,
  providerInstanceHardCapInForce,
  readProviderInstanceHardCap,
  refusesFileChangeResponse,
  rememberedHardCapsInForce,
  rememberedHardCapsOf,
  resolveHardCappedChildRuntimeMode,
  shouldAutoDeclineRuntimeRequest,
  UNKNOWN_HARD_CAP,
  withRememberedHardCaps,
} from "./ProviderInstanceHardCap.ts";

const agyCap: ProviderInstanceHardCap = {
  maxRuntimeMode: "approval-required",
  declineFileChanges: true,
  withheldCapabilities: ["orchestration", "pull-requests"],
};

describe("ProviderInstanceHardCap", () => {
  it("reads the cap of the named instance only", () => {
    const antigravity = ProviderInstanceId.make("antigravity");
    const codex = ProviderInstanceId.make("codex");
    const instances = {
      [antigravity]: { driver: ProviderDriverKind.make("antigravity"), hardCap: agyCap },
      [codex]: { driver: ProviderDriverKind.make("codex") },
    };
    assert.deepEqual(readProviderInstanceHardCap(instances, antigravity), agyCap);
    assert.isUndefined(readProviderInstanceHardCap(instances, codex));
    assert.isUndefined(readProviderInstanceHardCap(instances, ProviderInstanceId.make("cursor")));
  });

  it("caps nothing without a cap or with an empty one", () => {
    assert.isUndefined(hardCapRuntimeModeCeiling(undefined));
    assert.isUndefined(hardCapRuntimeModeCeiling({}));
    assert.equal(clampRuntimeModeToHardCap("full-access", undefined), "full-access");
    assert.equal(clampRuntimeModeToHardCap("full-access", {}), "full-access");
    assert.deepEqual(hardCapWithheldCapabilities(undefined), []);
  });

  it("clamps a broader mode to the ceiling and keeps a narrower one", () => {
    const cap: ProviderInstanceHardCap = { maxRuntimeMode: "auto-accept-edits" };
    assert.equal(clampRuntimeModeToHardCap("full-access", cap), "auto-accept-edits");
    assert.equal(clampRuntimeModeToHardCap("auto", cap), "auto-accept-edits");
    assert.equal(clampRuntimeModeToHardCap("auto-accept-edits", cap), "auto-accept-edits");
    assert.equal(clampRuntimeModeToHardCap("approval-required", cap), "approval-required");
  });

  it("caps at Supervised when file changes are declined, whatever maxRuntimeMode says", () => {
    assert.equal(hardCapRuntimeModeCeiling({ declineFileChanges: true }), "approval-required");
    assert.equal(
      hardCapRuntimeModeCeiling({ maxRuntimeMode: "full-access", declineFileChanges: true }),
      "approval-required",
    );
    assert.equal(
      clampRuntimeModeToHardCap("auto-accept-edits", { declineFileChanges: true }),
      "approval-required",
    );
  });

  it("lowers an inherited mode to the cap and refuses an explicit one above it", () => {
    assert.deepEqual(
      resolveHardCappedChildRuntimeMode({ resolved: "full-access", explicit: false, cap: agyCap }),
      { _tag: "allowed", runtimeMode: "approval-required" },
    );
    assert.deepEqual(
      resolveHardCappedChildRuntimeMode({ resolved: "full-access", explicit: true, cap: agyCap }),
      { _tag: "refused", runtimeMode: "full-access", ceiling: "approval-required" },
    );
    assert.deepEqual(
      resolveHardCappedChildRuntimeMode({
        resolved: "approval-required",
        explicit: true,
        cap: agyCap,
      }),
      { _tag: "allowed", runtimeMode: "approval-required" },
    );
    assert.deepEqual(
      resolveHardCappedChildRuntimeMode({
        resolved: "full-access",
        explicit: true,
        cap: undefined,
      }),
      { _tag: "allowed", runtimeMode: "full-access" },
    );
  });

  it("lists the withheld capabilities", () => {
    assert.deepEqual(hardCapWithheldCapabilities(agyCap), ["orchestration", "pull-requests"]);
  });

  it("auto-declines only pending, answerable file-change requests on a declining instance", () => {
    const live = {
      type: "live" as const,
      providerSessionId: ProviderSessionId.make("provider-session:hard-cap"),
    };
    const fileChange = { kind: "file-change" as const, status: "pending" as const };
    assert.isTrue(
      shouldAutoDeclineRuntimeRequest(agyCap, { ...fileChange, responseCapability: live }),
    );
    assert.isTrue(
      shouldAutoDeclineRuntimeRequest(agyCap, {
        ...fileChange,
        responseCapability: { type: "message" },
      }),
    );
    assert.isFalse(
      shouldAutoDeclineRuntimeRequest(agyCap, {
        ...fileChange,
        responseCapability: { type: "not_resumable", reason: "gone" },
      }),
    );
    assert.isFalse(
      shouldAutoDeclineRuntimeRequest(agyCap, {
        ...fileChange,
        status: "resolved",
        responseCapability: live,
      }),
    );
    assert.isFalse(
      shouldAutoDeclineRuntimeRequest(agyCap, {
        kind: "command",
        status: "pending",
        responseCapability: live,
      }),
    );
    assert.isFalse(
      shouldAutoDeclineRuntimeRequest(
        { maxRuntimeMode: "approval-required" },
        { ...fileChange, responseCapability: live },
      ),
    );
    assert.isFalse(
      shouldAutoDeclineRuntimeRequest(undefined, { ...fileChange, responseCapability: live }),
    );
  });

  it("refuses every answer to a declining instance's file change but a decline or cancel", () => {
    const fileChange = { kind: "file-change" as const };
    for (const decision of ["accept", "acceptForSession", "acceptAlways", undefined] as const) {
      assert.isTrue(refusesFileChangeResponse(agyCap, fileChange, decision), String(decision));
    }
    assert.isFalse(refusesFileChangeResponse(agyCap, fileChange, "decline"));
    assert.isFalse(refusesFileChangeResponse(agyCap, fileChange, "cancel"));
    assert.isFalse(refusesFileChangeResponse(agyCap, { kind: "command" }, "accept"));
    assert.isFalse(
      refusesFileChangeResponse({ maxRuntimeMode: "approval-required" }, fileChange, "accept"),
    );
    assert.isFalse(refusesFileChangeResponse(undefined, fileChange, "accept"));
  });

  it.effect("runs an instance whose cap cannot be read under the strictest cap", () =>
    Effect.gen(function* () {
      const unreadable = {
        getSettings: Effect.fail(
          new ServerSettingsError({ settingsPath: "/settings.json", operation: "read-file" }),
        ),
      } as unknown as ServerSettingsService["Service"];
      const cap = yield* providerInstanceHardCapInForce(
        unreadable,
        ProviderInstanceId.make("codex"),
      );
      assert.deepEqual(cap, UNKNOWN_HARD_CAP);
      assert.equal(clampRuntimeModeToHardCap("full-access", cap), "approval-required");
      assert.isTrue(cap?.declineFileChanges);
      // Every capability a cap can withhold, worktrees included.
      assert.deepEqual(
        new Set(hardCapWithheldCapabilities(cap)),
        new Set(["orchestration", "pull-requests", "worktree", "preview", "device"]),
      );
    }),
  );

  it("lists the built-in drivers the registry gives a default instance", () => {
    assert.sameMembers(
      [...DEFAULT_INSTANCE_DRIVERS],
      BUILT_IN_DRIVERS.filter((driver) => driver.metadata.hasDefaultInstance !== false).map(
        (driver) => driver.driverKind,
      ),
    );
  });

  it("puts remembered caps back on default settings without inventing instances", () => {
    const antigravity = ProviderInstanceId.make("antigravity");
    const custom = ProviderInstanceId.make("agy-work");
    const codex = ProviderInstanceId.make("codex");
    const remembered = rememberedHardCapsOf({
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [antigravity]: { driver: ProviderDriverKind.make("antigravity"), hardCap: agyCap },
        [custom]: { driver: ProviderDriverKind.make("antigravity"), hardCap: agyCap },
        [codex]: { driver: ProviderDriverKind.make("codex") },
      },
    });
    // Every instance the registry would build, uncapped ones and the
    // built-in defaults that no entry names included.
    assert.deepEqual(remembered.instances[codex], { driver: ProviderDriverKind.make("codex") });
    for (const driver of DEFAULT_INSTANCE_DRIVERS) {
      assert.isDefined(remembered.instances[driver], driver);
    }
    const inForce = rememberedHardCapsInForce(remembered);
    assert.deepEqual(hardCapFor(inForce, custom), agyCap);
    assert.deepEqual(hardCapFor(inForce, codex), {});
    assert.deepEqual(hardCapFor(inForce, ProviderInstanceId.make("unknown")), UNKNOWN_HARD_CAP);
    const restored = withRememberedHardCaps(DEFAULT_SERVER_SETTINGS, remembered);
    // The built-in instance gets the entry the registry would build, with its cap.
    assert.deepEqual(restored.providerInstances[antigravity], {
      driver: ProviderDriverKind.make("antigravity"),
      hardCap: agyCap,
    });
    // An instance only the lost settings named does not come back.
    assert.isUndefined(restored.providerInstances[custom]);
    const listed = withRememberedHardCaps(
      {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [custom]: { driver: ProviderDriverKind.make("antigravity"), displayName: "Work" },
        },
      },
      remembered,
    );
    assert.deepEqual(listed.providerInstances[custom], {
      driver: ProviderDriverKind.make("antigravity"),
      displayName: "Work",
      hardCap: agyCap,
    });
  });
});
