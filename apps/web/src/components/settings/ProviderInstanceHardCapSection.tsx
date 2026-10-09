import type { ProviderInstanceConfig, ProviderInstanceHardCap } from "@t3tools/contracts";
import { LockOpenIcon } from "lucide-react";

import { runtimeModeConfig } from "../chat/runtimeModeConfig";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  effectiveHardCapRuntimeMode,
  HARD_CAP_CAPABILITIES,
  HARD_CAP_RUNTIME_MODES,
  withProviderInstanceHardCap,
} from "./ProviderInstanceHardCapSection.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const NO_CAP = "none";

/**
 * The instance's hard cap (`providerInstances.<id>.hardCap`): the most any
 * thread on it is granted, whoever starts it and whatever its parent's mode.
 */
export function ProviderInstanceHardCapSection(props: {
  readonly instanceId: string;
  readonly instance: ProviderInstanceConfig;
  readonly readOnly: boolean;
  readonly onUpdate: (next: ProviderInstanceConfig) => void;
}) {
  const cap: ProviderInstanceHardCap = props.instance.hardCap ?? {};
  const update = (next: ProviderInstanceHardCap) =>
    props.onUpdate(withProviderInstanceHardCap(props.instance, next));
  const runsAtMost = effectiveHardCapRuntimeMode(cap);
  const selectedMode = cap.maxRuntimeMode ?? NO_CAP;
  const SelectedIcon =
    selectedMode === NO_CAP ? LockOpenIcon : runtimeModeConfig[selectedMode].icon;

  return (
    <SettingsSection
      title="Limits"
      inert={props.readOnly}
      aria-disabled={props.readOnly || undefined}
      className={props.readOnly ? "opacity-50 select-none" : undefined}
    >
      <SettingsRow
        title="Most permissions"
        description={
          runsAtMost === undefined
            ? "The most any thread on this instance runs with, whoever starts it."
            : `Threads on this instance run ${runtimeModeConfig[runsAtMost].label} at most, whoever starts them${
                runsAtMost === cap.maxRuntimeMode ? "" : ", because file changes are declined"
              }. A parent asking for more is refused; one passing on more is lowered.`
        }
        control={
          <Select
            value={selectedMode}
            onValueChange={(value) => {
              if (value === null) return;
              const { maxRuntimeMode: _previous, ...rest } = cap;
              update(
                value === NO_CAP
                  ? rest
                  : { ...rest, maxRuntimeMode: value as (typeof HARD_CAP_RUNTIME_MODES)[number] },
              );
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label={`Most permissions for ${props.instanceId}`}
              id={`provider-instance-${props.instanceId}-max-runtime-mode`}
            >
              <SelectedIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <SelectValue>
                {selectedMode === NO_CAP ? "No limit" : runtimeModeConfig[selectedMode].label}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value={NO_CAP} className="min-w-64">
                <div className="grid gap-0.5">
                  <span className="inline-flex items-center gap-1.5 font-medium">
                    <LockOpenIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    No limit
                  </span>
                  <span className="text-xs leading-4 text-muted-foreground">
                    Threads run with the mode they are given.
                  </span>
                </div>
              </SelectItem>
              {HARD_CAP_RUNTIME_MODES.map((mode) => {
                const option = runtimeModeConfig[mode];
                const Icon = option.icon;
                return (
                  <SelectItem key={mode} value={mode} className="min-w-64">
                    <div className="grid gap-0.5">
                      <span className="inline-flex items-center gap-1.5 font-medium">
                        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                        {option.label}
                      </span>
                      <span className="text-xs leading-4 text-muted-foreground">
                        {option.description}
                      </span>
                    </div>
                  </SelectItem>
                );
              })}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Decline file changes"
        description="Answer every file-change approval with Decline, without asking you."
        control={
          <Switch
            checked={cap.declineFileChanges === true}
            onCheckedChange={(checked) => {
              const { declineFileChanges: _previous, ...rest } = cap;
              update(checked ? { ...rest, declineFileChanges: true } : rest);
            }}
            aria-label={`Decline file changes for ${props.instanceId}`}
          />
        }
      />
      <SettingsRow
        title="Withhold T3 tools"
        description="T3 tools this instance's agents never get. Orchestration covers delegate_task and thread control."
        control={
          <ToggleGroup
            multiple
            variant="outline"
            size="compact"
            aria-label={`Withheld T3 tools for ${props.instanceId}`}
            className="flex-wrap justify-end"
            value={[...(cap.withheldCapabilities ?? [])]}
            onValueChange={(next) => {
              const { withheldCapabilities: _previous, ...rest } = cap;
              const withheld = HARD_CAP_CAPABILITIES.map((option) => option.value).filter((value) =>
                next.includes(value),
              );
              update(withheld.length > 0 ? { ...rest, withheldCapabilities: withheld } : rest);
            }}
          >
            {HARD_CAP_CAPABILITIES.map((option) => (
              <Toggle key={option.value} value={option.value}>
                {option.label}
              </Toggle>
            ))}
          </ToggleGroup>
        }
      />
    </SettingsSection>
  );
}
