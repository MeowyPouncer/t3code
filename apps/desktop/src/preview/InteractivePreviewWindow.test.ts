import type { DesktopPreviewTabState } from "@t3tools/contracts";
import type { Session } from "electron";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { createInteractivePreviewWindow } from "./InteractivePreviewWindow.ts";
import { PREVIEW_WINDOW_ACTION_CHANNEL } from "../ipc/channels.ts";

const constructors = vi.hoisted(() => ({ window: vi.fn(), view: vi.fn() }));
vi.mock("electron", () => ({
  BrowserWindow: function (options: unknown) {
    return constructors.window(options);
  },
  WebContentsView: function (options: unknown) {
    return constructors.view(options);
  },
}));

function setup() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const pageListeners = new Map<string, (...args: unknown[]) => void>();
  const handlers = new Map<string, (event: unknown, action: unknown) => unknown>();
  let fullscreen = false,
    destroyed = false;
  let minimized = false;
  let contentSize = [1100, 760];
  const chrome = {
    mainFrame: {},
    send: vi.fn(),
    focus: vi.fn(),
    executeJavaScript: vi.fn(async () => undefined),
    setWindowOpenHandler: vi.fn(),
    on: vi.fn((name: string, fn: (...args: unknown[]) => void) => listeners.set(name, fn)),
    ipc: {
      handle: vi.fn((name: string, fn: (event: unknown, action: unknown) => unknown) =>
        handlers.set(name, fn),
      ),
      removeHandler: vi.fn((name: string) => handlers.delete(name)),
    },
  };
  const page = {
    id: 84,
    isDestroyed: () => false,
    close: vi.fn(),
    enableDeviceEmulation: vi.fn(),
    disableDeviceEmulation: vi.fn(),
    focus: vi.fn(),
    on: vi.fn((name: string, fn: (...args: unknown[]) => void) => pageListeners.set(name, fn)),
  };
  const window = {
    webContents: chrome,
    contentView: { addChildView: vi.fn() },
    on: vi.fn((name: string, fn: (...args: unknown[]) => void) => listeners.set(name, fn)),
    once: vi.fn((name: string, fn: (...args: unknown[]) => void) => listeners.set(name, fn)),
    removeListener: vi.fn((name: string) => listeners.delete(name)),
    getContentSize: () => contentSize,
    isDestroyed: () => destroyed,
    isVisible: () => true,
    isMinimized: () => minimized,
    restore: vi.fn(() => {
      minimized = false;
      listeners.get("restore")?.();
    }),
    isFullScreen: () => fullscreen,
    setFullScreen: vi.fn((value: boolean) => {
      fullscreen = value;
    }),
    setTitle: vi.fn(),
    loadURL: vi.fn(async (_url: string) => undefined),
    show: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(() => {
      destroyed = true;
      listeners.get("closed")?.();
    }),
  };
  const view = {
    webContents: page,
    setBounds: vi.fn<(bounds: { x: number; y: number; width: number; height: number }) => void>(),
  };
  constructors.window.mockReturnValue(window);
  constructors.view.mockReturnValue(view);
  const onAction = vi.fn(async () => undefined);
  const profile = {} as Session;
  const options = {
    session: profile,
    chromePreloadPath: "/chrome.cjs",
    pagePreloadPath: "/page.cjs",
    viewport: { _tag: "fill" as const },
    zoomFactor: 1,
    onAction,
    onVisibilityChange: vi.fn(),
    onClosed: vi.fn(),
  };
  const create = () => createInteractivePreviewWindow(options);
  const action = (
    input: unknown,
    sender: unknown = chrome,
    senderFrame: unknown = chrome.mainFrame,
  ) => handlers.get(PREVIEW_WINDOW_ACTION_CHANNEL)?.({ sender, senderFrame }, input);
  return {
    create,
    options,
    window,
    view,
    page,
    chrome,
    listeners,
    pageListeners,
    onAction,
    action,
    minimize: () => {
      minimized = true;
      listeners.get("minimize")?.();
    },
    resize: (next = [1440, 900]) => {
      contentSize = next;
      listeners.get("resize")?.();
    },
  };
}

