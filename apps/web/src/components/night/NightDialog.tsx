// FORK: the night mode. Plan a night (the overseer, what runs at its end, power off), then follow it.
import { useAtomValue } from "@effect/atom-react";
import {
  scopeProjectRef,
  scopedProjectKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ModelSelection,
  NightPlan,
  NightState,
  TodoBoardCard,
} from "@t3tools/contracts";
import { OrchestrationV2ThreadInstructions } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { MoonIcon, PlusIcon, XIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { getCustomModelOptionsByInstance } from "~/modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "~/providerInstances";
import { useProjects, useServerConfigs } from "~/state/entities";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { projectEnvironment, projectTodoBoard } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { scheduledTaskDefaultModel } from "../settings/scheduledTasksSettings.logic";
import {
  canStartTaskAgent,
  DEFAULT_ORCHESTRATOR_INSTRUCTIONS,
  DEFAULT_TASK_AGENT_LIMIT,
  ORCHESTRATOR_INSTRUCTIONS_PATH,
  TASK_AGENT_LIMITS,
  type TaskAgentsMode,
} from "../tasks/taskAgentsLogic";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  DEFAULT_NIGHT_BRIEFING_MINUTES,
  NIGHT_BRIEFING_MINUTES,
  nightRuns,
  nightStatusLabel,
  planNightEnd,
} from "./nightPlanLogic";

const isThreadInstructions = Schema.is(OrchestrationV2ThreadInstructions);

const reportFailure = (title: string, error: unknown) =>
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : String(error),
    }),
  );

/** The project's providers and its default model, as the Tasks dialog offers them. */
function useModelChoices(project: EnvironmentProject) {
  const settings = useEnvironmentSettings(project.environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(project.environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(
          deriveProviderInstanceEntries(providers),
          settings,
          project.id,
        ),
      ),
    [providers, settings, project.id],
  );
  return {
    settings,
    providers,
    instanceEntries,
    fallback: scheduledTaskDefaultModel(settings, project, instanceEntries),
  };
}

function ModelChoice(props: {
  readonly project: EnvironmentProject;
  readonly selection: ModelSelection | null;
  readonly onChange: (selection: ModelSelection) => void;
}) {
  const { settings, providers, instanceEntries } = useModelChoices(props.project);
  const { selection } = props;
  const activeEntry = instanceEntries.find((entry) => entry.instanceId === selection?.instanceId);
  const modelOptionsByInstance = useMemo(
    () =>
      getCustomModelOptionsByInstance(settings, providers, selection?.instanceId, selection?.model),
    [settings, providers, selection?.instanceId, selection?.model],
  );
  if (!selection || !activeEntry) {
    return <span className="text-sm text-muted-foreground">No providers available</span>;
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <ProviderModelPicker
        environmentId={props.project.environmentId}
        activeInstanceId={selection.instanceId}
        model={selection.model}
        lockedProvider={null}
        instanceEntries={instanceEntries}
        modelOptionsByInstance={modelOptionsByInstance}
        isComposerOwned={false}
        onInstanceModelChange={(instanceId, model) =>
          props.onChange(createModelSelection(instanceId, model))
        }
      />
      <TraitsPicker
        provider={activeEntry.driverKind}
        models={activeEntry.models}
        model={selection.model}
        prompt=""
        onPromptChange={() => {}}
        modelOptions={selection.options ?? []}
        allowPromptInjectedEffort={false}
        planModeEnabled={settings.planModeEnabled}
        onModelOptionsChange={(options) =>
          props.onChange(createModelSelection(selection.instanceId, selection.model, options))
        }
      />
    </div>
  );
}

