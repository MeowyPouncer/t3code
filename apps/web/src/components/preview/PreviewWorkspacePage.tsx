import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { MaximizeIcon, MinimizeIcon, XIcon } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { toastManager } from "~/components/ui/toast";
import { useNavigateToMainApp } from "~/components/sidebar/mainAppLocation";
import { browserMiniPlayerSource, usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { PreviewView } from "./PreviewView";

export function PreviewWorkspacePage({
  environmentId,
  threadId,
  tabId,
}: {
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
  readonly tabId?: string;
}) {
  const returnToChat = useNavigateToMainApp();
  const [fullscreen, setFullscreen] = useState(() => document.fullscreenElement !== null);
  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);
  const leave = async (minimize: boolean) => {
    if (document.fullscreenElement) await document.exitFullscreen();
    if (minimize && environmentId && threadId && tabId) {
      usePreviewMiniPlayerStore
        .getState()
        .open({ environmentId, threadId }, browserMiniPlayerSource(tabId));
    }
    await returnToChat();
  };
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Unable to enter fullscreen",
        description: error instanceof Error ? error.message : "Try maximizing the T3 window.",
      });
    }
  };
  return (
    <main
      className="flex h-dvh min-h-0 flex-1 flex-col bg-background"
      aria-label="Browser workspace"
    >
      <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <span className="flex-1 text-sm font-medium">Browser preview</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
                onClick={() => void toggleFullscreen()}
              />
            }
          >
            <MaximizeIcon />
          </TooltipTrigger>
          <TooltipPopup>{fullscreen ? "Exit fullscreen" : "Fullscreen"}</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Minimize preview"
                onClick={() => void leave(true)}
              />
            }
          >
            <MinimizeIcon />
          </TooltipTrigger>
          <TooltipPopup>Minimize preview</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Return to chat"
                onClick={() => void leave(false)}
              />
            }
          >
            <XIcon />
          </TooltipTrigger>
          <TooltipPopup>Return to chat</TooltipPopup>
        </Tooltip>
      </header>
      {environmentId && threadId && tabId ? (
        <PreviewView threadRef={{ environmentId, threadId }} tabId={tabId} visible />
      ) : (
        <div className="p-6 text-sm text-muted-foreground">This preview is unavailable.</div>
      )}
    </main>
  );
}
