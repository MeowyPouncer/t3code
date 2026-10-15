// FORK: the Composer assist settings, in three groups (the assistant, blanks, cues) with what each
// switch does, what the assistant has done so far, the rules a project's cues use, and a box to
// try the current settings on a draft. The status, rules and box ask the one environment the
// settings are showing.
import {
  COMPOSER_ASSIST_LANGUAGES,
  COMPOSER_ASSIST_MODELS,
  COMPOSER_ASSIST_PAUSES,
  composerAssistAnswer,
} from "@t3tools/client-runtime/composer-assist";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  ComposerAssistCue,
  ComposerAssistStatus,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useProjects } from "~/state/entities";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/** The parts of composer assist that can each be turned off, and what each one does. */
const COMPOSER_ASSIST_SWITCHES = {
  blanks: {
    searchId: "composer-assist-blanks",
    label: "Blanks",
    description:
      "End a draft with “ _” and Claude works on it. Bare, it improves the draft as a prompt. After an instruction (“as a list _”, “shorter _”), it follows the instruction. After a slot (“the test command: _”), it fills in the value.",
  },
  contradictions: {
    searchId: "composer-assist-contradictions",
    label: "Contradictions",
    description:
      "Flag a sentence that goes against a decision made in the thread, a rule from the project's AGENTS.md, or the calendar (“Friday the 19th”).",
  },
  spelling: {
    searchId: "composer-assist-spelling",
    label: "Typos",
    description:
      "Underline a misspelled word and offer corrections. Code and names are left alone.",
  },
  sentences: {
    searchId: "composer-assist-sentences",
    label: "Better sentences",
    description: "Offer a clearer or shorter version of a sentence, with the reason.",
  },
  askCues: {
    searchId: "composer-assist-questions",
    label: "Clarifying questions",
    description:
      "Ask about a vague sentence (“fix the bug”) and offer ways to make it precise, which replace the sentence when picked.",
  },
  auditor: {
    searchId: "composer-assist-auditor",
    label: "Auditor",
    description:
      "After a pause, tidy the whole draft's grammar and clarity without asking. Undo puts it back, but it can change the meaning of a prompt, so it is off by default.",
  },
} as const;

type SwitchKey = keyof typeof COMPOSER_ASSIST_SWITCHES;

const CUE_KIND_LABELS: Record<ComposerAssistCue["kind"], string> = {
  contradiction: "Contradiction",
  spelling: "Typo",
  sentence: "Sentence",
  ask: "Question",
};

/** "4 minutes ago" for an ISO time, coarse because the status is a glance. */
function agoLabel(iso: string, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86_400)} days ago`;
}

function ChoiceSelect<T extends string>({
  value,
  options,
  label,
  onChange,
}: {
  readonly value: T;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly label: string;
  readonly onChange: (value: T) => void;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange((next ?? "") as T)}>
      <SelectTrigger className="w-full sm:w-56" aria-label={label}>
        <SelectValue>
          {(current: string) =>
            options.find((option) => option.value === current)?.label ?? current
          }
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function summaryOf(status: ComposerAssistStatus, nowMs: number): ReadonlyArray<string> {
  const model =
    COMPOSER_ASSIST_MODELS.find(
      (candidate) => candidate.value === (status.model === "haiku" ? "" : status.model),
    )?.label ?? status.model;
  const lines: string[] = [];
  if (status.account === null) {
    lines.push("No Claude account can answer. Add one under Providers.");
  } else if (status.followsThread) {
    lines.push(
      `Answers with ${model} on the thread's own Claude account, and on ${status.account.label} for a draft outside a thread.`,
    );
  } else {
    lines.push(`Answers with ${model} on ${status.account.label}.`);
  }
  if (status.cuesPaused) {
    lines.push("Cues wait: that account is near a usage limit. Blanks still run.");
  }
  const count = (name: string, counts: ComposerAssistStatus["blanks"]) =>
    `${name}: ${counts.requests} asked, ${counts.failures} failed`;
  lines.push(`${count("Blanks", status.blanks)}. ${count("Cues", status.cues)}.`);
  for (const activity of status.recent.slice(0, 3)) {
    const seconds = (activity.durationMs / 1000).toFixed(1);
    lines.push(
      activity.ok
        ? `${activity.operation === "blank" ? "Blank" : "Cues"} answered in ${seconds} s, ${agoLabel(activity.at, nowMs)}.`
        : `${activity.operation === "blank" ? "Blank" : "Cues"} failed after ${seconds} s, ${agoLabel(activity.at, nowMs)}: ${activity.detail ?? "no reason given"}`,
    );
  }
  return lines;
}

