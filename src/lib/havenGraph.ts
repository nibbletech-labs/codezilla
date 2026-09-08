/**
 * The whole workbench derived from one graph read (spec §5, §7).
 *
 * `deriveView` is the app's copy of `derive-view.py`
 * (`src-tauri/tests/fixtures/haven/derive-view.py`): applied to the raw capture
 * it must reproduce the derived fixture exactly, which is what
 * `tests/haven-graph.test.ts` asserts. `bucketView` applies the mockup's tab
 * predicates. Both are pure — `now` is a parameter, never `Date.now()` — so
 * every count in this file is a deterministic function of its inputs.
 */

import type {
  HavenBuckets,
  HavenDep,
  HavenGraphLike,
  HavenItem,
  HavenParent,
  HavenTabCounts,
  HavenView,
} from "./havenTypes";

const WHY_MAX = 220;
const DLL_MAX = 230;
const FORTNIGHT_MS = 14 * 864e5;
/** Statuses that mean "finished with", for buckets and cleared blockers. */
const DEAD: ReadonlySet<string> = new Set(["done", "archived", "superseded"]);

/**
 * The numeric half of a ref (`RS-160` -> 160), used only to break ties between
 * parents of the same kind. A ref that doesn't end in a number sorts last
 * rather than throwing — `derive-view.py` would raise here.
 */
