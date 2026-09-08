/**
 * Where the workbench is looking: the tab, the selection, the trail you walked
 * in on, the filter and which epic groups are collapsed (spec §9).
 *
 * A pure reducer, so StrictMode's double-invoke is harmless and every clause of
 * the navigation acceptance is provable in node. `NavCtx` supplies the three
 * graph questions the reducer needs — which tab lists a ref, whether the read
 * holds it at all, and which epic group in which Backlog zone it sits in — so
 * this file never touches the view.
 */

import type { BacklogZone } from "./havenWorkbench.ts";

export type NavTab = "flight" | "blocked" | "backlog" | "done" | "linked";

export interface NavState {
  tab: NavTab;
  /** The ref the Linked-item view is showing; null on every real tab. */
  linkedRef: string | null;
  /** The selected ref — what the detail column shows. */
  current: string | null;
  /** The ref you arrived from, marked with a dashed pill so the path shows. */
  cameFrom: string | null;
  /** Refs walked in, most recent last. */
  trail: string[];
  /** Bumped by every jump; the scroll-into-view effect keys on it. */
  scrollNonce: number;
  query: string;
  /** Collapsed epic groups, keyed `<zone>:<root|_none>`. */
  collapsed: Set<string>;
}

export type NavAction =
  | { type: "showTab"; tab: Exclude<NavTab, "linked"> }
  | { type: "setQuery"; query: string }
  | { type: "toggleGroup"; zone: BacklogZone; root: string | null }
  | { type: "resetGroups" }
  | { type: "select"; ref: string }
  | { type: "goTo"; ref: string }
  | { type: "back" }
  | { type: "close" };

export interface NavCtx {
  /** The tab that lists `ref`, or null when no tab does. Never "linked". */
  tabOf(ref: string): NavTab | null;
  /** Whether the current read holds `ref` at all. */
  has(ref: string): boolean;
  /** The ref's primary epic, or null when it is top-level. */
  rootOf(ref: string): string | null;
  /** Which Backlog zone lists the ref, or null when neither does. */
  zoneOf(ref: string): BacklogZone | null;
}

/**
 * Epic groups collapse per zone: six roots appear in both Ready and Needs
 * definition on the fixture, and the mockup collapses one `.gsec` element, not
 * an epic across the tab.
 */
export function groupKey(zone: BacklogZone, root: string | null): string {
  return `${zone}:${root ?? "_none"}`;
}

export function initialNav(): NavState {
  return {
    tab: "flight",
    linkedRef: null,
    current: null,
    cameFrom: null,
    trail: [],
    scrollNonce: 0,
    query: "",
    collapsed: new Set(),
  };
}

/**
 * Land a jump somewhere visible: switch to whichever tab holds the target (or
 * the Linked-item view), clear the filter, and expand the group the target sits
 * in. The mockup re-applies the filter after switching, which leaves a
 * filtered-out or collapsed target hidden; that behaviour is not kept.
 */
function reveal(state: NavState, ref: string, ctx: NavCtx): NavState {
  const tab = ctx.tabOf(ref);
  let next: NavState;
  if (tab) {
    next = { ...state, tab, linkedRef: null };
  } else if (ctx.has(ref)) {
    // Linked work no tab lists — completed long ago, archived, or in the icebox.
    next = { ...state, tab: "linked", linkedRef: ref };
  } else {
    // Not in this read at all: the column says so, the tab does not move.
    next = { ...state };
  }
  const zone = ctx.zoneOf(ref);
  let collapsed = next.collapsed;
  if (zone) {
    const key = groupKey(zone, ctx.rootOf(ref));
    if (collapsed.has(key)) {
      collapsed = new Set(collapsed);
      collapsed.delete(key);
    }
  }
  return {
    ...next,
    collapsed,
    query: "",
    current: ref,
    scrollNonce: next.scrollNonce + 1,
  };
}

export function navReduce(state: NavState, action: NavAction, ctx: NavCtx): NavState {
  switch (action.type) {
    case "showTab":
      // The mockup rebuilds the tab body, which reopens every group.
      return { ...state, tab: action.tab, linkedRef: null, collapsed: new Set() };

    case "setQuery":
      return { ...state, query: action.query };

    case "toggleGroup": {
      const key = groupKey(action.zone, action.root);
      const collapsed = new Set(state.collapsed);
      if (collapsed.has(key)) collapsed.delete(key);
      else collapsed.add(key);
      return { ...state, collapsed };
    }

    case "resetGroups":
      return { ...state, collapsed: new Set() };

    case "select":
      // A direct click: no tab change, no scroll, and the filter and the
      // collapsed groups are the user's own — leave them alone.
      return { ...state, current: action.ref, cameFrom: null, trail: [] };

    case "goTo": {
      const trail =
        state.current && state.current !== action.ref
          ? [...state.trail, state.current]
          : state.trail;
      return { ...reveal(state, action.ref, ctx), trail, cameFrom: state.current };
    }

    case "back": {
      if (state.trail.length === 0) return state;
      const trail = state.trail.slice(0, -1);
      const prev = state.trail[state.trail.length - 1];
      return { ...reveal(state, prev, ctx), trail, cameFrom: null };
    }

    case "close":
      return { ...state, current: null, cameFrom: null, trail: [] };

    default:
      return state;
  }
}