function ActivityRow({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const ask = useAtomCommand(serverEnvironment.composerAssist, { reportFailure: false });
  const [status, setStatus] = useState<ComposerAssistStatus | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const refresh = useCallback(() => {
    void ask({ environmentId, input: { operation: "status" } }).then((result) => {
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setFailure(cause instanceof Error ? cause.message : "Could not read the status.");
        return;
      }
      const answer = composerAssistAnswer(result.value, "status");
      if (answer === null) return;
      setFailure(null);
      setStatus(answer.status);
    });
  }, [ask, environmentId]);
  useEffect(refresh, [refresh]);
  const lines =
    failure !== null ? [failure] : status === null ? ["Reading…"] : summaryOf(status, Date.now());
  return (
    <SettingsRow
      {...searchableSetting("composer-assist-activity")}
      title="Activity"
      description="What composer assist has done since this server started."
      control={
        <Button size="sm" variant="outline" onClick={refresh}>
          Refresh
        </Button>
      }
    >
      <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
    </SettingsRow>
  );
}

function RulesRow({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const settings = useScopedSettings().composerAssist;
  const updateSettings = useUpdateScopedSettings();
  const ask = useAtomCommand(serverEnvironment.composerAssist, { reportFailure: false });
  const projects = useProjects();
  const options = useMemo(
    () =>
      projects
        .filter((project) => project.environmentId === environmentId)
        .map((project) => ({ value: project.id as string, label: project.title })),
    [environmentId, projects],
  );
  const [projectId, setProjectId] = useState<string>("");
  const [rules, setRules] = useState<{
    readonly fileName: string | null;
    readonly rules: ReadonlyArray<string> | null;
  } | null>(null);
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const load = useCallback(
    (project: string, readRules: boolean) => {
      if (project === "") return;
      setWorking(true);
      void ask({
        environmentId,
        input: {
          operation: "status",
          projectId: project as ProjectId,
          ...(readRules ? { readRules: true } : {}),
        },
      }).then((result) => {
        setWorking(false);
        if (result._tag === "Failure") {
          const cause = squashAtomCommandFailure(result);
          setFailure(cause instanceof Error ? cause.message : "Could not read the rules.");
          return;
        }
        const answer = composerAssistAnswer(result.value, "status");
        setFailure(null);
        setRules(answer?.status.projectRules ?? null);
      });
    },
    [ask, environmentId],
  );
  const choose = (project: string) => {
    setProjectId(project);
    setRules(null);
    load(project, false);
  };
  const disabled = settings.disabledRules;
  const toggle = (rule: string, on: boolean) =>
    updateSettings({
      composerAssist: {
        disabledRules: on ? disabled.filter((entry) => entry !== rule) : [...disabled, rule],
      },
    });
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("composer-assist-rules")}
      title="Project rules"
      description="The rules Claude read from a project's AGENTS.md (or CLAUDE.md) for contradiction cues. Turn off one that gets in the way."
      settingKeys={["composerAssist"]}
      control={
        <ChoiceSelect
          value={projectId}
          options={[{ value: "", label: "Choose a project" }, ...options]}
          label="Project whose rules to show"
          onChange={choose}
        />
      }
    >
      {projectId === "" ? null : (
        <div className="mt-2 space-y-1.5 text-xs">
          {failure !== null ? <p className="text-destructive">{failure}</p> : null}
          {working ? <p className="text-muted-foreground">Reading…</p> : null}
          {rules?.fileName === null ? (
            <p className="text-muted-foreground">This project has no AGENTS.md or CLAUDE.md.</p>
          ) : null}
          {rules !== null && rules.fileName !== null && rules.rules === null ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-muted-foreground">
                {rules.fileName} has not been read yet. It is read when you type a draft in this
                project, or now.
              </p>
              <Button
                size="sm"
                variant="outline"
                disabled={working}
                onClick={() => load(projectId, true)}
              >
                Read now
              </Button>
            </div>
          ) : null}
          {rules?.rules?.length === 0 ? (
            <p className="text-muted-foreground">
              {rules.fileName} has no rules a draft could go against.
            </p>
          ) : null}
          {rules?.rules?.map((rule) => (
            <label key={rule} className="flex items-start gap-2">
              <ScopedSwitch
                settingKeys={["composerAssist"]}
                checked={!disabled.includes(rule)}
                onCheckedChange={(checked) => toggle(rule, Boolean(checked))}
                aria-label={rule}
              />
              <span className="text-foreground/80">{rule}</span>
            </label>
          ))}
        </div>
      )}
    </SettingsRow>
  );
}

