import type {
  ProviderInstanceCappedCapability,
  ProviderInstanceConfig,
  ProviderInstanceHardCap,
  RuntimeMode,
} from "@t3tools/contracts";

/** Full access is the same as no cap, so it is not offered. */
export const HARD_CAP_RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "auto",
] as const satisfies ReadonlyArray<RuntimeMode>;

export const HARD_CAP_CAPABILITIES: ReadonlyArray<{
  readonly value: ProviderInstanceCappedCapability;
  readonly label: string;
}> = [
  { value: "orchestration", label: "Orchestration" },
  { value: "pull-requests", label: "Pull requests" },
  { value: "worktree", label: "Worktrees" },
  { value: "preview", label: "Browser" },
  { value: "device", label: "Devices" },
];

/** Drops the fields that cap nothing, and the whole cap when none is left. */
export function normalizeProviderInstanceHardCap(
  cap: ProviderInstanceHardCap,
): ProviderInstanceHardCap | undefined {
  const withheld = HARD_CAP_CAPABILITIES.map((option) => option.value).filter((value) =>
    cap.withheldCapabilities?.includes(value),
  );
  const next: ProviderInstanceHardCap = {
    ...(cap.maxRuntimeMode === undefined || cap.maxRuntimeMode === "full-access"
      ? {}
      : { maxRuntimeMode: cap.maxRuntimeMode }),
    ...(cap.declineFileChanges === true ? { declineFileChanges: true } : {}),
    ...(withheld.length > 0 ? { withheldCapabilities: withheld } : {}),
  };
  return Object.keys(next).length > 0 ? next : undefined;
}

export function withProviderInstanceHardCap(
  instance: ProviderInstanceConfig,
  cap: ProviderInstanceHardCap,
): ProviderInstanceConfig {
  const { hardCap: _previous, ...rest } = instance;
  const next = normalizeProviderInstanceHardCap(cap);
  return next === undefined ? rest : { ...rest, hardCap: next };
}

/** The mode the instance runs at most, as the server applies it. */
export function effectiveHardCapRuntimeMode(
  cap: ProviderInstanceHardCap | undefined,
): RuntimeMode | undefined {
  if (cap?.declineFileChanges === true) return "approval-required";
  return cap?.maxRuntimeMode;
}
