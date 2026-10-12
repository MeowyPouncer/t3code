// FORK (T3MIG-FORK-013): threads an agent opened with t3_thread_launch or
// create_threads sit under the thread that launched them, and every row says
// whose move it is. The server records the launcher as `launchedByThreadId`
// (older threads: read off their launch message), not as lineage, so subagent
// hiding, forks and mobile back navigation are untouched.
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { isLatestRunSettled } from "../session-logic";
import type { SidebarThreadSummary } from "../types";
import type { SidebarSection, SidebarThreadStatus } from "./Sidebar.logic";

type LaunchThread = Pick<
  SidebarThreadSummary,
  "environmentId" | "id" | "projectId" | "lineage" | "launchedByThreadId"
>;

export function sidebarLaunchThreadKey(
  thread: Pick<SidebarThreadSummary, "environmentId" | "id">,
): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

/**
 * Key of the thread a launched thread answers to: its launcher, or the
 * launcher's nearest ancestor when a provider subagent (hidden from the
 * sidebar) made the call. Null for threads a person made and for launchers
 * this client does not know (deleted, or not loaded yet).
 */
export function resolveSidebarLauncherKey(
  thread: LaunchThread,
  threadByKey: ReadonlyMap<string, LaunchThread>,
): string | null {
  const seen = new Set([sidebarLaunchThreadKey(thread)]);
  let launcherId = thread.launchedByThreadId ?? null;
  while (launcherId !== null) {
    const key = sidebarLaunchThreadKey({ environmentId: thread.environmentId, id: launcherId });
    if (seen.has(key)) return null;
    seen.add(key);
    const launcher = threadByKey.get(key);
    if (launcher === undefined) return null;
    if (launcher.lineage.relationshipToParent !== "subagent") return key;
    launcherId = launcher.lineage.parentThreadId;
  }
  return null;
}

// ── Grouping ────────────────────────────────────────────────────────

/** Where a thread sits on its own. The inbox and the Working shelf are one
    place here: a group moves between them as a whole. */
export type SidebarLaunchPlacement = "pinned" | "inbox" | "snoozed" | "shelved" | "settled";

export function sidebarLaunchPlacement(section: SidebarSection): SidebarLaunchPlacement {
  return section === "active" || section === "working" ? "inbox" : section;
}

/**
 * A launched thread nests only where it would sit anyway, or in the inbox
 * under a pinned parent. A pinned, snoozed or settled child keeps the place
 * the user gave it, and a live child never hides in a snoozed or settled
 * parent's shelf. FORK: a finished child goes on the Shelf with its parent,
 * since shelving settles the threads that worked for it.
 */
export function canNestSidebarLaunch(
  child: SidebarLaunchPlacement,
  parent: SidebarLaunchPlacement,
): boolean {
  return (
    child === parent ||
    (child === "inbox" && parent === "pinned") ||
    (child === "settled" && parent === "shelved")
  );
}

export interface SidebarLaunchForest {
  readonly parentKeyByChildKey: ReadonlyMap<string, string>;
  /** Children in launch order (oldest first), so writer 1 stays above writer 2. */
  readonly childKeysByParentKey: ReadonlyMap<string, readonly string[]>;
}

const EMPTY_FOREST: SidebarLaunchForest = {
  parentKeyByChildKey: new Map(),
  childKeysByParentKey: new Map(),
};

/**
 * Nest each visible launched thread under its visible launcher. Only the
 * threads the sidebar shows take part, so nesting keeps the project scope;
 * a child launched into another project than its launcher's stays where it is.
 */
export function buildSidebarLaunchForest<
  T extends LaunchThread & { readonly createdAt: string },
