import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  type ProviderInstanceHardCap,
} from "@t3tools/contracts";

import {
  clampRuntimeModeToHardCap,
  hardCapRuntimeModeCeiling,
  hardCapWithheldCapabilities,
  readProviderInstanceHardCap,
  resolveHardCappedChildRuntimeMode,
  shouldAutoDeclineRuntimeRequest,
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
});
