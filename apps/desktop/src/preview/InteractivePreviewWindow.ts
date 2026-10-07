import type { DesktopPreviewTabState, PreviewViewportSetting } from "@t3tools/contracts";
import { BrowserWindow, WebContentsView, type Session } from "electron";

import { PREVIEW_WINDOW_ACTION_CHANNEL, PREVIEW_WINDOW_STATE_CHANNEL } from "../ipc/channels.ts";

export type PreviewWindowAction =
  | { readonly kind: "back" | "forward" | "refresh" | "return" | "fullscreen" }
  | { readonly kind: "navigate"; readonly url: string };

export function isPreviewWindowAction(value: unknown): value is PreviewWindowAction {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  if (value.kind === "navigate") {
    return "url" in value && typeof value.url === "string" && value.url.length <= 8192;
  }
  return (
    typeof value.kind === "string" &&
    ["back", "forward", "refresh", "return", "fullscreen"].includes(value.kind)
  );
}

const CHROME_HEIGHT = 52;

const chromeUrl = () =>
  `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><meta name="color-scheme" content="dark light"><style>
*{box-sizing:border-box}html,body{margin:0;height:100%;background:#09090b;color:#e4e4e7;font:13px system-ui,sans-serif}header{height:${CHROME_HEIGHT}px;display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid #29292e}button,input{font:inherit;color:inherit;background:transparent;border:1px solid #29292e;border-radius:6px;padding:7px 9px}button{cursor:pointer;white-space:nowrap}button:hover{background:#ffffff10}button:disabled{opacity:.4;cursor:default}button:focus-visible,input:focus-visible{outline:2px solid #8b7df0;outline-offset:2px}form{display:flex;flex:1;min-width:80px}input{width:100%;min-width:0}#error{position:fixed;right:12px;top:6px;padding:6px;pointer-events:none;border-radius:6px;background:#511c21;max-width:360px;z-index:1}[hidden]{display:none}
</style></head><body><header><button id="back" aria-label="Back">←</button><button id="forward" aria-label="Forward">→</button><button id="refresh" aria-label="Reload page">↻</button><form id="navigation"><input id="url" aria-label="Preview URL" autocomplete="off" spellcheck="false"></form><button id="fullscreen">Fullscreen</button><button id="return">Return to T3</button></header><div id="error" role="alert" hidden></div><script>
const api=window.previewWindow;const url=document.getElementById('url');const error=document.getElementById('error');
async function action(input){try{error.hidden=true;await api.action(input);}catch{error.textContent='Unable to update preview. Try again.';error.hidden=false;}}
for(const kind of ['back','forward','refresh','fullscreen','return'])document.getElementById(kind).onclick=()=>action({kind});
document.getElementById('navigation').onsubmit=event=>{event.preventDefault();action({kind:'navigate',url:url.value});};
api.onState(state=>{if(document.activeElement!==url)url.value=state.url;document.getElementById('back').disabled=!state.canGoBack;document.getElementById('forward').disabled=!state.canGoForward;document.getElementById('fullscreen').textContent=state.fullscreen?'Exit fullscreen':'Fullscreen';});
document.addEventListener('keydown',event=>{if(event.key==='F11'){event.preventDefault();action({kind:'fullscreen'});}if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='l'){event.preventDefault();url.focus();url.select();}});
</script></body></html>`)}`;

/** The chrome has a narrow preload; the page never receives T3's desktop bridge. */
export function createInteractivePreviewWindow(options: {
  readonly session: Session;
  readonly chromePreloadPath: string;
  readonly pagePreloadPath: string;
  readonly viewport: PreviewViewportSetting;
  readonly zoomFactor: number;
  readonly onAction: (action: PreviewWindowAction) => Promise<void>;
  readonly onClosed: () => void;
}) {
  let viewport = options.viewport;
  let zoomFactor = options.zoomFactor;
  let lastState: DesktopPreviewTabState | null = null;
  let disposed = false;
  const width = viewport._tag === "fill" ? 1100 : Math.round(viewport.width * zoomFactor);
  const height =
    viewport._tag === "fill" ? 760 : Math.round(viewport.height * zoomFactor) + CHROME_HEIGHT;
  const window = new BrowserWindow({
    width,
    height,
    useContentSize: true,
    minWidth: 480,
    minHeight: 320,
    title: "Browser preview",
    show: false,
    autoHideMenuBar: true,
    fullscreenable: true,
    maximizable: true,
    minimizable: true,
    resizable: true,
    backgroundColor: "#09090b",
    webPreferences: {
      preload: options.chromePreloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  let pageForCleanup: Electron.WebContents | undefined;
  try {
    const view = new WebContentsView({
      webPreferences: {
        session: options.session,
        preload: options.pagePreloadPath,
        // Same guest preload contract as the embedded preview (react-grab and picking).
        contextIsolation: false,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        backgroundThrottling: false,
      },
    });
    pageForCleanup = view.webContents;
    window.contentView.addChildView(view);
    const syncBounds = () => {
      if (window.isDestroyed() || view.webContents.isDestroyed()) return;
      const [contentWidth = 1, contentHeight = CHROME_HEIGHT + 1] = window.getContentSize();
      view.setBounds({
        x: 0,
        y: CHROME_HEIGHT,
        width:
          viewport._tag === "fill"
            ? Math.max(1, contentWidth)
            : Math.round(viewport.width * zoomFactor),
        height:
          viewport._tag === "fill"
            ? Math.max(1, contentHeight - CHROME_HEIGHT)
            : Math.round(viewport.height * zoomFactor),
      });
    };
    const syncChrome = () => {
      if (window.isDestroyed() || !lastState) return;
      const nav = lastState.navStatus;
      window.setTitle(
        nav.kind === "Idle" || !nav.title ? "Browser preview" : `Preview · ${nav.title}`,
      );
      window.webContents.send(PREVIEW_WINDOW_STATE_CHANNEL, {
        url: nav.kind === "Idle" ? "" : nav.url,
        canGoBack: lastState.canGoBack,
        canGoForward: lastState.canGoForward,
        fullscreen: window.isFullScreen(),
      });
    };
    window.on("resize", syncBounds);
    window.on("enter-full-screen", syncChrome);
    window.on("leave-full-screen", syncChrome);
    const onClosed = () => {
      // Abort page loads immediately so a command cannot hold its lifecycle lock
      // while the owning window has already gone away.
      if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
      options.onClosed();
    };
    window.once("closed", onClosed);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" && input.key === "Escape" && window.isFullScreen()) {
        event.preventDefault();
        window.setFullScreen(false);
      }
    });
    window.webContents.ipc.handle(PREVIEW_WINDOW_ACTION_CHANNEL, (event, action: unknown) => {
      if (
        disposed ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        !isPreviewWindowAction(action)
      )
        throw new Error("Invalid preview window action.");
      if (action.kind === "fullscreen") {
        window.setFullScreen(!window.isFullScreen());
        return;
      }
      return options.onAction(action);
    });
    view.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      if (input.key === "F11" || (input.key === "Escape" && window.isFullScreen())) {
        event.preventDefault();
        window.setFullScreen(!window.isFullScreen());
      }
      if ((input.control || input.meta) && input.key.toLowerCase() === "l") {
        event.preventDefault();
        window.webContents.focus();
        void window.webContents.executeJavaScript(
          "document.getElementById('url').focus();document.getElementById('url').select();",
        );
      }
    });
    syncBounds();
    return {
      window,
      webContents: view.webContents,
      initialize: async () => {
        await window.loadURL(chromeUrl());
        if (disposed || window.isDestroyed())
          throw new Error("Preview window closed while opening.");
        syncChrome();
        window.show();
        view.webContents.focus();
      },
      update: (state: DesktopPreviewTabState) => {
        lastState = state;
        if (zoomFactor !== state.zoomFactor) {
          zoomFactor = state.zoomFactor;
          syncBounds();
        }
        syncChrome();
      },
      setViewport: (next: PreviewViewportSetting) => {
        viewport = next;
        syncBounds();
      },
      status: () => ({
        visible: !window.isDestroyed() && window.isVisible() && !window.isMinimized(),
        viewportSetting: viewport,
      }),
      focus: () => {
        if (!window.isDestroyed()) {
          window.show();
          window.focus();
          view.webContents.focus();
        }
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        window.removeListener("closed", onClosed);
        if (!window.isDestroyed())
          window.webContents.ipc.removeHandler(PREVIEW_WINDOW_ACTION_CHANNEL);
        if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
        if (!window.isDestroyed()) window.close();
      },
    };
  } catch (error) {
    if (pageForCleanup && !pageForCleanup.isDestroyed())
      pageForCleanup.close({ waitForBeforeUnload: false });
    if (!window.isDestroyed()) window.close();
    throw error;
  }
}

export type InteractivePreviewWindow = ReturnType<typeof createInteractivePreviewWindow>;
