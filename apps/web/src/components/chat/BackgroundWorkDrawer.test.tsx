import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { act, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  BackgroundWorkEntry,
  FinishedBackgroundWorkEntry,
} from "./BackgroundWorkDrawer.logic";

vi.mock("~/state/orchestration", () => ({
  orchestrationEnvironment: { backgroundTaskOutput: () => null },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, error: null, refresh: () => undefined }),
}));
// Plain stand-ins for the banner primitives (the scroll area needs real DOM);
// they keep props and refs, so a row's title line can be observed.
vi.mock("./ComposerBanner", async () => {
  const { cloneElement } = await import("react");
  const part = ({
    children,
    render,
    ...props
  }: {
    readonly children?: ReactNode;
    readonly render?: ReactElement;
  }) => cloneElement(render ?? <div />, props, children);
  return {
    ComposerBanner: {
      Scroll: part,
      Children: part,
      Row: part,
      Icon: part,
      Content: part,
      Actions: part,
    },
  };
});

const { BackgroundWorkDrawer } = await import("./BackgroundWorkDrawer");

interface ObservedNode {
  readonly taskId: string | undefined;
}
interface FakeObserver {
  readonly callback: (
    entries: ReadonlyArray<{ isIntersecting: boolean; intersectionRatio: number }>,
  ) => void;
  readonly nodes: Array<ObservedNode>;
  disconnected: boolean;
}

const observers: Array<FakeObserver> = [];
/** Per task id: whether its title line is shown (laid out, visible, opaque). */
const shown = new Map<string, boolean>();

class FakeIntersectionObserver {
  private readonly record: FakeObserver;
  constructor(callback: FakeObserver["callback"]) {
    this.record = { callback, nodes: [], disconnected: false };
    observers.push(this.record);
  }
  observe(node: ObservedNode) {
    this.record.nodes.push(node);
  }
  disconnect() {
    this.record.disconnected = true;
  }
}

function liveObservers(): ReadonlyArray<FakeObserver> {
  return observers.filter((observer) => !observer.disconnected);
}

/** Reports how much of a row's title line is in view. */
function intersect(taskId: string, ratio: number) {
  const observer = liveObservers().find((candidate) =>
    candidate.nodes.some((node) => node.taskId === taskId),
  );
  expect(observer, `an observer for ${taskId}`).toBeDefined();
  act(() => observer?.callback([{ isIntersecting: ratio > 0, intersectionRatio: ratio }]));
}

function finishedEntry(taskId: string, read = false): FinishedBackgroundWorkEntry {
  return {
    taskId,
    kind: "command",
    label: `npm test ${taskId}`,
    childThreadId: undefined,
    kindLabel: "Command",
    command: undefined,
    startedAt: undefined,
    hasOutput: true,
    finishedAt: "2026-10-09T10:00:00.000Z",
    read,
  };
}

const running: ReadonlyArray<BackgroundWorkEntry> = [
  {
    taskId: "brun00001",
    kind: "command",
    label: "npm run dev",
    childThreadId: undefined,
    kindLabel: "Command",
    command: undefined,
    startedAt: undefined,
    hasOutput: true,
  },
];

function drawer(input: {
  readonly threadId?: string;
  readonly running?: ReadonlyArray<BackgroundWorkEntry>;
  readonly finished: ReadonlyArray<FinishedBackgroundWorkEntry>;
  readonly onRead: (taskId: string) => void;
}) {
  return (
    <BackgroundWorkDrawer
      environmentId={"env" as EnvironmentId}
      threadId={ThreadId.make(input.threadId ?? "thread-1")}
      running={input.running ?? []}
      finished={input.finished}
      onOpenThread={() => undefined}
      onRead={input.onRead}
    />
  );
}

