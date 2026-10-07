import { createFileRoute } from "@tanstack/react-router";
import { TasksPage, type TasksPageSearch } from "~/components/tasks/TasksPage";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

export const Route = createFileRoute("/_chat/tasks")({
  validateSearch: (input: Record<string, unknown>): TasksPageSearch => ({
    ...(typeof input.environmentId === "string" && input.environmentId.length > 0
      ? { environmentId: EnvironmentId.make(input.environmentId) }
      : {}),
    ...(typeof input.projectId === "string" && input.projectId.length > 0
      ? { projectId: ProjectId.make(input.projectId) }
      : {}),
    ...(typeof input.threadId === "string" && input.threadId.length > 0
      ? { threadId: ThreadId.make(input.threadId) }
      : {}),
    ...(typeof input.draftId === "string" ? { draftId: input.draftId } : {}),
  }),
  component: function TasksRoute() {
    return <TasksPage search={Route.useSearch()} />;
  },
});