beforeEach(() => {
  constructors.window.mockReset();
  constructors.view.mockReset();
});

it("hosts live content in the existing profile with an isolated toolbar", async () => {
  const fixture = setup();
  const preview = fixture.create();
  await preview.initialize();
  expect(preview.webContents).toBe(fixture.page);
  expect(constructors.view).toHaveBeenCalledWith({
    webPreferences: expect.objectContaining({
      session: fixture.options.session,
      preload: "/page.cjs",
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
    }),
  });
  expect(constructors.window).toHaveBeenCalledWith(
    expect.objectContaining({
      maximizable: true,
      fullscreenable: true,
      webPreferences: expect.objectContaining({ contextIsolation: true, nodeIntegration: false }),
    }),
  );
  await fixture.action({ kind: "navigate", url: "https://example.com/<script>" });
  expect(fixture.onAction).toHaveBeenCalledWith({
    kind: "navigate",
    url: "https://example.com/<script>",
  });
  expect(fixture.window.loadURL.mock.calls[0]?.[0]).not.toContain("example.com");
});

it("rejects toolbar commands from page content, subframes and malformed payloads", () => {
  const fixture = setup();
  fixture.create();
  expect(() => fixture.action({ kind: "return" }, fixture.page)).toThrow(
    "Invalid preview window action",
  );
  expect(() => fixture.action({ kind: "return" }, fixture.chrome, {})).toThrow(
    "Invalid preview window action",
  );
  expect(() => fixture.action({ kind: "navigate", url: 42 })).toThrow(
    "Invalid preview window action",
  );
  expect(() => fixture.action({ kind: "execute", code: "anything" })).toThrow(
    "Invalid preview window action",
  );
  expect(fixture.onAction).not.toHaveBeenCalled();
});

it("resizes the live page in fill mode and honors explicit CSS viewport sizes", () => {
  const fixture = setup();
  const preview = fixture.create();
  fixture.resize();
  expect(fixture.view.setBounds).toHaveBeenLastCalledWith({
    x: 0,
    y: 52,
    width: 1440,
    height: 848,
  });
  preview.setViewport({ _tag: "freeform", width: 800, height: 600 });
  expect(fixture.view.setBounds).toHaveBeenLastCalledWith({
    x: 320,
    y: 176,
    width: 800,
    height: 600,
  });
  expect(preview.status()).toEqual({
    visible: true,
    viewportSetting: { _tag: "freeform", width: 800, height: 600 },
  });
});

it("fits a larger fixed viewport into a smaller window without clipping the page", () => {
  const fixture = setup();
  const preview = fixture.create();
  fixture.pageListeners.get("did-navigate")?.();
  preview.setViewport({ _tag: "freeform", width: 1440, height: 900 });
  fixture.resize([500, 400]);
  const bounds = fixture.view.setBounds.mock.lastCall?.[0];
  expect(bounds).toBeDefined();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(52);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(500);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(400);
  expect(fixture.page.enableDeviceEmulation).toHaveBeenLastCalledWith(
    expect.objectContaining({
      viewSize: { width: 1440, height: 900 },
      scale: expect.any(Number),
    }),
  );
  expect(preview.status().viewportSetting).toEqual({ _tag: "freeform", width: 1440, height: 900 });
  preview.setViewport({ _tag: "fill" });
  expect(fixture.page.disableDeviceEmulation).toHaveBeenCalled();
  expect(fixture.view.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 52, width: 500, height: 348 });
});

