import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { FinishedBackgroundWorkEntry } from "./BackgroundWorkDrawer.logic";

vi.mock("~/state/orchestration", () => ({
  orchestrationEnvironment: { backgroundTaskOutput: () => null },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, error: null, refresh: () => undefined }),
}));
// Plain stand-ins for the banner primitives (the scroll area needs real DOM).
vi.mock("./ComposerBanner", () => {
  const passthrough = ({ children }: { readonly children?: ReactNode }) => <div>{children}</div>;
  return {
    ComposerBanner: {
      Scroll: passthrough,
      Children: passthrough,
      Row: passthrough,
      Icon: passthrough,
      Content: passthrough,
      Actions: passthrough,
    },
  };
});

const { BackgroundWorkDrawer } = await import("./BackgroundWorkDrawer");

const observers: Array<(entries: ReadonlyArray<{ isIntersecting: boolean }>) => void> = [];
const shown = { value: true };

class FakeIntersectionObserver {
  constructor(callback: (entries: ReadonlyArray<{ isIntersecting: boolean }>) => void) {
    observers.push(callback);
  }
  observe() {}
  disconnect() {}
}

const finished: ReadonlyArray<FinishedBackgroundWorkEntry> = [
  {
    taskId: "bdone0001",
    kind: "command",
    label: "npm test",
    childThreadId: undefined,
    kindLabel: "Command",
    command: undefined,
    startedAt: undefined,
    hasOutput: true,
    finishedAt: "2026-10-09T10:00:00.000Z",
    read: false,
  },
];

function render(onRead: () => void): ReactTestRenderer {
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(
      <BackgroundWorkDrawer
        environmentId={"env" as EnvironmentId}
        threadId={ThreadId.make("thread-1")}
        running={[]}
        finished={finished}
        onOpenThread={() => undefined}
        onRead={onRead}
      />,
      {
        createNodeMock: () => ({
          textContent: "",
          getBoundingClientRect: () => ({ width: 300, height: 40 }),
          checkVisibility: () => shown.value,
        }),
      },
    );
  });
  return renderer!;
}

describe("BackgroundWorkDrawer read marking", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    observers.length = 0;
    shown.value = true;
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not mark finished rows read just because the drawer mounted", () => {
    const onRead = vi.fn();
    const renderer = render(onRead);
    act(() => vi.advanceTimersByTime(5_000));
    expect(onRead).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it("does not mark rows read while they are hidden behind another notice", () => {
    const onRead = vi.fn();
    shown.value = false;
    const renderer = render(onRead);
    act(() => observers[0]?.([{ isIntersecting: true }]));
    act(() => vi.advanceTimersByTime(5_000));
    expect(onRead).not.toHaveBeenCalled();
    shown.value = true;
    act(() => vi.advanceTimersByTime(700));
    expect(onRead).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it("marks rows read once they have been on screen", () => {
    const onRead = vi.fn();
    const renderer = render(onRead);
    act(() => observers[0]?.([{ isIntersecting: true }]));
    act(() => vi.advanceTimersByTime(700));
    expect(onRead).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });
});
