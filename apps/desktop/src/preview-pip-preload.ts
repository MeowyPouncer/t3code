import type { DesktopPreviewRecordingFrame } from "@t3tools/contracts";
import { contextBridge, ipcRenderer } from "electron";

import {
  PREVIEW_PICTURE_IN_PICTURE_FRAME_CHANNEL,
  PREVIEW_WINDOW_ACTION_CHANNEL,
  PREVIEW_WINDOW_STATE_CHANNEL,
} from "./ipc/channels.ts";

contextBridge.exposeInMainWorld("previewWindow", {
  action: (action: unknown) => ipcRenderer.invoke(PREVIEW_WINDOW_ACTION_CHANNEL, action),
  onState: (listener: (state: unknown) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: unknown) => listener(state);
    ipcRenderer.on(PREVIEW_WINDOW_STATE_CHANNEL, wrapped);
    return () => ipcRenderer.removeListener(PREVIEW_WINDOW_STATE_CHANNEL, wrapped);
  },
});

contextBridge.exposeInMainWorld("previewPictureInPicture", {
  onFrame: (listener: (frame: DesktopPreviewRecordingFrame) => void) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, frame: unknown) => {
      if (typeof frame !== "object" || frame === null) return;
      listener(frame as DesktopPreviewRecordingFrame);
    };
    ipcRenderer.on(PREVIEW_PICTURE_IN_PICTURE_FRAME_CHANNEL, wrappedListener);
    return () =>
      ipcRenderer.removeListener(PREVIEW_PICTURE_IN_PICTURE_FRAME_CHANNEL, wrappedListener);
  },
});