>(input: {
  readonly visible: readonly { readonly thread: T; readonly placement: SidebarLaunchPlacement }[];
  readonly threadByKey: ReadonlyMap<string, LaunchThread>;
}): SidebarLaunchForest {
  const visibleByKey = new Map(
    input.visible.map((entry) => [sidebarLaunchThreadKey(entry.thread), entry] as const),
  );
  const parentKeyByChildKey = new Map<string, string>();
  for (const entry of input.visible) {
    if (entry.thread.launchedByThreadId === undefined) continue;
    const parentKey = resolveSidebarLauncherKey(entry.thread, input.threadByKey);
    const parent = parentKey === null ? undefined : visibleByKey.get(parentKey);
    if (
      parentKey !== null &&
      parent !== undefined &&
      parent.thread.projectId === entry.thread.projectId &&
      canNestSidebarLaunch(entry.placement, parent.placement)
    ) {
      parentKeyByChildKey.set(sidebarLaunchThreadKey(entry.thread), parentKey);
    }
  }
  if (parentKeyByChildKey.size === 0) return EMPTY_FOREST;
  // A launch cycle cannot happen through the tools, but corrupt data must not
  // hide every thread in it: break each cycle at the thread that closes it.
  for (const childKey of [...parentKeyByChildKey.keys()]) {
    const seen = new Set([childKey]);
    let cursor = parentKeyByChildKey.get(childKey);
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        parentKeyByChildKey.delete(childKey);
        break;
      }
      seen.add(cursor);
      cursor = parentKeyByChildKey.get(cursor);
    }
  }
  const createdAtByKey = new Map(
    input.visible.map(
      (entry) =>
        [sidebarLaunchThreadKey(entry.thread), Date.parse(entry.thread.createdAt) || 0] as const,
    ),
  );
  const childKeysByParentKey = new Map<string, string[]>();
  for (const [childKey, parentKey] of parentKeyByChildKey) {
    const children = childKeysByParentKey.get(parentKey) ?? [];
    children.push(childKey);
    childKeysByParentKey.set(parentKey, children);
  }
  for (const children of childKeysByParentKey.values()) {
    children.sort(
      (left, right) =>
        (createdAtByKey.get(left) ?? 0) - (createdAtByKey.get(right) ?? 0) ||
        left.localeCompare(right),
    );
  }
  return { parentKeyByChildKey, childKeysByParentKey };
}

export function sidebarLaunchDescendantKeys(
  forest: SidebarLaunchForest,
  parentKey: string,
): string[] {
  const keys: string[] = [];
  const visit = (key: string) => {
    for (const childKey of forest.childKeysByParentKey.get(key) ?? []) {
      keys.push(childKey);
      visit(childKey);
    }
  };
  visit(parentKey);
  return keys;
}

export function sidebarLaunchAncestorKeys(
  forest: SidebarLaunchForest,
  key: string | null,
): ReadonlySet<string> {
  const ancestors = new Set<string>();
  let cursor = key === null ? undefined : forest.parentKeyByChildKey.get(key);
  while (cursor !== undefined && !ancestors.has(cursor)) {
    ancestors.add(cursor);
    cursor = forest.parentKeyByChildKey.get(cursor);
  }
  return ancestors;
}

export interface SidebarLaunchSections<T> {
  readonly pinned: readonly T[];
  readonly active: readonly T[];
  readonly working: readonly T[];
  readonly snoozed: readonly T[];
  readonly shelved: readonly T[];
  readonly settled: readonly T[];
}

const SIDEBAR_SECTIONS = ["pinned", "active", "working", "snoozed", "shelved", "settled"] as const;

/**
 * Take nested threads out of the sections, which then hold only the rows the
 * drag and drop list arranges; their children render under them. A group
 * whose root folded into the Working shelf comes back to the inbox while
 * anything in it waits for the user, the way that thread alone would.
 */
export function nestSidebarLaunchedThreads<
  T extends LaunchThread & { readonly createdAt: string },
