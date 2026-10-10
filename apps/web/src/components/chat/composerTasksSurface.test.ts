import { describe, expect, it } from "vite-plus/test";

import {
  resolveComposerTasksSurface,
  type ComposerTasksSurfaceInput,
} from "./composerTasksSurface";

const base: ComposerTasksSurfaceInput = {
  hasTasks: true,
  totalSteps: 3,
  drawerOpen: false,
  hasBannerItems: false,
  showComposerTopDrawer: false,
  hasBlockingComposerTopDrawer: false,
  isComposerCollapsedMobile: false,
};

describe("resolveComposerTasksSurface", () => {
  it("shows the shoulder tab on a plain composer", () => {
    expect(resolveComposerTasksSurface(base)).toEqual({
      inlineBadge: false,
      tab: true,
      drawer: false,
      sharesScrollBudget: false,
    });
  });

  it("keeps the badge visible while a question or approval is pending", () => {
    expect(resolveComposerTasksSurface({ ...base, showComposerTopDrawer: true })).toEqual({
      inlineBadge: true,
      tab: false,
      drawer: false,
      sharesScrollBudget: false,
    });
  });

  it("opens the list above a pending question without dropping it", () => {
    expect(
      resolveComposerTasksSurface({
        ...base,
        showComposerTopDrawer: true,
        hasBlockingComposerTopDrawer: true,
        drawerOpen: true,
      }),
    ).toEqual({ inlineBadge: false, tab: false, drawer: true, sharesScrollBudget: true });
  });

  it("shows nothing without a task list", () => {
    expect(
      resolveComposerTasksSurface({ ...base, hasTasks: false, showComposerTopDrawer: true }),
    ).toEqual({
      inlineBadge: false,
      tab: false,
      drawer: false,
      sharesScrollBudget: false,
    });
  });

  it("keeps the mobile collapsed composer badge", () => {
    expect(resolveComposerTasksSurface({ ...base, isComposerCollapsedMobile: true })).toEqual({
      inlineBadge: true,
      tab: false,
      drawer: false,
      sharesScrollBudget: false,
    });
  });

  it("keeps the whole height for the list when only a plan follow-up is shown", () => {
    expect(
      resolveComposerTasksSurface({ ...base, showComposerTopDrawer: true, drawerOpen: true }),
    ).toEqual({ inlineBadge: false, tab: false, drawer: true, sharesScrollBudget: false });
  });
});
