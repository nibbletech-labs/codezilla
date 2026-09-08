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

/** The key this repo's gitignored `_haven/items` symlink points at, if any. */
export function havenSuggestProjectKey(path: string): Promise<string | null> {
  return invoke("haven_suggest_project_key", { path });
}