>(input: {
  readonly sections: SidebarLaunchSections<T>;
  readonly threadByKey: ReadonlyMap<string, LaunchThread>;
  readonly holdsInbox: (thread: T) => boolean;
}): {
  readonly sections: SidebarLaunchSections<T>;
  readonly forest: SidebarLaunchForest;
  /** The section each nested thread sits in on its own, for its row's look and actions. */
  readonly nestedSectionByKey: ReadonlyMap<string, SidebarSection>;
  readonly nestedThreadByKey: ReadonlyMap<string, T>;
} {
  const entries = SIDEBAR_SECTIONS.flatMap((section) =>
    input.sections[section].map((thread) => ({
      thread,
      section,
      placement: sidebarLaunchPlacement(section),
    })),
  );
  const forest = buildSidebarLaunchForest({ visible: entries, threadByKey: input.threadByKey });
  if (forest.parentKeyByChildKey.size === 0) {
    return {
      sections: input.sections,
      forest,
      nestedSectionByKey: new Map(),
      nestedThreadByKey: new Map(),
    };
  }
  const entryByKey = new Map(
    entries.map((entry) => [sidebarLaunchThreadKey(entry.thread), entry] as const),
  );
  const nestedSectionByKey = new Map<string, SidebarSection>();
  const nestedThreadByKey = new Map<string, T>();
  for (const childKey of forest.parentKeyByChildKey.keys()) {
    const entry = entryByKey.get(childKey);
    if (entry === undefined) continue;
    nestedSectionByKey.set(childKey, entry.section);
    nestedThreadByKey.set(childKey, entry.thread);
  }
  const roots = (section: (typeof SIDEBAR_SECTIONS)[number]) =>
    input.sections[section].filter(
      (thread) => !forest.parentKeyByChildKey.has(sidebarLaunchThreadKey(thread)),
    );
  const active = roots("active");
  const working: T[] = [];
  for (const thread of roots("working")) {
    const holds = sidebarLaunchDescendantKeys(forest, sidebarLaunchThreadKey(thread)).some(
      (key) => {
        const child = nestedThreadByKey.get(key);
        return child !== undefined && input.holdsInbox(child);
      },
    );
    (holds ? active : working).push(thread);
  }
  return {
    sections: {
      pinned: roots("pinned"),
      active,
      working,
      snoozed: roots("snoozed"),
      shelved: roots("shelved"),
      settled: roots("settled"),
    },
    forest,
    nestedSectionByKey,
    nestedThreadByKey,
  };
}

// ── Collapsing ──────────────────────────────────────────────────────

/** Groups open by default so every row's state shows; collapsing one is remembered. */
export const SIDEBAR_LAUNCH_GROUPS_EXPANDED_BY_DEFAULT = true;
/** Remembered toggles beyond this many drop the oldest first. */
const SIDEBAR_LAUNCH_TOGGLE_LIMIT = 200;

/**
 * Collapse state stores only the groups the user toggled away from the
 * default, so flipping the default keeps every explicit choice.
 */
export function isSidebarLaunchGroupExpanded(input: {
  readonly parentKey: string;
  readonly toggledKeys: ReadonlySet<string>;
  readonly expandedByDefault: boolean;
}): boolean {
  return input.toggledKeys.has(input.parentKey)
    ? !input.expandedByDefault
    : input.expandedByDefault;
}

export function toggleSidebarLaunchGroup(
  toggledKeys: readonly string[],
  parentKey: string,
): string[] {
  if (toggledKeys.includes(parentKey)) return toggledKeys.filter((key) => key !== parentKey);
  return [...toggledKeys, parentKey].slice(-SIDEBAR_LAUNCH_TOGGLE_LIMIT);
}

/**
 * The rows under a group root in render order, depth-first. A collapsed
 * group still shows the open thread and the groups above it, the way the
 * collapsed shelves keep the open thread's row.
 */
