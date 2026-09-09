import { invoke } from "@tauri-apps/api/core";

/** One entry of `haven project list`. Field names mirror the Rust struct. */
export interface HavenProject {
  key: string;
  ref_prefix: string | null;
  title: string | null;
  status: string | null;
}

/** The installed Haven version, or null when the CLI isn't there. */
export function havenDetect(): Promise<string | null> {
  return invoke("haven_detect");
}

export function havenListProjects(): Promise<HavenProject[]> {
  return invoke("haven_list_projects");
}

/**
 * The Haven project this repo is bound to, read from the nearest
 * `.haven-project` walking up from `path`. `null` means checked and unbound; a
 * rejection means the path could not be resolved at all, which is not the same
 * thing — the caller keeps whatever it last knew.
 */
export function havenRepoBinding(path: string): Promise<string | null> {
  return invoke("haven_repo_binding", { path });
}

/** What `haven link` prints on success. Informative only; exit 0 is the truth. */
export interface HavenLinkResult {
  workspace: string | null;
  binding: string | null;
}

/**
 * `haven link -p <key>`, run inside the repo. Rejects with the CLI's stderr
 * verbatim, which is what the project page shows under the button.
 */
export function havenLink(path: string, key: string): Promise<HavenLinkResult> {
  return invoke("haven_link", { path, key });
}

// The graph shapes live in `havenTypes.ts` so the pure derivation and its node
// tests can use them without importing the Tauri API.
export type {
  HavenBuckets,
  HavenDep,
  HavenEdge,
  HavenGraph,
  HavenItem,
  HavenNode,
  HavenParent,
  HavenTabCounts,
  HavenView,
} from "./havenTypes";
import type { HavenGraph } from "./havenTypes";

/**
 * One read, one shape (§2): `haven graph --full --all --project <key>`.
 * Rejects with the CLI's stderr verbatim, which is what the workbench's
 * state 4 shows.
 */
export function havenGraph(projectKey: string): Promise<HavenGraph> {
  return invoke("haven_graph", { projectKey });
}

/** Where the Haven store lives, per `haven status` — the file to watch. */
export function havenStatusDbPath(): Promise<string> {
  return invoke("haven_status_db_path");
}

/**
 * Start watching the store directory, idempotently. Resolves once the watch is
 * registered, so the caller can safely issue its first read afterwards (§10.1).
 */
export function havenWatchStore(dbPath: string): Promise<void> {
  return invoke("haven_watch_store", { dbPath });
}
