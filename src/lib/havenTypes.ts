/**
 * The shapes that cross the Haven IPC boundary, and the derived view built from
 * them. Pure types and nothing else — no Tauri import — so `havenGraph.ts` and
 * its node tests can use them without pulling the webview API into the test.
 */

/**
 * One node of `haven graph --full --all`. Mirrors the Rust `HavenNode`, which
 * carries exactly what the workbench reads plus `revision` and `public_id` for
 * CZ-48's writes — `body`, `created_at` and `archived_at` are deliberately not
 * part of the payload.
 */
export interface HavenNode {
  ref: string;
  title: string | null;
  type: string | null;
  status: string | null;
  priority: number | null;
  committed: boolean | null;
  owner_kind: string | null;
  wait_state: string | null;
  why: string | null;
  done_looks_like: string | null;
  updated_at: string | null;
  revision: number | null;
  public_id: string | null;
}

export interface HavenEdge {
  from: string | null;
  kind: string | null;
  to: string | null;
}

export interface HavenGraph {
  nodes: HavenNode[];
  edges: HavenEdge[];
  node_total: number | null;
  edge_total: number | null;
  truncated: boolean | null;
  project: string | null;
}

/**
 * What `deriveView` accepts. Looser than `HavenGraph` so the same function also
 * digests raw CLI JSON, where a null field is simply an absent key (§2).
 */
export interface HavenNodeLike {
  ref?: string | null;
  title?: string | null;
  type?: string | null;
  status?: string | null;
  priority?: number | null;
  committed?: boolean | null;
  owner_kind?: string | null;
  wait_state?: string | null;
  why?: string | null;
  done_looks_like?: string | null;
  updated_at?: string | null;
  revision?: number | null;
  public_id?: string | null;
}

export interface HavenEdgeLike {
  from?: string | null;
  kind?: string | null;
  to?: string | null;
}

export interface HavenGraphLike {
  nodes?: HavenNodeLike[] | null;
  edges?: HavenEdgeLike[] | null;
  project?: string | null;
}

/** A direct parent of an item, with the edge kind that made it one. */
export interface HavenParent {
  ref: string;
  kind: string;
}

/**
 * One row of the workbench. Exactly the fourteen fields `derive-view.py`
 * writes — the maps live on the view, never on the item.
 */
export interface HavenItem {
  ref: string;
  title: string | null;
  status: string | null;
  type: string | null;
  priority: number | null;
  owner: string | null;
  wait: string | null;
  upd: string | null;
  committed: boolean | null;
  /** The primary epic (§7), or null when the item is itself top-level. */
  root: string | null;
  /** The primary epic's title; null when it has none or isn't in the graph. */
  rt: string | null;
  parents: HavenParent[];
  why: string;
  dll: string;
}

/** `src` depends on `dst`. */
export interface HavenDep {
  src: string;
  dst: string;
}

export interface HavenView {
  items: HavenItem[];
  deps: HavenDep[];
  project: string | null;
  prefix: string | null;
  byRef: Map<string, HavenItem>;
  /** ref -> the refs it depends on. */
  dependsOn: Map<string, string[]>;
  /** ref -> the refs that depend on it. */
  requiredBy: Map<string, string[]>;
}

export interface HavenBuckets {
  moving: HavenItem[];
  you: HavenItem[];
  stuck: HavenItem[];
  cantGo: HavenItem[];
  ready: HavenItem[];
  needsDef: HavenItem[];
  done: HavenItem[];
  /** The sidebar's `N live`: in progress + on you + stuck. */
  live: number;
}

export interface HavenTabCounts {
  inFlight: number;
  blocked: number;
  backlog: number;
  done: number;
}