function refNum(ref: string): number {
  const dash = ref.lastIndexOf("-");
  const n = dash < 0 ? NaN : Number(ref.slice(dash + 1));
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/**
 * Haven stores naive `YYYY-MM-DD HH:MM:SS` strings. Read as UTC, matching the
 * mockup; returns null for anything unparseable so callers decide what a
 * missing timestamp means.
 */
export function parseHavenTimestamp(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const ms = Date.parse(String(ts).replace(" ", "T") + "Z");
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Project the raw graph into the shape the workbench renders.
 *
 * Note on truncation: JS `.slice(0, 220)` counts UTF-16 units where Python's
 * `[:220]` counts code points. They agree on this capture (it holds no astral
 * characters) but could differ on a future one containing emoji.
 */
export function deriveView(graph: HavenGraphLike): HavenView {
  const rawNodes = (graph.nodes ?? []).filter((n) => !!n?.ref);
  const rawEdges = graph.edges ?? [];

  const nodeByRef = new Map(rawNodes.map((n) => [n.ref as string, n]));
  const parents = new Map<string, HavenParent[]>();
  const deps: HavenDep[] = [];
  const dependsOn = new Map<string, string[]>();
  const requiredBy = new Map<string, string[]>();

  for (const e of rawEdges) {
    const from = e?.from;
    const to = e?.to;
    if (!from || !to || !e.kind) continue;
    if (e.kind === "decomposition" || e.kind === "grouping") {
      const list = parents.get(to);
      if (list) list.push({ ref: from, kind: e.kind });
      else parents.set(to, [{ ref: from, kind: e.kind }]);
    } else if (e.kind === "dependency") {
      deps.push({ src: from, dst: to });
      const on = dependsOn.get(from);
      if (on) on.push(to);
      else dependsOn.set(from, [to]);
      const by = requiredBy.get(to);
      if (by) by.push(from);
      else requiredBy.set(to, [from]);
    }
  }

  // §7: decomposition beats grouping, the lowest ref number breaks ties.
  // Sorts a copy so each item's own `parents` keeps Haven's edge order.
  const pick = (ref: string): string | null => {
    const ps = parents.get(ref);
    if (!ps || ps.length === 0) return null;
    if (ps.length === 1) return ps[0].ref;
    const sorted = [...ps].sort((a, b) => {
      const kindDelta =
        (a.kind === "decomposition" ? 0 : 1) - (b.kind === "decomposition" ? 0 : 1);
      return kindDelta !== 0 ? kindDelta : refNum(a.ref) - refNum(b.ref);
    });
    return sorted[0].ref;
  };

  // Walk up the primary chain; the visited set is what stops a cycle.
  const rootOf = (ref: string): string => {
    const seen = new Set([ref]);
    let cur = ref;
    for (;;) {
      const next = pick(cur);
      if (next === null || seen.has(next)) return cur;
      seen.add(next);
      cur = next;
    }
  };

  const items: HavenItem[] = rawNodes.map((n) => {
    const ref = n.ref as string;
    const root = rootOf(ref);
    const isTop = root === ref;
    return {
      ref,
      title: n.title ?? null,
      status: n.status ?? null,
      type: n.type ?? null,
      priority: n.priority ?? null,
      owner: n.owner_kind ?? null,
      wait: n.wait_state ?? null,
      upd: n.updated_at ?? null,
      committed: n.committed ?? null,
      root: isTop ? null : root,
      rt: isTop ? null : (nodeByRef.get(root)?.title ?? null),
      parents: parents.get(ref) ?? [],
      why: (n.why ?? "").slice(0, WHY_MAX),
      dll: (n.done_looks_like ?? "").slice(0, DLL_MAX),
    };
  });

  const firstRef = rawNodes[0]?.ref ?? null;
  let prefix: string | null = null;
  if (firstRef) {
    const dash = firstRef.lastIndexOf("-");
    prefix = dash < 0 ? firstRef : firstRef.slice(0, dash);
  }

  return {
    items,
    deps,
    project: graph.project ?? null,
    prefix,
    byRef: new Map(items.map((i) => [i.ref, i])),
    dependsOn,
    requiredBy,
  };
}

/**
 * The tracked dependencies of `ref` that are not finished. A dependency
 * pointing at a node outside the graph counts as unmet — the honest reading
 * when we cannot see its status.
 */
export function unmetBlockers(view: HavenView, ref: string): string[] {
  return (view.dependsOn.get(ref) ?? []).filter((target) => {
    const item = view.byRef.get(target);
    return !item || !DEAD.has(String(item.status));
  });
}

const onYou = (i: HavenItem) => i.owner === "human" || i.wait === "on_human";

/**
 * The §5 tabs. Every rule uses only fields Haven stores, and `now` is injected
 * so the Done fortnight is testable. No sorting happens here — CZ-47 orders.
 */
export function bucketView(view: HavenView, nowMs: number): HavenBuckets {
  const moving: HavenItem[] = [];
  const you: HavenItem[] = [];
  const stuck: HavenItem[] = [];
  const cantGo: HavenItem[] = [];
  const ready: HavenItem[] = [];
  const needsDef: HavenItem[] = [];
  const done: HavenItem[] = [];

  for (const i of view.items) {
    const mine = onYou(i);
    if (mine) {
      // "On you", any live status — never finished work.
      if (!DEAD.has(String(i.status))) you.push(i);
    } else if (i.status === "in_progress") {
      moving.push(i);
    } else if (i.status === "blocked") {
      // Picked up and hit a wall, versus parked before anyone started.
      if (i.owner) stuck.push(i);
      else cantGo.push(i);
    } else if (i.committed && i.status === "ready") {
      ready.push(i);
    } else if (i.committed && (i.status === "discovery" || i.status === "definition")) {
      needsDef.push(i);
    }
    // Done is independent of on-you: a completed item leaves every live tab.
    if (i.status === "done") {
      const upd = parseHavenTimestamp(i.upd);
      if (upd !== null && nowMs - upd <= FORTNIGHT_MS) done.push(i);
    }
  }

  return {
    moving,
    you,
    stuck,
    cantGo,
    ready,
    needsDef,
    done,
    live: moving.length + you.length + stuck.length,
  };
}

/** The four tab badges. */
export function tabCounts(b: HavenBuckets): HavenTabCounts {
  return {
    inFlight: b.live,
    blocked: b.cantGo.length,
    backlog: b.ready.length + b.needsDef.length,
    done: b.done.length,
  };
}