function TryRow({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const ask = useAtomCommand(serverEnvironment.composerAssist, { reportFailure: false });
  const [draft, setDraft] = useState("");
  const [working, setWorking] = useState(false);
  const [lines, setLines] = useState<ReadonlyArray<string>>([]);
  const run = (operation: "blank" | "cues") => {
    const trimmed = draft.trimEnd();
    const text = operation === "blank" && !/(?:^|\s)_$/.test(trimmed) ? `${trimmed} _` : trimmed;
    setWorking(true);
    setLines([]);
    void ask({ environmentId, input: { operation, text } }).then((result) => {
      setWorking(false);
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setLines([cause instanceof Error ? cause.message : "Claude could not answer."]);
        return;
      }
      const blank = composerAssistAnswer(result.value, "blank");
      if (blank !== null) {
        const outcome = blank.blank;
        setLines(
          outcome._tag === "none"
            ? [outcome.reason ?? "Claude left the draft as it is."]
            : [outcome._tag === "fill" ? `Fills the blank with: ${outcome.text}` : outcome.text],
        );
        return;
      }
      const cues = composerAssistAnswer(result.value, "cues");
      if (cues === null) return;
      const found = cues.cues.cues.map((cue) => {
        const quote = text.slice(cue.start, cue.end);
        const advice = cue.note.length > 0 ? cue.note : cue.alternatives.join(" / ");
        return `${CUE_KIND_LABELS[cue.kind]}: “${quote}”${advice.length > 0 ? ` — ${advice}` : ""}`;
      });
      setLines(found.length > 0 ? found : ["No cues for this draft."]);
    });
  };
  return (
    <SettingsRow
      {...searchableSetting("composer-assist-try")}
      title="Try it"
      description="Run the settings above on a draft. It asks Claude like the composer does, and nothing is sent to a thread."
    >
      <div className="mt-2 space-y-2">
        <Textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Write a draft, for example: fix the login bug where the sesion expires"
          aria-label="Draft to try"
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={working || draft.trim() === ""}
            onClick={() => run("blank")}
          >
            Try a blank
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={working || draft.trim() === ""}
            onClick={() => run("cues")}
          >
            Try the cues
          </Button>
        </div>
        {working ? <p className="text-xs text-muted-foreground">Asking Claude…</p> : null}
        {lines.length > 0 ? (
          <div className="space-y-1 text-xs text-foreground/80">
            {lines.map((line) => (
              <p key={line} className="whitespace-pre-wrap">
                {line}
              </p>
            ))}
          </div>
        ) : null}
      </div>
    </SettingsRow>
  );
}

