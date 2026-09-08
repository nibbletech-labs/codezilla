import { useMemo } from "react";
import { useAppStore, type HavenGraphEntry } from "../store/appStore";
import { bucketView, deriveView, tabCounts } from "../lib/havenGraph";
import type { HavenBuckets, HavenGraph, HavenTabCounts, HavenView } from "../lib/havenTypes";

/**
 * One derivation per read, shared by every consumer. Keyed on the graph object
 * itself: a new read produces a new object and therefore a fresh view, while
 * ten sidebar rows and the workbench looking at the same read all get the same
 * one. Never keyed on `revision` - edges do not bump it (section 2, 10.4).
 */
const views = new WeakMap<HavenGraph, HavenView>();

function viewOf(graph: HavenGraph): HavenView {
  const cached = views.get(graph);
  if (cached) return cached;
  const view = deriveView(graph);
  views.set(graph, view);
  return view;
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
    const view = viewOf(entry.graph);
    const buckets = bucketView(view, Date.now());
    return { entry, view, buckets, counts: tabCounts(buckets) };
  }, [entry]);
}

/**
 * The sidebar's live count. `null` - an unlinked project, or one whose first
 * read has not landed - renders as a dash.
 */
export function useHavenLiveCount(key: string | undefined): number | null {
  const graph = useAppStore((s) => (key ? s.havenGraphs[key]?.graph : undefined));
  return useMemo(
    () => (graph ? bucketView(viewOf(graph), Date.now()).live : null),
    [graph],
  );
}
