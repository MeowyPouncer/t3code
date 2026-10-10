/**
 * Where the composer shows its Tasks list. A pending question or approval does
 * not hide it: the badge and the opened list dock above the question or
 * approval panel, which stays rendered and keeps its own focus.
 */
export interface ComposerTasksSurfaceInput {
  readonly hasTasks: boolean;
  readonly totalSteps: number;
  readonly drawerOpen: boolean;
  readonly hasBannerItems: boolean;
  readonly showComposerTopDrawer: boolean;
  readonly isComposerCollapsedMobile: boolean;
}

export interface ComposerTasksSurface {
  readonly inlineBadge: boolean;
  readonly tab: boolean;
  readonly drawer: boolean;
}

export function resolveComposerTasksSurface(
  input: ComposerTasksSurfaceInput,
): ComposerTasksSurface {
  const { hasTasks, drawerOpen, hasBannerItems, showComposerTopDrawer, isComposerCollapsedMobile } =
    input;
  return {
    inlineBadge:
      hasTasks &&
      !drawerOpen &&
      (hasBannerItems || showComposerTopDrawer || isComposerCollapsedMobile),
    tab:
      hasTasks &&
      input.totalSteps > 0 &&
      !drawerOpen &&
      !hasBannerItems &&
      !showComposerTopDrawer &&
      !isComposerCollapsedMobile,
    drawer: hasTasks && drawerOpen,
  };
}
