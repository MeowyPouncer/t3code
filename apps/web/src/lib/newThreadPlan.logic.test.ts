import { describe, expect, it } from "vite-plus/test";

import { resolveComposerInteractionMode } from "../components/ChatView.logic";
import { resolveNewThreadInteractionMode, resolvePlanModeAvailable } from "./newThreadPlan.logic";

describe("resolveNewThreadInteractionMode", () => {
  it("opens in Plan when the project starts new threads in Plan, whatever was carried", () => {
    expect(resolveNewThreadInteractionMode({ startsInPlan: true, carried: null })).toBe("plan");
    expect(resolveNewThreadInteractionMode({ startsInPlan: true, carried: "default" })).toBe(
      "plan",
    );
    expect(resolveNewThreadInteractionMode({ startsInPlan: true, carried: "plan" })).toBe("plan");
  });

  it("keeps the carried mode when the project does not start in Plan", () => {
    expect(resolveNewThreadInteractionMode({ startsInPlan: false, carried: "plan" })).toBe("plan");
    expect(resolveNewThreadInteractionMode({ startsInPlan: false, carried: "default" })).toBe(
      "default",
    );
    expect(resolveNewThreadInteractionMode({ startsInPlan: false, carried: null })).toBeNull();
  });
});

describe("resolvePlanModeAvailable", () => {
  it("is available through the legacy flag alone", () => {
    expect(
      resolvePlanModeAvailable({ legacyPlanModeEnabled: true, projectStartsInPlan: false }),
    ).toBe(true);
  });

  it("is available for a project that starts in Plan even with the legacy flag off", () => {
    expect(
      resolvePlanModeAvailable({ legacyPlanModeEnabled: false, projectStartsInPlan: true }),
    ).toBe(true);
  });

  it("stays off when neither is on", () => {
    expect(
      resolvePlanModeAvailable({ legacyPlanModeEnabled: false, projectStartsInPlan: false }),
    ).toBe(false);
  });
});

describe("a draft that starts in Plan", () => {
  const claude = { showInteractionModeToggle: true } as const;
  const noPlanProvider = { showInteractionModeToggle: false } as const;

  it("sends in plan for a provider with a plan mode, though the legacy flag is off", () => {
    const planModeEnabled = resolvePlanModeAvailable({
      legacyPlanModeEnabled: false,
      projectStartsInPlan: true,
    });
    expect(
      resolveComposerInteractionMode({
        planModeEnabled,
        provider: claude,
        interactionMode: "plan",
      }),
    ).toEqual({ enabled: true, interactionMode: "plan" });
  });

  it("sends in default for a provider without a plan mode", () => {
    const planModeEnabled = resolvePlanModeAvailable({
      legacyPlanModeEnabled: false,
      projectStartsInPlan: true,
    });
    expect(
      resolveComposerInteractionMode({
        planModeEnabled,
        provider: noPlanProvider,
        interactionMode: "plan",
      }),
    ).toEqual({ enabled: false, interactionMode: "default" });
  });

  it("sends in default when no project setting or legacy flag makes Plan available", () => {
    const planModeEnabled = resolvePlanModeAvailable({
      legacyPlanModeEnabled: false,
      projectStartsInPlan: false,
    });
    expect(
      resolveComposerInteractionMode({
        planModeEnabled,
        provider: claude,
        interactionMode: "plan",
      }),
    ).toEqual({ enabled: false, interactionMode: "default" });
  });

  it("follows the user's later choice once the first turn is out", () => {
    const planModeEnabled = resolvePlanModeAvailable({
      legacyPlanModeEnabled: false,
      projectStartsInPlan: true,
    });
    expect(
      resolveComposerInteractionMode({
        planModeEnabled,
        provider: claude,
        interactionMode: "default",
      }),
    ).toEqual({ enabled: true, interactionMode: "default" });
  });
});
