/**
 * Pure helpers behind the Backlog row, the project page's Haven line and the
 * project chooser.
 *
 * Deliberately free of Tauri imports so the rules that decide whether a row
 * appears at all are assertable under plain node (tests/haven-binding.test.ts).
 */

/**
 * Every distinct Haven key the open projects are bound to, in the order the
 * bindings map first mentions them. An unbound or empty entry is not a binding,
 * and two projects sharing a key are one read, not two (§10.4).
 */
export function linkedKeysOf(bindings: HavenBindings): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const key of Object.values(bindings)) {
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

// --- CZ-99: the repo's `.haven-project` file is the only binding -------------

/**
 * What Codezilla knows about each project's binding, keyed by *Codezilla*
 * project id: the Haven key its repo resolves to, `null` once checked and
 * unbound, and absent until the first read lands.
 */
export type HavenBindings = Record<string, string | null>;

/**
 * The sidebar's Backlog row: only for a project that is actually bound, and
 * only once Haven is known to be installed. An unbound project gets no sidebar
 * affordance at all — linking lives on the project page.
 */
export function showBacklogRow(
  havenInstalled: boolean | null,
  key: string | null | undefined,
): boolean {
  return havenInstalled === true && !!key;
}

/** The last real segment of a path — the repo's folder name. */
export function folderNameOf(path: string): string {
  const parts = path.split("/").filter((p) => p.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : "";
}

/**
 * Which Haven keys are already bound by *other* Codezilla projects, mapped to
 * the first such project's name. Those rows stay selectable — two Codezilla
 * projects may legitimately watch one Haven project — but they are dimmed and
 * say who already has them.
 */
export function takenByOthers(
  projects: { id: string; name: string }[],
  bindings: HavenBindings,
  selfId: string,
): Record<string, string> {
  const taken: Record<string, string> = {};
  for (const p of projects) {
    if (p.id === selfId) continue;
    const key = bindings[p.id];
    if (!key || key in taken) continue;
    taken[key] = p.name;
  }
  return taken;
}

export interface ChooserSections<T> {
  free: T[];
  taken: { project: T; boundBy: string }[];
  /** Keyboard traversal order: [...free, ...taken.map(t => t.project)]. */
  ordered: T[];
  highlightKey: string | null;
}

/**
 * The chooser's two sections. Free projects come first, alphabetically by
 * title (falling back to the key), then the ones another Codezilla project
 * already holds, in the same order. The repo's folder name picks the initially
 * highlighted row — the one Enter takes — without reordering anything; with no
 * match, the first row is highlighted instead.
 */
export function chooserSections<T extends { key: string; title: string | null }>(
  projects: T[],
  takenBy: Record<string, string>,
  folderName: string,
): ChooserSections<T> {
  const label = (p: T) => p.title ?? p.key;
  const sorted = [...projects].sort((a, b) =>
    label(a).localeCompare(label(b), undefined, { sensitivity: "base" }),
  );
  const free = sorted.filter((p) => !(p.key in takenBy));
  const taken = sorted
    .filter((p) => p.key in takenBy)
    .map((p) => ({ project: p, boundBy: takenBy[p.key] }));
  const ordered = [...free, ...taken.map((t) => t.project)];
  const match = folderName ? free.find((p) => p.key === folderName) : undefined;
  return {
    free,
    taken,
    ordered,
    highlightKey: match?.key ?? ordered[0]?.key ?? null,
  };
}

/**
 * The linked line, one segment per `·`-separated part:
 * `RetroStack · RS · 29 live · 68 ready`. A missing prefix drops its segment
 * rather than rendering blank; a count that has not been read yet is a dash,
 * while a real zero is a zero.
 */
export function linkedLineSegments(
  title: string,
  prefix: string | null,
  live: number | null,
  ready: number | null,
): string[] {
  const count = (n: number | null) => (n == null ? "—" : String(n));
  const segments = [title];
  if (prefix) segments.push(prefix);
  segments.push(`${count(live)} live`, `${count(ready)} ready`);
  return segments;
}