it("emulates the viewport only while the page has a renderer", () => {
  const fixture = setup();
  const preview = fixture.create();
  preview.setViewport({ _tag: "freeform", width: 800, height: 600 });
  preview.setViewport({ _tag: "fill" });
  preview.setViewport({ _tag: "freeform", width: 800, height: 600 });
  expect(fixture.view.setBounds).toHaveBeenLastCalledWith({
    x: 150,
    y: 106,
    width: 800,
    height: 600,
  });
  expect(fixture.page.enableDeviceEmulation).not.toHaveBeenCalled();
  expect(fixture.page.disableDeviceEmulation).not.toHaveBeenCalled();
  fixture.pageListeners.get("did-navigate")?.();
  expect(fixture.page.enableDeviceEmulation).toHaveBeenCalledOnce();
  fixture.pageListeners.get("render-process-gone")?.();
  fixture.resize();
  preview.setViewport({ _tag: "fill" });
  expect(fixture.page.enableDeviceEmulation).toHaveBeenCalledOnce();
  expect(fixture.page.disableDeviceEmulation).not.toHaveBeenCalled();
  fixture.pageListeners.get("did-navigate")?.();
  expect(fixture.page.disableDeviceEmulation).toHaveBeenCalledOnce();
});

it("reports a minimized page as hidden and restores it when focused", async () => {
  const fixture = setup();
  const preview = fixture.create();
  await preview.initialize();
  expect(fixture.options.onVisibilityChange).toHaveBeenLastCalledWith(true);
  fixture.minimize();
  expect(preview.status().visible).toBe(false);
  expect(fixture.options.onVisibilityChange).toHaveBeenLastCalledWith(false);
  preview.focus();
  expect(fixture.window.restore).toHaveBeenCalledOnce();
  expect(preview.status().visible).toBe(true);
  expect(fixture.options.onVisibilityChange).toHaveBeenLastCalledWith(true);
});

it("exits fullscreen with Escape from the live page or its toolbar", async () => {
  const fixture = setup();
  fixture.create();
  await fixture.action({ kind: "fullscreen" });
  expect(fixture.window.isFullScreen()).toBe(true);
  const preventDefault = vi.fn();
  fixture.pageListeners.get("before-input-event")?.(
    { preventDefault },
    { type: "keyDown", key: "Escape" },
  );
  expect(fixture.window.isFullScreen()).toBe(false);
  expect(preventDefault).toHaveBeenCalledOnce();
  await fixture.action({ kind: "fullscreen" });
  fixture.listeners.get("before-input-event")?.(
    { preventDefault },
    { type: "keyDown", key: "Escape" },
  );
  expect(fixture.window.isFullScreen()).toBe(false);
});

it("closes page resources exactly once and releases the toolbar handler", () => {
  const fixture = setup();
  const preview = fixture.create();
  preview.dispose();
  preview.dispose();
  expect(fixture.page.close).toHaveBeenCalledOnce();
  expect(fixture.page.close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
  expect(fixture.window.close).toHaveBeenCalledOnce();
  expect(fixture.action({ kind: "return" })).toBeUndefined();
  expect(fixture.options.onClosed).not.toHaveBeenCalled();
});

it("closes the new shell if live content creation fails", () => {
  const fixture = setup();
  constructors.view.mockImplementation(() => {
    throw new Error("Unable to create page");
  });
  expect(fixture.create).toThrow("Unable to create page");
  expect(fixture.window.close).toHaveBeenCalledOnce();
});

it("publishes navigation state as data rather than embedding page text into chrome", () => {
  const fixture = setup();
  const preview = fixture.create();
  preview.update({
    tabId: "tab",
    webContentsId: 84,
    navStatus: { kind: "Success", title: "<script>page</script>", url: "https://example.com/" },
    canGoBack: true,
    canGoForward: false,
    zoomFactor: 1,
    pictureInPicture: false,
    colorScheme: "system",
    audioMuted: false,
    audible: false,
    controller: "none",
    updatedAt: "2026-10-07T00:00:00Z",
  } satisfies DesktopPreviewTabState);
  expect(fixture.chrome.send).toHaveBeenCalledWith(expect.any(String), {
    url: "https://example.com/",
    canGoBack: true,
    canGoForward: false,
    fullscreen: false,
  });
});
