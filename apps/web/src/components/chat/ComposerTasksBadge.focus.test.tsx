// @vitest-environment jsdom

import { RuntimeRequestId } from "@t3tools/contracts";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { PendingUserInput } from "../../session-logic";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { ComposerTasksBadge } from "./ComposerTasksBadge";
import { isInsideCollapsedComposerControls } from "./composerEventScope";

const prompt: PendingUserInput = {
  requestId: RuntimeRequestId.make("request-1"),
  responseCapability: "live" as const,
  createdAt: "2026-10-10T00:00:00.000Z",
  questions: [
    {
      id: "question-1",
      header: "Approach",
      question: "Which approach should the migration take?",
      options: [{ label: "Incremental", description: "One module at a time" }],
      multiSelect: false,
    },
  ],
  dismissible: true,
};
const steps = [
  { step: "Read", status: "completed" },
  { step: "Write", status: "inProgress" },
] as const;
const progress = { step: "Write", completedSteps: 1, totalSteps: 2 };

// ChatComposer expands a collapsed composer on focus unless the target is a
// collapsed-composer control (its form's onFocusCapture); an expansion
// remounts the pending question, which resets its disclosure state. This
// mounts the real badge and question beside that same rule.
function CollapsedComposerWithQuestion() {
  const [expanded, setExpanded] = useState(false);
  return (
    <form
      data-expanded={expanded ? "true" : "false"}
      onFocusCapture={(event) => {
        if (isInsideCollapsedComposerControls(event.target)) return;
        setExpanded(true);
      }}
    >
      <ComposerBanner.Root>
        <ComposerTasksBadge
          expanded={false}
          onToggle={() => {}}
          placement="inline"
          progress={progress}
          steps={steps}
        />
      </ComposerBanner.Root>
      <div key={expanded ? "expanded" : "collapsed"} data-chat-composer-collapsed-controls="true">
        <ComposerPendingUserInputPanel
          pendingUserInputs={[prompt]}
          respondingRequestIds={[]}
          answers={{}}
          questionIndex={0}
          onToggleOption={() => {}}
          onAdvance={() => {}}
          onDismiss={() => {}}
        />
      </div>
      <textarea data-testid="editor" />
    </form>
  );
}

let root: Root;
let container: HTMLDivElement;

function query(selector: string): HTMLElement {
  const element = container.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`missing ${selector}`);
  return element;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() => root.render(<CollapsedComposerWithQuestion />));
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("Tasks badge focus beside a pending question", () => {
  it("keeps the composer collapsed and the question's disclosure state when the badge is focused", async () => {
    await act(async () => query("[data-pending-user-input-toggle]").click());
    expect(query("[data-pending-user-input-toggle]").dataset.pendingUserInputToggle).toBe(
      "collapsed",
    );

    await act(async () => query("[data-composer-tasks-badge]").focus());

    expect(document.activeElement).toBe(query("[data-composer-tasks-badge]"));
    expect(query("form").dataset.expanded).toBe("false");
    expect(query("[data-pending-user-input-toggle]").dataset.pendingUserInputToggle).toBe(
      "collapsed",
    );
  });

  it("still expands, and so remounts the question, when another control takes focus", async () => {
    await act(async () => query("[data-pending-user-input-toggle]").click());
    await act(async () => query('[data-testid="editor"]').focus());

    expect(query("form").dataset.expanded).toBe("true");
    expect(query("[data-pending-user-input-toggle]").dataset.pendingUserInputToggle).toBe(
      "expanded",
    );
  });
});