export function flattenSidebarLaunchGroup(input: {
  readonly rootKey: string;
  readonly forest: SidebarLaunchForest;
  readonly isExpanded: (parentKey: string) => boolean;
  readonly routeThreadKey: string | null;
}): { readonly key: string; readonly depth: number }[] {
  const keep = new Set(sidebarLaunchAncestorKeys(input.forest, input.routeThreadKey));
  if (input.routeThreadKey !== null) keep.add(input.routeThreadKey);
  const rows: { key: string; depth: number }[] = [];
  const visit = (key: string, depth: number) => {
    const expanded = input.isExpanded(key);
    for (const childKey of input.forest.childKeysByParentKey.get(key) ?? []) {
      if (!expanded && !keep.has(childKey)) continue;
      rows.push({ key: childKey, depth });
      visit(childKey, depth + 1);
    }
  };
  visit(input.rootKey, 1);
  return rows;
}

// ── Whose move it is ────────────────────────────────────────────────

type InboxHoldInput = Pick<
  SidebarThreadSummary,
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "hasActionableProposedPlan"
  | "interactionMode"
  | "latestRun"
  | "runtime"
>;

export function hasSidebarPlanPrompt(thread: InboxHoldInput): boolean {
  return (
    !thread.hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    thread.hasActionableProposedPlan &&
    isLatestRunSettled(thread.latestRun, thread.runtime)
  );
}

/**
 * What keeps a group out of the Working shelf: a nested approval, question,
 * plan or failure stays in the inbox, the way the same thread on its own
 * would. A child that finished and waits on its orchestrator does not.
 */
export function sidebarThreadHoldsInbox(thread: InboxHoldInput): boolean {
  return (
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.runtime?.status === "failed" ||
    hasSidebarPlanPrompt(thread)
  );
}

/**
 * Today a never-opened thread counts as read, so switching sidebars does not
 * light up history. A launched thread is one nobody but its orchestrator has
 * opened, and that rule would hide the state of every writer, so for it a
 * completion counts as unread until someone opens it afterwards.
 */
export function isSidebarMoveUnread(input: {
  readonly isUnread: boolean;
  readonly isLaunched: boolean;
  readonly lastVisitedAt: string | null | undefined;
  readonly latestRun: Pick<NonNullable<SidebarThreadSummary["latestRun"]>, "completedAt"> | null;
}): boolean {
  if (input.isUnread) return true;
  return input.isLaunched && !input.lastVisitedAt && Boolean(input.latestRun?.completedAt);
}

export type SidebarMoveKind = "working" | "needs-you" | "with-orchestrator" | "done";
export type SidebarMoveReason =
  | "running"
  | "goal"
  | "background"
  | "approval"
  | "input"
  | "plan"
  | "finished"
  | "launcher-busy"
  | "launcher-finished"
  | "family";

export interface SidebarMoveState {
  readonly kind: SidebarMoveKind;
  readonly reason: SidebarMoveReason;
  readonly tooltip: string;
}

export const SIDEBAR_MOVE_LABEL: Record<SidebarMoveKind, string> = {
  working: "Working",
  "needs-you": "Needs you",
  "with-orchestrator": "With orchestrator",
  done: "Done",
};

export interface SidebarMoveLauncher {
  readonly title: string;
  readonly status: SidebarThreadStatus;
}

function launcherIsBusy(status: SidebarThreadStatus): boolean {
  return (
    status === "working" || status === "waiting" || status === "approval" || status === "input"
  );
}

/**
 * Whose move a row's pill names. The pill shows exactly when it shows today:
 * a stopped thread gets one only while its completion is unread (see
 * isSidebarMoveUnread for launched threads), and failed or limited threads
 * keep their own pills (null here).
 *
 * "Waiting" today means the run stopped while background work it started
 * (subagents, monitors) will wake it: still the thread's own move, so it
 * reads Working, and the tooltip says what it waits on.
 */
