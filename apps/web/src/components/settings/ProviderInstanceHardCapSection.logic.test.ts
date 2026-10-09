import { ProviderDriverKind, type ProviderInstanceConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  effectiveHardCapRuntimeMode,
  normalizeProviderInstanceHardCap,
  withProviderInstanceHardCap,
} from "./ProviderInstanceHardCapSection.logic";

const instance: ProviderInstanceConfig = {
  driver: ProviderDriverKind.make("antigravity"),
  enabled: true,
};

describe("withProviderInstanceHardCap", () => {
  it("writes the cap mp's agy needs", () => {
    expect(
      withProviderInstanceHardCap(instance, {
        maxRuntimeMode: "approval-required",
        declineFileChanges: true,
        withheldCapabilities: ["pull-requests", "orchestration"],
      }),
    ).toEqual({
      ...instance,
      hardCap: {
        maxRuntimeMode: "approval-required",
        declineFileChanges: true,
        // Kept in the settings' own order, so toggling does not reorder the file.
        withheldCapabilities: ["orchestration", "pull-requests"],
      },
    });
  });

  it("removes the key when nothing is capped", () => {
    const capped = withProviderInstanceHardCap(instance, { maxRuntimeMode: "auto" });
    expect(capped.hardCap).toEqual({ maxRuntimeMode: "auto" });
    expect(
      withProviderInstanceHardCap(capped, {
        declineFileChanges: false,
        withheldCapabilities: [],
      }),
    ).toEqual(instance);
  });

  it("treats full access as no cap", () => {
    expect(normalizeProviderInstanceHardCap({ maxRuntimeMode: "full-access" })).toBeUndefined();
  });
});

describe("effectiveHardCapRuntimeMode", () => {
  it("runs Supervised while file changes are declined", () => {
    expect(effectiveHardCapRuntimeMode(undefined)).toBeUndefined();
    expect(effectiveHardCapRuntimeMode({ maxRuntimeMode: "auto" })).toBe("auto");
    expect(effectiveHardCapRuntimeMode({ maxRuntimeMode: "auto", declineFileChanges: true })).toBe(
      "approval-required",
    );
  });
});
