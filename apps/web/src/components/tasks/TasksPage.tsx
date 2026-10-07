import {
  scopeProjectRef,
  scopedProjectKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  ProjectId,
  TodoBoardCard,
  TodoBoardSnapshot,
} from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { FileTextIcon, ListTodoIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { isElectron } from "~/env";
import { useProjects, useThreadShells } from "~/state/entities";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { buildThreadRouteParams } from "~/threadRoutes";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import ChatMarkdown from "~/components/ChatMarkdown";
import { TasksPanel } from "./TasksPanel";
import { appendTaskPrompt } from "./taskBoardLogic";
import { newDraftId } from "~/lib/utils";

export interface TasksPageSearch {
  environmentId?: EnvironmentId;
  projectId?: ProjectId;
  threadId?: ThreadId;
  draftId?: string;
}

export function TasksPage({ search }: { search: TasksPageSearch }) {
  const projects = useProjects();
  const threads = useThreadShells();
  const navigate = useNavigate();
  const project =
    search.projectId || search.environmentId
      ? (projects.find(
          (candidate) =>
            candidate.id === search.projectId && candidate.environmentId === search.environmentId,
        ) ?? null)
      : (projects[0] ?? null);
  const projectRef = project ? scopeProjectRef(project.environmentId, project.id) : null;
  const projectKey = projectRef ? scopedProjectKey(projectRef) : null;
  const [file, setFile] = useState<{
    projectKey: string;
    root: string;
    path: string;
    note: string | null;
  } | null>(null);
  const selectedFile = file?.projectKey === projectKey ? file : null;
  const fileQuery = useEnvironmentQuery(
    project && selectedFile && selectedFile.note === null
      ? projectEnvironment.readFile({
          environmentId: project.environmentId,
          input: { cwd: selectedFile.root, relativePath: selectedFile.path },
        })
      : null,
  );
  const stageCard = (card: TodoBoardCard) => {
    if (!project || !projectRef) return;
    const store = useComposerDraftStore.getState();
    const thread = threads.find(
      (candidate) =>
        candidate.environmentId === project.environmentId &&
        candidate.id === search.threadId &&
        candidate.projectId === project.id,
    );
    if (thread) {
      const ref = scopeThreadRef(project.environmentId, ThreadId.make(thread.id));
      store.setPrompt(ref, appendTaskPrompt(store.getComposerDraft(ref)?.prompt ?? "", card));
      void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
      return;
    }
    const targeted = search.draftId ? store.getDraftSession(DraftId.make(search.draftId)) : null;
    const matchingTarget =
      targeted?.projectId === project.id && targeted.environmentId === project.environmentId
        ? targeted
        : null;
    const existing = matchingTarget
      ? { draftId: DraftId.make(search.draftId ?? "") }
      : store.getDraftSessionByProjectRef(projectRef);
    const draftId = existing?.draftId ?? newDraftId();
    if (!existing)
      store.setLogicalProjectDraftThreadId(scopedProjectKey(projectRef), projectRef, draftId, {
        envMode: "local",
        environmentSelection: "manual",
      });
    store.setPrompt(draftId, appendTaskPrompt(store.getComposerDraft(draftId)?.prompt ?? "", card));
    void navigate({ to: "/draft/$draftId", params: { draftId } });
  };
  const openFile = (snapshot: TodoBoardSnapshot, card: TodoBoardCard) => {
    if (projectKey && !card.origin_only)
      setFile({
        projectKey,
        root: snapshot.root,
        path: card.path,
        note: card.kind === "note" ? card.prompt : null,
      });
  };
  return (
    <main className="flex h-full min-h-0 flex-col">
      <WorkspacePageHeader electron={isElectron}>
        <ListTodoIcon className="size-4" />
        <h1 className="text-sm font-medium">Tasks</h1>
        <div className="ml-auto min-w-0">
          <Select
            value={projectKey}
            items={projects.map((item) => ({
              value: scopedProjectKey(scopeProjectRef(item.environmentId, item.id)),
              label: item.title,
            }))}
            onValueChange={(value) => {
              const next = projects.find(
                (item) => scopedProjectKey(scopeProjectRef(item.environmentId, item.id)) === value,
              );
              if (next)
                void navigate({
                  to: "/tasks",
                  search: { environmentId: next.environmentId, projectId: next.id },
                });
            }}
          >
            <SelectTrigger size="sm" aria-label="Tasks project">
              <SelectValue placeholder="Choose project" />
            </SelectTrigger>
            <SelectPopup>
              {projects.map((item) => (
                <SelectItem
                  key={`${item.environmentId}:${item.id}`}
                  value={scopedProjectKey(scopeProjectRef(item.environmentId, item.id))}
                >
                  {item.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </WorkspacePageHeader>
      {!project ? (
        <p className="p-6 text-sm text-muted-foreground">
          {projects.length === 0 ? "No projects." : "Project unavailable."}
        </p>
      ) : (
        <>
          {selectedFile ? (
            <div className="flex shrink-0 items-center gap-2 border-b p-2">
              <Button variant="ghost" size="xs" onClick={() => setFile(null)}>
                <ListTodoIcon />
                Tasks
              </Button>
              <FileTextIcon className="size-3.5" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{selectedFile.path}</span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Close card file"
                onClick={() => setFile(null)}
              >
                <XIcon />
              </Button>
            </div>
          ) : null}
          <div className="min-h-0 flex-1">
            {selectedFile ? (
              <div className="h-full overflow-auto p-5">
                {selectedFile.note === null && fileQuery.isPending ? (
                  <Spinner />
                ) : selectedFile.note === null && fileQuery.error ? (
                  <p role="alert" className="text-sm text-destructive">
                    {fileQuery.error}
                  </p>
                ) : (
                  <>
                    {selectedFile.note === null && fileQuery.data?.truncated ? (
                      <p role="status" className="mb-3 text-sm text-warning-foreground">
                        This file is too large to display in full.
                      </p>
                    ) : null}
                    <ChatMarkdown
                      text={selectedFile.note ?? fileQuery.data?.contents ?? ""}
                      cwd={selectedFile.root}
                      environmentId={project.environmentId}
                    />
                  </>
                )}
              </div>
            ) : (
              <TasksPanel
                key={projectKey}
                project={project}
                onUseInChat={stageCard}
                onOpenFile={openFile}
              />
            )}
          </div>
        </>
      )}
    </main>
  );
}