export function resolveSidebarMoveState(input: {
  readonly status: SidebarThreadStatus;
  readonly isUnread: boolean;
  readonly hasPlanPrompt: boolean;
  readonly goalActive: boolean;
  /** The thread that launched this one; null for top-level threads. */
  readonly launcher: SidebarMoveLauncher | null;
  /** Titles of the threads working for this one when that, not its own turn, keeps it working. */
  readonly workingFamily?: readonly string[];
}): SidebarMoveState | null {
  switch (input.status) {
    case "working":
      if (input.workingFamily !== undefined && input.workingFamily.length > 0) {
        return {
          kind: "working",
          reason: "family",
          tooltip: sidebarWorkingFamilyTooltip(input.workingFamily),
        };
      }
      return input.goalActive
        ? { kind: "working", reason: "goal", tooltip: "Working toward its /goal" }
        : { kind: "working", reason: "running", tooltip: "Running a turn" };
    case "waiting":
      return {
        kind: "working",
        reason: "background",
        tooltip: "Paused until its background work (subagents, monitors) wakes it",
      };
    case "approval":
      return { kind: "needs-you", reason: "approval", tooltip: "Waiting for your approval" };
    case "input":
      return { kind: "needs-you", reason: "input", tooltip: "Asked you a question" };
    case "failed":
    case "limited":
      return null;
    case "ready":
      break;
  }
  if (!input.isUnread) return null;
  if (input.hasPlanPrompt) {
    return { kind: "needs-you", reason: "plan", tooltip: "Proposed a plan for you to review" };
  }
  if (input.launcher === null) {
    return { kind: "needs-you", reason: "finished", tooltip: "Finished its turn" };
  }
  const launcherTitle = `«${input.launcher.title}»`;
  if (launcherIsBusy(input.launcher.status)) {
    return {
      kind: "with-orchestrator",
      reason: "launcher-busy",
      tooltip: `Finished its turn. ${launcherTitle} has the next step`,
    };
  }
  return {
    kind: "done",
    reason: "launcher-finished",
    tooltip:
      input.launcher.status === "failed" || input.launcher.status === "limited"
        ? `Finished its turn. ${launcherTitle} stopped too`
        : `Finished its turn. ${launcherTitle} has finished too`,
  };
}

/**
 * FORK: a thread whose own turn ended reads as working while threads working
 * for it (its subagents and the threads it launched) still do. Waiting on its
 * own background work turns into working too; a thread that needs the user,
 * failed or hit a limit keeps its own state.
 */
export function resolveSidebarFamilyStatus(
  status: SidebarThreadStatus,
  familyWorking: boolean,
): SidebarThreadStatus {
  return familyWorking && (status === "ready" || status === "waiting") ? "working" : status;
}

/** FORK: who a thread waits on while its own turn is over, for the pill's hover card. */
export function sidebarWorkingFamilyTooltip(titles: readonly string[]): string {
  const named = titles
    .slice(0, 3)
    .map((title) => `«${title}»`)
    .join(", ");
  const more = titles.length > 3 ? ` and ${titles.length - 3} more` : "";
  return `Its subagents and writers are working: ${named}${more}`;
}

// ── The parent row: child count and the most urgent child state ─────
export type SidebarLaunchGroupState = SidebarMoveKind | "failed";

const GROUP_STATE_PRIORITY: Record<SidebarLaunchGroupState, number> = {
  "needs-you": 4,
  failed: 3,
  working: 2,
  "with-orchestrator": 1,
  done: 0,
};

export const SIDEBAR_LAUNCH_GROUP_STATE_LABEL: Record<SidebarLaunchGroupState, string> = {
  ...SIDEBAR_MOVE_LABEL,
  failed: "Failed",
};

export interface SidebarLaunchGroupMember {
  readonly title: string;
  readonly status: SidebarThreadStatus;
  readonly isUnread: boolean;
  readonly hasPlanPrompt: boolean;
  readonly goalActive: boolean;
  readonly launcher: SidebarMoveLauncher | null;
}

/**
 * A nested thread's state for its parent's summary. Unlike the row pill it
 * does not fade once read: a finished child someone opened is still waiting
 * on its orchestrator. Only the plan prompt keeps the pill's timing, so a
 * plan the user already read does not keep lifting.
 */