function CardChecklist(props: {
  readonly cards: ReadonlyArray<TodoBoardCard>;
  readonly selected: ReadonlySet<string>;
  readonly onToggle: (id: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLowerCase();
  const shown = props.cards.filter(
    (card) =>
      props.selected.has(card.id) ||
      needle === "" ||
      card.id.toLowerCase().includes(needle) ||
      card.title.toLowerCase().includes(needle),
  );
  return (
    <div className="flex flex-col gap-1.5">
      <Input
        size="sm"
        value={filter}
        placeholder="Filter cards"
        aria-label="Filter cards"
        onChange={(event) => setFilter(event.target.value)}
      />
      <div className="max-h-44 overflow-y-auto rounded-md border">
        {shown.length === 0 ? (
          <p className="p-2 text-xs text-muted-foreground">No cards match.</p>
        ) : (
          shown.map((card) => (
            <label
              key={card.id}
              className="flex cursor-pointer items-center gap-2 border-b px-2 py-1.5 text-xs last:border-b-0"
            >
              <Checkbox
                checked={props.selected.has(card.id)}
                onCheckedChange={() => props.onToggle(card.id)}
              />
              <span className="shrink-0 font-mono">{card.id}</span>
              <span className="min-w-0 truncate text-muted-foreground">{card.title}</span>
            </label>
          ))
        )}
      </div>
    </div>
  );
}

function NightSetup(props: {
  readonly project: EnvironmentProject;
  readonly projectPicker: ReactNode;
  readonly onClose: () => void;
}) {
  const { project } = props;
  const environmentId = project.environmentId;
  const capabilities = useServerConfigs().get(environmentId)?.environment.capabilities;
  const supported = capabilities?.nightMode === true;
  const canStart = useAtomValue(serverEnvironment.startNight.permissionAtom(environmentId));
  const startNight = useAtomCommand(serverEnvironment.startNight, { label: "start the night" });
  const { settings, fallback } = useModelChoices(project);
  const projectDefaults = resolveProjectSettings(settings, project.id, project).settings;

  const [overseerModel, setOverseerModel] = useState<ModelSelection | null>(null);
  const [agentsModel, setAgentsModel] = useState<ModelSelection | null>(null);
  const [briefingMinutes, setBriefingMinutes] = useState<number>(DEFAULT_NIGHT_BRIEFING_MINUTES);
  const [selectedCards, setSelectedCards] = useState<ReadonlySet<string>>(() => new Set());
  const [mode, setMode] = useState<TaskAgentsMode>("separate");
  const [limit, setLimit] = useState<number | "all">(DEFAULT_TASK_AGENT_LIMIT);
  // Each prompt keeps its id while the list changes around it.
  const [prompts, setPrompts] = useState<
    ReadonlyArray<{ readonly id: number; readonly text: string }>
  >([]);
  const [powerOff, setPowerOff] = useState(false);
  const [starting, setStarting] = useState(false);

  const board = useEnvironmentQuery(
    supported && capabilities?.todoBoard === true
      ? projectTodoBoard({ environmentId, input: { projectId: project.id } })
      : null,
  );
  const snapshot = board.data?.available ? board.data.snapshot : null;
  const cards = useMemo(
    () =>
      snapshot ? [...snapshot.cards, ...snapshot.backlog_cards].filter(canStartTaskAgent) : [],
    [snapshot],
  );
  const pickedCards = cards.filter((card) => selectedCards.has(card.id));
  const orchestrator = mode === "orchestrator" && pickedCards.length > 0;
  const instructionsFile = useEnvironmentQuery(
    orchestrator && snapshot
      ? projectEnvironment.readFile({
          environmentId,
          input: { cwd: snapshot.root, relativePath: ORCHESTRATOR_INSTRUCTIONS_PATH },
        })
      : null,
  );
  const instructions = instructionsFile.data?.contents.trim() || DEFAULT_ORCHESTRATOR_INSTRUCTIONS;

  const overseerSelection = overseerModel ?? fallback;
  const agentsSelection = agentsModel ?? fallback;
  const end = agentsSelection
    ? planNightEnd({
        projectId: project.id,
        projectTitle: project.title,
        modelSelection: agentsSelection,
        runtimeMode: projectDefaults.defaultRuntimeMode,
        cards: pickedCards,
        mode: orchestrator ? "orchestrator" : "separate",
        instructions,
        prompts: prompts.map((prompt) => prompt.text),
        ...(limit === "all" ? {} : { maxRunning: limit }),
      })
    : null;
  const blocked =
    !supported ||
    !canStart ||
    !overseerSelection ||
    end === null ||
    starting ||
    (orchestrator && (instructionsFile.isPending || !isThreadInstructions(instructions)));

  const start = async () => {
    if (blocked || !overseerSelection || end === null) return;
    const plan: NightPlan = {
      overseer: {
        projectId: project.id,
        modelSelection: overseerSelection,
        runtimeMode: projectDefaults.defaultRuntimeMode,
      },
      briefingMinutes,
      end: {
        agents: end.agents,
        ...(end.maxAgents === undefined ? {} : { maxAgents: end.maxAgents }),
        queue: end.queue,
        powerOff,
      },
    };
    setStarting(true);
    const result = await startNight({ environmentId, input: plan });
    setStarting(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not start the night", squashAtomCommandFailure(result));
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Night</DialogTitle>
        <DialogDescription>
          An overseer thread asks you its questions now, then watches every session while you sleep
          and writes a morning report.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-4">
          {!supported ? (
            <p className="text-sm text-muted-foreground">
              This environment's server has no night mode. Update the server to use it.
            </p>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label>Project</Label>
            {props.projectPicker}
            <p className="text-xs text-muted-foreground">
              The overseer and everything below run in this project's checkout.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Overseer</Label>
            <ModelChoice
              project={project}
              selection={overseerSelection}
              onChange={setOverseerModel}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Questions before you leave</Label>
            <Select
              value={String(briefingMinutes)}
              items={NIGHT_BRIEFING_MINUTES.map((minutes) => ({
                value: String(minutes),
                label: `Up to ${minutes} minutes`,
              }))}
              onValueChange={(value) => setBriefingMinutes(Number(value))}
            >
              <SelectTrigger size="sm" aria-label="Briefing length">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {NIGHT_BRIEFING_MINUTES.map((minutes) => (
                  <SelectItem key={minutes} value={String(minutes)}>
                    Up to {minutes} minutes
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <p className="text-xs text-muted-foreground">
              The night starts when you press I'm leaving, or when this time runs out.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>When all the work is done</Label>
            {snapshot ? (
              <>
                <span className="text-xs text-muted-foreground">Start agents for these cards</span>
                <CardChecklist
                  cards={cards}
                  selected={selectedCards}
                  onToggle={(id) =>
                    setSelectedCards((current) => {
                      const next = new Set(current);
                      if (!next.delete(id)) next.add(id);
                      return next;
                    })
                  }
                />
                {pickedCards.length > 1 ? (
                  <ToggleGroup
                    aria-label="How to run the card agents"
                    className="w-full *:flex-1"
                    value={[mode]}
                    onValueChange={(next) => {
                      const value = next[0];
                      if (value === "separate" || value === "orchestrator") setMode(value);
                    }}
                  >
                    <Toggle value="separate">A thread per card</Toggle>
                    <Toggle value="orchestrator">One orchestrator</Toggle>
                  </ToggleGroup>
                ) : null}
                {pickedCards.length > 1 ? (
                  <Select
                    // A limit at or above the card count starts them all, so it reads that way.
                    value={limit === "all" || limit >= pickedCards.length ? "all" : String(limit)}
                    items={[
                      ...TASK_AGENT_LIMITS.filter((value) => value < pickedCards.length).map(
                        (value) => ({ value: String(value), label: `At most ${value} at once` }),
                      ),
                      { value: "all", label: "All of them at once" },
                    ]}
                    onValueChange={(value) =>
                      setLimit(value === "all" || value === null ? "all" : Number(value))
                    }
                  >
                    <SelectTrigger size="sm" aria-label="Card agents at once">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {TASK_AGENT_LIMITS.filter((value) => value < pickedCards.length).map(
                        (value) => (
                          <SelectItem key={value} value={String(value)}>
                            At most {value} at once
                          </SelectItem>
                        ),
                      )}
                      <SelectItem value="all">All of them at once</SelectItem>
                    </SelectPopup>
                  </Select>
                ) : null}
              </>
            ) : null}
            <span className="text-xs text-muted-foreground">
              Then run these prompts, one at a time, each in a new thread
            </span>
            {prompts.map((prompt, index) => (
              <div key={prompt.id} className="flex items-start gap-1.5">
                <Textarea
                  size="sm"
                  value={prompt.text}
                  aria-label={`Prompt ${index + 1}`}
                  onChange={(event) => {
                    const text = event.target.value;
                    setPrompts((current) =>
                      current.map((item) => (item.id === prompt.id ? { ...item, text } : item)),
                    );
                  }}
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove prompt ${index + 1}`}
                  onClick={() =>
                    setPrompts((current) => current.filter((item) => item.id !== prompt.id))
                  }
                >
                  <XIcon />
                </Button>
              </div>
            ))}
            <div>
              <Button
                variant="outline"
                size="xs"
                onClick={() =>
                  setPrompts((current) => [
                    ...current,
                    { id: Math.max(0, ...current.map((item) => item.id)) + 1, text: "" },
                  ])
                }
              >
                <PlusIcon />
                Add a prompt
              </Button>
            </div>
            {end !== null && (end.agents.length > 0 || end.queue.length > 0) ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground">Model for these threads</span>
                <ModelChoice
                  project={project}
                  selection={agentsSelection}
                  onChange={setAgentsModel}
                />
              </div>
            ) : null}
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>Then power the computer off</span>
              <Switch checked={powerOff} onCheckedChange={setPowerOff} />
            </label>
            {powerOff ? (
              <p className="text-xs text-muted-foreground">
                A minute after the morning report, and only when nothing works. Ending the night
                cancels it.
              </p>
            ) : null}
          </div>
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={props.onClose} disabled={starting}>
          Cancel
        </Button>
        <Button onClick={() => void start()} disabled={blocked}>
          {starting ? <Spinner /> : <MoonIcon />}
          Start the night
        </Button>
      </DialogFooter>
    </>
  );
}

function NightStatus(props: {
  readonly environmentId: EnvironmentId;
  readonly state: NightState;
  /** Agents still waiting for a free slot. */
  readonly waitingAgents: number;
  readonly projectTitle: string | null;
  readonly onClose: () => void;
}) {
  const { environmentId, state } = props;
  const navigate = useNavigate();
  const canOperate = useAtomValue(serverEnvironment.stopNight.permissionAtom(environmentId));
  const leaveNight = useAtomCommand(serverEnvironment.leaveNight, { label: "leave for the night" });
  const stopNight = useAtomCommand(serverEnvironment.stopNight, { label: "end the night" });
  const [busy, setBusy] = useState(false);
  const runs = nightRuns(state);
  const { end } = state.plan;

  const run = async (
    command: typeof leaveNight | typeof stopNight,
    failureTitle: string,
  ): Promise<void> => {
    setBusy(true);
    const result = await command({ environmentId, input: {} });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure(failureTitle, squashAtomCommandFailure(result));
    }
  };

  const openOverseer = () => {
    props.onClose();
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, state.overseerThreadId)),
    });
  };

  const plannedEnd = [
    end.agents.length > 0
      ? `${end.agents.length} ${end.agents.length === 1 ? "agent" : "agents"}${end.maxAgents === undefined ? "" : `, ${end.maxAgents} at a time`}${state.agentsStarted ? (props.waitingAgents > 0 ? `, ${props.waitingAgents} still waiting` : " started") : ""}`
      : null,
    end.queue.length > 0 ? `${state.queueStarted} of ${end.queue.length} prompts started` : null,
    end.powerOff ? "power off" : null,
  ].filter((part) => part !== null);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Night</DialogTitle>
        <DialogDescription>{nightStatusLabel(state)}</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-3 text-sm">
          {state.phase === "briefing" ? (
            <p>
              Answer the overseer's questions in its thread, then press I'm leaving. The night rules
              reach every session from then on.
            </p>
          ) : null}
          {props.projectTitle ? (
            <p className="text-muted-foreground">Project: {props.projectTitle}</p>
          ) : null}
          {plannedEnd.length > 0 ? (
            <p className="text-muted-foreground">At the end: {plannedEnd.join(", ")}</p>
          ) : null}
          {state.powerOffError !== null && end.powerOff ? (
            <p className="text-muted-foreground">{state.powerOffError}</p>
          ) : null}
          <div>
            <Button variant="outline" size="sm" onClick={openOverseer}>
              Open the overseer
            </Button>
          </div>
        </div>
      </DialogPanel>
      <DialogFooter>
        {runs ? (
          <Button
            variant="outline"
            disabled={busy || !canOperate}
            onClick={() => void run(stopNight, "Could not end the night")}
          >
            End the night
          </Button>
        ) : (
          <Button
            variant="outline"
            disabled={busy || !canOperate}
            onClick={() => void run(stopNight, "Could not dismiss the night")}
          >
            {state.poweringOffAt !== null ? "Stay on and dismiss" : "Dismiss"}
          </Button>
        )}
        {state.phase === "briefing" ? (
          <Button
            disabled={busy || !canOperate}
            onClick={() => void run(leaveNight, "Could not start the night")}
          >
            {busy ? <Spinner /> : <MoonIcon />}
            I'm leaving
          </Button>
        ) : (
          <Button onClick={props.onClose}>Close</Button>
        )}
      </DialogFooter>
    </>
  );
}

export function NightDialog(props: { readonly onClose: () => void }) {
  const projects = useProjects();
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const keyOf = (project: EnvironmentProject) =>
    scopedProjectKey(scopeProjectRef(project.environmentId, project.id));
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  const project =
    projects.find((candidate) => keyOf(candidate) === chosenKey) ??
    projects.find((candidate) => candidate.environmentId === primaryEnvironmentId) ??
    projects[0] ??
    null;
  const environmentId = project?.environmentId ?? null;
  const configs = useServerConfigs();
  const supported =
    environmentId !== null &&
    configs.get(environmentId)?.environment.capabilities.nightMode === true;
  const night = useEnvironmentQuery(
    environmentId !== null && supported
      ? serverEnvironment.unattendedLive({ environmentId, input: {} })
      : null,
  );
  const state = night.data?.night ?? null;
  const waitingAgents = (night.data?.agentQueues ?? []).reduce(
    (total, queue) => total + queue.waiting.length,
    0,
  );

  const projectPicker = (
    <Select
      value={project ? keyOf(project) : null}
      items={projects.map((item) => ({ value: keyOf(item), label: item.title }))}
      onValueChange={(value) => setChosenKey(value)}
    >
      <SelectTrigger size="sm" aria-label="Night project">
        <SelectValue placeholder="Choose project" />
      </SelectTrigger>
      <SelectPopup>
        {projects.map((item) => (
          <SelectItem key={keyOf(item)} value={keyOf(item)}>
            {item.title}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        {project === null || environmentId === null ? (
          <DialogPanel>
            <p className="text-sm text-muted-foreground">Add a project to plan a night.</p>
          </DialogPanel>
        ) : state !== null ? (
          <NightStatus
            environmentId={environmentId}
            state={state}
            waitingAgents={waitingAgents}
            projectTitle={
              projects.find(
                (item) =>
                  item.environmentId === environmentId && item.id === state.plan.overseer.projectId,
              )?.title ?? null
            }
            onClose={props.onClose}
          />
        ) : supported && night.data === null && night.error === null ? (
          // A live stream stays pending while it runs; only its first item ends the wait.
          <DialogPanel>
            <Spinner />
          </DialogPanel>
        ) : (
          <NightSetup project={project} projectPicker={projectPicker} onClose={props.onClose} />
        )}
      </DialogPopup>
    </Dialog>
  );
}
