import { useMemo } from "react";
import { useAppStore, type HavenGraphEntry } from "../store/appStore";
import { bucketView, deriveView, tabCounts } from "../lib/havenGraph";
import type { HavenBuckets, HavenGraph, HavenTabCounts, HavenView } from "../lib/havenTypes";

interface Derived {
  view: HavenView;
  buckets: HavenBuckets;
  counts: HavenTabCounts;
}

/**
 * One derivation per read, shared by every consumer. Keyed on the graph object
 * itself: a new read produces a new object and therefore a fresh view, while
 * ten sidebar rows and the workbench looking at the same read all get the same
 * one. Never keyed on `revision` - edges do not bump it (section 2, 10.4).
 *
 * The buckets are cached alongside the view because they are not free either
 * (they walk every item) and because they must be computed once, at the read's
 * own clock, not once per hook.
 */
const derivations = new WeakMap<HavenGraph, Derived>();

/**
 * Done membership is fixed at read time by design (section 5): the fortnight
 * window is evaluated against the moment the graph was read and never
 * re-evaluated by a later render, so a day boundary crossing with no read in
 * between cannot silently empty the tab under the user. `Date.now()` is only
 * the fallback for a graph that somehow arrived without a read stamp - it is
 * never called inside a memo.
 */
function derivedOf(graph: HavenGraph, readAt: number | null | undefined): Derived {
  const cached = derivations.get(graph);
  if (cached) return cached;
  const view = deriveView(graph);
  const buckets = bucketView(view, readAt ?? Date.now());
  const derived: Derived = { view, buckets, counts: tabCounts(buckets) };
  derivations.set(graph, derived);
  return derived;
}

export interface HavenViewResult {
  entry: HavenGraphEntry;
  view: HavenView | null;
  buckets: HavenBuckets | null;
  counts: HavenTabCounts | null;
}

/** The derived workbench for one Haven project key, or null before its first read. */
export function useHavenView(key: string | undefined): HavenViewResult | null {
  const entry = useAppStore((s) => (key ? s.havenGraphs[key] : undefined));
  return useMemo(() => {
    if (!entry) return null;
    if (!entry.graph) return { entry, view: null, buckets: null, counts: null };
    const { view, buckets, counts } = derivedOf(entry.graph, entry.readAt);
    return { entry, view, buckets, counts };
  }, [entry]);
}

/**
 * The sidebar's live count. `null` - an unlinked project, or one whose first
 * read has not landed - renders as a dash. Subscribed to the graph and its read
 * stamp rather than the whole entry, so a spinner going up and down in the
 * workbench does not re-render every row in the sidebar.
 */
export function useHavenLiveCount(key: string | undefined): number | null {
  const graph = useAppStore((s) => (key ? s.havenGraphs[key]?.graph : undefined));
  const readAt = useAppStore((s) => (key ? s.havenGraphs[key]?.readAt : undefined));
  return useMemo(
    () => (graph ? derivedOf(graph, readAt).buckets.live : null),
    [graph, readAt],
  );
}