export function ComposerAssistSettingsSections({
  environmentId,
  claudeProviders,
}: {
  /** The one environment the settings show; null when several are selected. */
  readonly environmentId: EnvironmentId | null;
  readonly claudeProviders: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly displayName?: string | undefined;
  }>;
}) {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const assist = settings.composerAssist;
  const switchRow = (key: SwitchKey) => {
    const item = COMPOSER_ASSIST_SWITCHES[key];
    return (
      <SettingsRow
        key={key}
        serverScoped
        {...searchableSetting(item.searchId)}
        title={item.label}
        description={item.description}
        settingKeys={["composerAssist"]}
        control={
          <ScopedSwitch
            settingKeys={["composerAssist"]}
            checked={assist[key]}
            onCheckedChange={(checked) =>
              updateSettings({ composerAssist: { [key]: Boolean(checked) } })
            }
            aria-label={item.label}
          />
        }
      />
    );
  };
  return (
    <>
      <SettingsSection id="composer-assist" title="Composer assist">
        <SettingsRow
          serverScoped
          {...searchableSetting("composer-assist-account")}
          title="Claude account"
          description="The Claude account that answers. By default it is the thread's own, so two accounts never work at once; a thread on another provider uses the first Claude."
          settingKeys={["composerAssist"]}
          control={
            <ChoiceSelect
              value={assist.instanceId}
              options={[
                { value: "", label: "The thread's Claude" },
                ...claudeProviders.map((provider) => ({
                  value: provider.instanceId as string,
                  label: provider.displayName ?? provider.instanceId,
                })),
              ]}
              label="Composer assist account"
              onChange={(value) => updateSettings({ composerAssist: { instanceId: value } })}
            />
          }
        />
        <SettingsRow
          serverScoped
          {...searchableSetting("composer-assist-model")}
          title="Model"
          description="The Claude model that answers. Every blank and cue waits for it, so the fastest is the default; a bigger one writes better and uses more of the Claude limit."
          settingKeys={["composerAssist"]}
          control={
            <ChoiceSelect
              value={assist.model}
              options={COMPOSER_ASSIST_MODELS.map((model) => ({
                value: model.value,
                label: `${model.label}: ${model.note}`,
              }))}
              label="Composer assist model"
              onChange={(value) => updateSettings({ composerAssist: { model: value } })}
            />
          }
        />
        {environmentId === null ? null : <ActivityRow environmentId={environmentId} />}
      </SettingsSection>

      <SettingsSection id="composer-assist-blanks-group" title="Blanks">
        {switchRow("blanks")}
        <SettingsRow
          serverScoped
          {...searchableSetting("composer-assist-language")}
          title="Prompt language"
          description="The language a blank's rewrite comes out in, so a draft written in one language is sent in another. A filled-in value keeps the draft's language."
          settingKeys={["composerAssist"]}
          control={
            <ChoiceSelect
              value={assist.language}
              options={COMPOSER_ASSIST_LANGUAGES}
              label="Prompt language"
              onChange={(value) => updateSettings({ composerAssist: { language: value } })}
            />
          }
        />
      </SettingsSection>

      <SettingsSection id="composer-assist-cues-group" title="Cues while you type">
        <SettingsRow
          serverScoped
          {...searchableSetting("composer-assist-pause")}
          title="Pause before cues"
          description="How long the draft stays quiet before cues are asked for. Longer asks less often and uses less of the Claude limit."
          settingKeys={["composerAssist"]}
          control={
            <ChoiceSelect
              value={String(assist.pauseMs)}
              options={COMPOSER_ASSIST_PAUSES.map((pause) => ({
                value: String(pause.value),
                label: pause.label,
              }))}
              label="Pause before cues"
              onChange={(value) => updateSettings({ composerAssist: { pauseMs: Number(value) } })}
            />
          }
        />
        <SettingsRow
          serverScoped
          {...searchableSetting("composer-assist-cue-language")}
          title="Cue language"
          description="The language of a cue's note or question. A suggested rewrite keeps the language of the draft."
          settingKeys={["composerAssist"]}
          control={
            <ChoiceSelect
              value={assist.cueLanguage}
              options={COMPOSER_ASSIST_LANGUAGES}
              label="Cue language"
              onChange={(value) => updateSettings({ composerAssist: { cueLanguage: value } })}
            />
          }
        />
        {switchRow("contradictions")}
        {switchRow("spelling")}
        {switchRow("sentences")}
        {switchRow("askCues")}
        {switchRow("auditor")}
        {environmentId === null ? null : <RulesRow environmentId={environmentId} />}
      </SettingsSection>

      {environmentId === null ? null : (
        <SettingsSection id="composer-assist-try-group" title="Try composer assist">
          <TryRow environmentId={environmentId} />
        </SettingsSection>
      )}
    </>
  );
}
