// FORK: start agents for the cards picked on the TODO board.
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { ModelSelection, ThreadId, TodoBoardCard } from "@t3tools/contracts";
import {
  AuthOrchestrationOperateScope,
  OrchestrationV2ThreadInstructions,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { createModelSelection } from "@t3tools/shared/model";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Schema from "effect/Schema";
import { useMemo, useState } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { newMessageId, newThreadId } from "~/lib/utils";
import { getCustomModelOptionsByInstance } from "~/modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "~/providerInstances";
import { useServerConfigs } from "~/state/entities";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { useAtomCommand } from "~/state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { scheduledTaskDefaultModel } from "../settings/scheduledTasksSettings.logic";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  DEFAULT_ORCHESTRATOR_INSTRUCTIONS,
  DEFAULT_TASK_AGENT_LIMIT,
  ORCHESTRATOR_INSTRUCTIONS_PATH,
  planTaskAgentLaunches,
  TASK_AGENT_LIMITS,
  type TaskAgentsMode,
} from "./taskAgentsLogic";

const isThreadInstructions = Schema.is(OrchestrationV2ThreadInstructions);

const failureText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function TaskAgentsDialog(props: {
  readonly project: EnvironmentProject;
  /** The board's checkout, where the project's orchestrator instructions live. */
  readonly root: string;
  readonly cards: ReadonlyArray<TodoBoardCard>;
  readonly onClose: () => void;
  /** `waiting` cards start later, each when a slot frees up. */
  readonly onStarted: (threads: ReadonlyArray<ThreadId>, waiting: number) => void;
}) {
  const { project, cards } = props;
  const environmentId = project.environmentId;
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const capabilities = useServerConfigs().get(environmentId)?.environment.capabilities;
  const orchestratorSupported = capabilities?.threadInstructions === true;
  const queueSupported = capabilities?.agentQueue === true;
  const startAgentQueue = useAtomCommand(serverEnvironment.startAgentQueue, {
    label: "start card agents a few at a time",
  });
  const canStart = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const startThreadTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    reportFailure: false,
  });

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
  const [chosen, setChosen] = useState<ModelSelection | null>(null);
  const selection = chosen ?? scheduledTaskDefaultModel(settings, project, instanceEntries);
  const activeEntry = instanceEntries.find((entry) => entry.instanceId === selection?.instanceId);
  const modelOptionsByInstance = useMemo(
    () =>
      getCustomModelOptionsByInstance(settings, providers, selection?.instanceId, selection?.model),
    [settings, providers, selection?.instanceId, selection?.model],
  );
  const projectDefaults = resolveProjectSettings(settings, project.id, project).settings;

  const [mode, setMode] = useState<TaskAgentsMode>(
    cards.length > 1 && orchestratorSupported ? "orchestrator" : "separate",
  );
  const orchestrator = mode === "orchestrator";
  const instructionsFile = useEnvironmentQuery(
    orchestrator
      ? projectEnvironment.readFile({
          environmentId,
          input: { cwd: props.root, relativePath: ORCHESTRATOR_INSTRUCTIONS_PATH },
        })
      : null,
  );
  const fileText = instructionsFile.data?.contents.trim() ?? "";
  const instructions = fileText || DEFAULT_ORCHESTRATOR_INSTRUCTIONS;
  const instructionsValid = isThreadInstructions(instructions);
  const [starting, setStarting] = useState(false);
  // The default keeps the machine responsive; "all" starts every card at once.
  const [limit, setLimit] = useState<number | "all">(DEFAULT_TASK_AGENT_LIMIT);
  const maxRunning = limit === "all" || limit >= cards.length ? undefined : limit;
  // A thread per card waits for free slots on the server; an orchestrator is told the limit.
  const queued = !orchestrator && maxRunning !== undefined && queueSupported;

  const start = async () => {
    if (!selection || starting) return;
    setStarting(true);
    const runtimeMode = projectDefaults.defaultRuntimeMode;
    const interactionMode = projectDefaults.newThreadsStartInPlan ? "plan" : "default";
    const launches = planTaskAgentLaunches({
      mode,
      projectTitle: project.title,
      cards,
      instructions,
      ...(maxRunning === undefined ? {} : { maxRunning }),
    });
    if (queued && maxRunning !== undefined) {
      const result = await startAgentQueue({
        environmentId,
        input: {
          label: `${project.title}: ${cards.length} cards`,
          maxRunning,
          launches: launches.map((launch) => ({
            projectId: project.id,
            title: launch.title,
            text: launch.text,
            modelSelection: selection,
            runtimeMode,
            interactionMode,
          })),
        },
      });
      setStarting(false);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not start agents",
              description: failureText(squashAtomCommandFailure(result)),
            }),
          );
        }
        return;
      }
      props.onStarted(
        result.value.started.map((thread) => thread.threadId),
        result.value.waiting.length,
      );
      props.onClose();
      return;
    }
    const started: ThreadId[] = [];
    let failure: string | null = null;
    // In order, so the threads appear in the sidebar the way the cards were picked.
    for (const launch of launches) {
      const threadId = newThreadId();
      const result = await startThreadTurn({
        environmentId,
        input: {
          threadId,
          message: { messageId: newMessageId(), role: "user", text: launch.text, attachments: [] },
          modelSelection: selection,
          runtimeMode,
          interactionMode,
          bootstrap: {
            createThread: {
              projectId: project.id,
              title: launch.title,
              modelSelection: selection,
              runtimeMode,
              interactionMode,
              branch: null,
              worktreePath: null,
              createdAt: new Date().toISOString(),
              ...(launch.instructions === undefined ? {} : { instructions: launch.instructions }),
            },
          },
        },
      });
      if (result._tag === "Failure") {
        failure = "An agent could not be started.";
        break;
      }
      started.push(threadId);
    }
    setStarting(false);
    if (failure !== null) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title:
            started.length === 0
              ? "Could not start agents"
              : `Started ${started.length} of ${launches.length} agents`,
          description: failure,
        }),
      );
    }
    if (started.length > 0) props.onStarted(started, 0);
    if (failure === null) props.onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !starting) props.onClose();
      }}
    >
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {cards.length === 1 ? "Start an agent" : `Start agents for ${cards.length} cards`}
          </DialogTitle>
          <DialogDescription>
            {cards
              .map((card) => card.id)
              .slice(0, 6)
              .join(", ")}
            {cards.length > 6 ? ` and ${cards.length - 6} more` : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>Run</Label>
              <ToggleGroup
                aria-label="How to run the agents"
                className="w-full *:flex-1"
                value={[mode]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "separate" || value === "orchestrator") setMode(value);
                }}
              >
                <Toggle value="separate">
                  {cards.length === 1 ? "In its own thread" : "A thread per card"}
                </Toggle>
                <Toggle value="orchestrator" disabled={!orchestratorSupported}>
                  One orchestrator
                </Toggle>
              </ToggleGroup>
              <p className="text-xs text-muted-foreground">
                {!orchestratorSupported
                  ? "This environment's server does not support orchestrators yet. Update the server to use them."
                  : orchestrator
                    ? "One thread gets the cards and starts a writer for each of them."
                    : "Each card starts in its own thread in the project's checkout, with the card's prompt."}
              </p>
            </div>
            {cards.length > 1 && (orchestrator || queueSupported) ? (
              <div className="flex flex-col gap-1.5">
                <Label>At once</Label>
                <Select
                  value={String(limit)}
                  items={[
                    ...TASK_AGENT_LIMITS.filter((value) => value < cards.length).map((value) => ({
                      value: String(value),
                      label: `At most ${value}`,
                    })),
                    { value: "all", label: "All of them" },
                  ]}
                  onValueChange={(value) =>
                    setLimit(value === "all" || value === null ? "all" : Number(value))
                  }
                >
                  <SelectTrigger size="sm" aria-label="Agents at once">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    {TASK_AGENT_LIMITS.filter((value) => value < cards.length).map((value) => (
                      <SelectItem key={value} value={String(value)}>
                        At most {value}
                      </SelectItem>
                    ))}
                    <SelectItem value="all">All of them</SelectItem>
                  </SelectPopup>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {maxRunning === undefined
                    ? "Every card starts now."
                    : orchestrator
                      ? `The orchestrator runs at most ${maxRunning} writers at a time.`
                      : `${maxRunning} start now; each of the rest starts when one of them finishes or waits for your answer.`}
                </p>
              </div>
            ) : null}
            {orchestrator ? (
              <div className="flex flex-col gap-1.5">
                <Label>Instructions</Label>
                {instructionsFile.isPending ? (
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Spinner />
                    Reading {ORCHESTRATOR_INSTRUCTIONS_PATH}…
                  </span>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {fileText
                      ? `From ${ORCHESTRATOR_INSTRUCTIONS_PATH} in the project.`
                      : `Built in. Add ${ORCHESTRATOR_INSTRUCTIONS_PATH} to the project to use your own.`}
                    {instructionsValid
                      ? ""
                      : " They are longer than 32,000 characters; shorten the file to start."}
                  </p>
                )}
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted-foreground">
                    Show instructions
                  </summary>
                  <pre className="mt-2 max-h-48 overflow-auto rounded-md border bg-muted/40 p-2 whitespace-pre-wrap">
                    {instructions}
                  </pre>
                </details>
              </div>
            ) : null}
            <div className="flex flex-col gap-1.5">
              <Label>Model</Label>
              {selection && activeEntry ? (
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <ProviderModelPicker
                    environmentId={environmentId}
                    activeInstanceId={selection.instanceId}
                    model={selection.model}
                    lockedProvider={null}
                    instanceEntries={instanceEntries}
                    modelOptionsByInstance={modelOptionsByInstance}
                    isComposerOwned={false}
                    onInstanceModelChange={(instanceId, model) =>
                      setChosen(createModelSelection(instanceId, model))
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
                      setChosen(
                        createModelSelection(selection.instanceId, selection.model, options),
                      )
                    }
                  />
                </div>
              ) : (
                <span className="text-sm text-muted-foreground">No providers available</span>
              )}
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose} disabled={starting}>
            Cancel
          </Button>
          <Button
            onClick={() => void start()}
            disabled={
              starting ||
              !canStart ||
              !selection ||
              (orchestrator && (instructionsFile.isPending || !instructionsValid))
            }
          >
            {starting ? <Spinner /> : null}
            {orchestrator
              ? "Start orchestrator"
              : cards.length === 1
                ? "Start agent"
                : `Start ${cards.length} agents`}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
