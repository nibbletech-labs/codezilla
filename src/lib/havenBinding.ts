/**
 * Pure helpers behind the Backlog row and the Haven project picker.
 *
 * Deliberately free of Tauri imports so the rules that decide whether a row
 * appears at all are assertable under plain node (tests/haven-binding.test.ts).
 */

/** What the Backlog line in the sidebar shows for one project. */
export type BacklogRowMode = "none" | "link" | "backlog";

/**
 * `none` whenever Haven is missing or not yet detected — no row, no button,
 * nothing to explain. `link` once Haven is present but the project has no
 * binding; `backlog` when it does.
 */
export function backlogRowMode(
  havenInstalled: boolean | null,
  havenProjectKey: string | undefined,
): BacklogRowMode {
  if (havenInstalled !== true) return "none";
  return havenProjectKey ? "backlog" : "link";
}

/**
 * Put the key suggested by the repo's `_haven/items` symlink first, leaving
 * every other project in the order Haven listed them.
 */
export function orderProjectsForPicker<T extends { key: string }>(
  projects: T[],
  suggestedKey: string | null,
): T[] {
  if (!suggestedKey) return projects;
  const suggested = projects.filter((p) => p.key === suggestedKey);
  if (suggested.length === 0) return projects;
  return [...suggested, ...projects.filter((p) => p.key !== suggestedKey)];
}

/** `RetroStack · RS`, falling back to the key when Haven omits a field. */
export function pickerLabel(project: {
  key: string;
  ref_prefix: string | null;
  title: string | null;
}): string {
  const name = project.title || project.key;
  return project.ref_prefix ? `${name} · ${project.ref_prefix}` : name;
}

/**
 * Every distinct Haven key the open projects are bound to, in the order the
 * projects first mention them. A missing or empty key is not a binding, and two
 * projects sharing a key are one read, not two (§10.4).
 */
export function linkedKeysOf(projects: { havenProjectKey?: string }[]): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const p of projects) {
    const key = p.havenProjectKey;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}