export function resolveSidebarLaunchMemberState(member: SidebarLaunchGroupMember): {
  readonly state: SidebarLaunchGroupState | null;
  readonly move: SidebarMoveState | null;
} {
  if (member.status === "failed" || member.status === "limited") {
    return { state: "failed", move: null };
  }
  const move = resolveSidebarMoveState({
    ...member,
    isUnread: true,
    hasPlanPrompt: member.hasPlanPrompt && member.isUnread,
  });
  return { state: move?.kind ?? null, move };
}

export interface SidebarLaunchGroupSummary {
  readonly count: number;
  readonly mostUrgent: SidebarLaunchGroupState | null;
  readonly countByState: Readonly<Record<SidebarLaunchGroupState, number>>;
  /** Nested threads that need the user, in launch order, for the lifted pill. */
  readonly needsYou: readonly {
    readonly title: string;
    readonly move: SidebarMoveState;
  }[];
  readonly tooltip: string;
}

export function summarizeSidebarLaunchGroup(
  members: readonly SidebarLaunchGroupMember[],
): SidebarLaunchGroupSummary | null {
  if (members.length === 0) return null;
  const countByState: Record<SidebarLaunchGroupState, number> = {
    "needs-you": 0,
    failed: 0,
    working: 0,
    "with-orchestrator": 0,
    done: 0,
  };
  const needsYou: { title: string; move: SidebarMoveState }[] = [];
  let mostUrgent: SidebarLaunchGroupState | null = null;
  for (const member of members) {
    const { state, move } = resolveSidebarLaunchMemberState(member);
    if (state === null) continue;
    countByState[state] += 1;
    if (state === "needs-you" && move !== null) needsYou.push({ title: member.title, move });
    if (mostUrgent === null || GROUP_STATE_PRIORITY[state] > GROUP_STATE_PRIORITY[mostUrgent]) {
      mostUrgent = state;
    }
  }
  const parts = (Object.keys(GROUP_STATE_PRIORITY) as SidebarLaunchGroupState[])
    .toSorted((left, right) => GROUP_STATE_PRIORITY[right] - GROUP_STATE_PRIORITY[left])
    .filter((state) => countByState[state] > 0)
    .map(
      (state) => `${countByState[state]} ${SIDEBAR_LAUNCH_GROUP_STATE_LABEL[state].toLowerCase()}`,
    );
  const noun = members.length === 1 ? "launched thread" : "launched threads";
  return {
    count: members.length,
    mostUrgent,
    countByState,
    needsYou,
    tooltip: `${members.length} ${noun}${parts.length > 0 ? `: ${parts.join(", ")}` : ""}`,
  };
}

/**
 * A nested thread's "Needs you" lifts to its parent's row, so a collapsed
 * group, or a parent that is itself still working, cannot hide a question.
 */
export function liftSidebarMoveState(
  own: SidebarMoveState | null,
  group: SidebarLaunchGroupSummary | null,
): SidebarMoveState | null {
  const first = group?.needsYou[0];
  if (group == null || first === undefined) return own;
  const more = group.needsYou.length - 1;
  const childReason = `«${first.title}»: ${first.move.tooltip}${more > 0 ? ` (+${more} more)` : ""}`;
  if (own?.kind === "needs-you") {
    return { ...own, tooltip: `${own.tooltip}. Also ${childReason}` };
  }
  return { kind: "needs-you", reason: first.move.reason, tooltip: childReason };
}

/** Rows whose next step is another agent's recede like working rows; a lifted
    "Needs you" never recedes. */
export function resolveSidebarMoveRecede(input: {
  readonly move: SidebarMoveState | null;
  readonly recedeToday: boolean;
}): boolean {
  if (input.move?.kind === "needs-you") return false;
  if (input.move?.kind === "with-orchestrator") return true;
  return input.recedeToday;
}
