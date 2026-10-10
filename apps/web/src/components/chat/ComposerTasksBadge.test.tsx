import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerTasksBadge, ComposerTasksDrawer } from "./ComposerTasksBadge";

const steps = [
  { step: "Read", status: "completed" },
  { step: "Write", status: "inProgress" },
] as const;
const progress = { step: "Write", completedSteps: 1, totalSteps: 2 };

describe("ComposerTasksBadge", () => {
  it.each(["inline", "tab"] as const)(
    "marks the %s badge as a collapsed-composer control, so focus does not expand the composer",
    (placement) => {
      const markup = renderToStaticMarkup(
        <ComposerTasksBadge
          expanded={false}
          onToggle={() => {}}
          placement={placement}
          progress={progress}
          steps={steps}
        />,
      );
      const button = markup.match(/<button[^>]*data-composer-tasks-badge="true"[^>]*>/)?.[0];
      expect(button).toContain('data-chat-composer-collapsed-controls="true"');
    },
  );

  it("keeps the collapse control in the header, outside the scrolling list", () => {
    const markup = renderToStaticMarkup(
      <ComposerTasksDrawer onCollapse={() => {}} progress={progress} steps={steps} />,
    );
    expect(markup.indexOf("data-composer-tasks-badge")).toBeLessThan(
      markup.indexOf("data-composer-tasks-scroll"),
    );
  });
});