function render(element: ReactElement): ReactTestRenderer {
  let renderer: ReactTestRenderer | undefined;
  act(() => {
    renderer = create(element, {
      createNodeMock: (node) => {
        const taskId = (node.props as Record<string, unknown>)["data-background-work-title"];
        const id = typeof taskId === "string" ? taskId : undefined;
        return {
          taskId: id,
          textContent: "",
          getBoundingClientRect: () => ({ width: 300, height: 24 }),
          checkVisibility: () => (id === undefined ? true : (shown.get(id) ?? true)),
        };
      },
    });
  });
  return renderer!;
}

describe("BackgroundWorkDrawer read marking", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    observers.length = 0;
    shown.clear();
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not mark finished rows read just because the drawer mounted", () => {
    const onRead = vi.fn();
    const renderer = render(drawer({ finished: [finishedEntry("bdone0001")], onRead }));
    act(() => vi.advanceTimersByTime(5_000));
    expect(onRead).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it("does not mark a row read while it is hidden behind another notice", () => {
    const onRead = vi.fn();
    shown.set("bdone0001", false);
    const renderer = render(drawer({ finished: [finishedEntry("bdone0001")], onRead }));
    intersect("bdone0001", 1);
    act(() => vi.advanceTimersByTime(5_000));
    expect(onRead).not.toHaveBeenCalled();
    shown.set("bdone0001", true);
    act(() => vi.advanceTimersByTime(700));
    expect(onRead).toHaveBeenCalledExactlyOnceWith("bdone0001");
    act(() => renderer.unmount());
  });

  it("marks a row read once it has been on screen", () => {
    const onRead = vi.fn();
    const renderer = render(drawer({ finished: [finishedEntry("bdone0001")], onRead }));
    intersect("bdone0001", 1);
    act(() => vi.advanceTimersByTime(700));
    expect(onRead).toHaveBeenCalledExactlyOnceWith("bdone0001");
    act(() => renderer.unmount());
  });

  it("marks only the finished rows that were on screen themselves", () => {
    const onRead = vi.fn();
    const renderer = render(
      drawer({
        running,
        finished: [
          finishedEntry("bdone0001"),
          finishedEntry("bdone0002"),
          finishedEntry("bold0001", true),
        ],
        onRead,
      }),
    );
    // Running rows and rows already read are not watched at all.
    const watched = liveObservers().flatMap((observer) =>
      observer.nodes.map((node) => node.taskId),
    );
    expect(watched.toSorted()).toEqual(["bdone0001", "bdone0002"]);
    // The first finished row is in view; the second is clipped by the scroll area.
    intersect("bdone0001", 1);
    intersect("bdone0002", 0);
    act(() => vi.advanceTimersByTime(5_000));
    expect(onRead).toHaveBeenCalledExactlyOnceWith("bdone0001");
    // A sliver of the second row is not enough; half of its title line is.
    intersect("bdone0002", 0.2);
    act(() => vi.advanceTimersByTime(5_000));
    expect(onRead).toHaveBeenCalledTimes(1);
    intersect("bdone0002", 0.6);
    act(() => vi.advanceTimersByTime(700));
    expect(onRead).toHaveBeenLastCalledWith("bdone0002");
    expect(onRead).toHaveBeenCalledTimes(2);
    act(() => renderer.unmount());
  });

  it("leaves no observer or timer behind when the thread switches or the drawer closes", () => {
    const onRead = vi.fn();
    const renderer = render(drawer({ finished: [finishedEntry("bdone0001")], onRead }));
    intersect("bdone0001", 1);
    expect(vi.getTimerCount()).toBe(1);
    act(() =>
      renderer.update(
        drawer({ threadId: "thread-2", finished: [finishedEntry("bdone0009")], onRead }),
      ),
    );
    expect(
      observers
        .filter((observer) => observer.nodes.some((node) => node.taskId === "bdone0001"))
        .every((observer) => observer.disconnected),
    ).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    intersect("bdone0009", 1);
    act(() => renderer.unmount());
    expect(liveObservers()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(5_000));
    expect(onRead).not.toHaveBeenCalled();
  });
});
