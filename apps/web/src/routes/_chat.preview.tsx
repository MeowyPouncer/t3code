import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { PreviewWorkspacePage } from "~/components/preview/PreviewWorkspacePage";

export interface PreviewWorkspaceSearch {
  environmentId?: EnvironmentId;
  threadId?: ThreadId;
  tabId?: string;
}

export const Route = createFileRoute("/_chat/preview")({
  validateSearch: (input: Record<string, unknown>): PreviewWorkspaceSearch => ({
    ...(typeof input.environmentId === "string" && input.environmentId
      ? { environmentId: EnvironmentId.make(input.environmentId) }
      : {}),
    ...(typeof input.threadId === "string" && input.threadId
      ? { threadId: ThreadId.make(input.threadId) }
      : {}),
    ...(typeof input.tabId === "string" && input.tabId ? { tabId: input.tabId } : {}),
  }),
  component: function PreviewWorkspaceRoute() {
    return <PreviewWorkspacePage {...Route.useSearch()} />;
  },
});
