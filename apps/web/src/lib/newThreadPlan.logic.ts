import type { ProviderInteractionMode } from "@t3tools/contracts";

/**
 * The interaction mode a new draft thread opens with. A project that starts
 * new threads in Plan wins over the mode carried from the thread being viewed;
 * otherwise the carried mode stands (null leaves the draft at its default).
 * `startsInPlan` comes from `newThreadStartsInPlan(settings, "ui")`, which is
 * where the setting decides who it reaches.
 */
export function resolveNewThreadInteractionMode(input: {
  startsInPlan: boolean;
  carried: ProviderInteractionMode | null;
}): ProviderInteractionMode | null {
  return input.startsInPlan ? "plan" : input.carried;
}

/**
 * Whether the composer's Plan controls (toggle, /plan, Shift+Tab) are live.
 * Settings → General → Legacy features → Plan mode turns them on everywhere;
 * a project that starts new threads in Plan turns them on for itself, since a
 * thread that opens in Plan must be able to leave it. The project setting is
 * read as the project's effective value, whoever would start the thread.
 */
export function resolvePlanModeAvailable(input: {
  legacyPlanModeEnabled: boolean;
  projectStartsInPlan: boolean;
}): boolean {
  return input.legacyPlanModeEnabled || input.projectStartsInPlan;
}
