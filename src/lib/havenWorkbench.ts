/**
 * Everything the workbench renders, as pure functions (spec §5–§9).
 *
 * The React layer under `src/components/Backlog/` is a thin port of the r13
 * mockup's render functions; every rule it applies — ordering, epic grouping and
 * colour, the priority meter, the age vocabulary, day grouping, search, the
 * detail column's chips and banners — lives here so it can be asserted against
 * the pinned fixture in node before a line of JSX exists.
 *
 * `now` is always a parameter, never `Date.now()`. No React, no Tauri, and no
 * enums or parameter properties: node runs these files with
 * `--experimental-strip-types`, which erases types and nothing else.
 *
 * **Truth rule.** Every user-facing string in this file says only what Haven
 * stores (§2). There is no time-in-state, no completion time, no queue position,
 * and no "nothing is blocking it" — an empty dependency side reads
 * `none tracked`, because the graph knows tracked dependencies and nothing else.
 */

import { parseHavenTimestamp, unmetBlockers } from "./havenGraph.ts";
import type { HavenBuckets, HavenItem, HavenView } from "./havenTypes";

export type WorkbenchTab = "flight" | "blocked" | "backlog" | "done" | "linked";
export type BacklogZone = "ready" | "needsDef";
export type BacklogOrder = "epic" | "priority";

const HOUR_MS = 36e5;
const DAY_MS = 864e5;

/** Haven's fallback for an unset priority, so nulls sort last rather than first. */
const NO_PRIORITY = 9;
const pri = (i: HavenItem): number => (i.priority == null ? NO_PRIORITY : i.priority);

// ------------------------------------------------------------- ordering ----

/**
 * Priority band ascending, ties keeping the incoming order. `haven graph`
 * already emits nodes in (priority, created_at) order, so a stable sort over
 * `view.items` order reproduces §5's "priority band, then Haven's creation-order
 * fallback" without `created_at` having to reach `HavenItem`.
 */
export function sortByPriority(list: HavenItem[]): HavenItem[] {
  return list
    .map((item, n) => ({ item, n }))
    .sort((a, b) => pri(a.item) - pri(b.item) || a.n - b.n)
    .map((e) => e.item);
}

function sortByTouch(list: HavenItem[]): HavenItem[] {
  return list
    .map((item, n) => ({ item, n, ms: parseHavenTimestamp(item.upd) ?? 0 }))
    .sort((a, b) => b.ms - a.ms || a.n - b.n)
    .map((e) => e.item);
}

export interface OrderedTabs {
  flight: { moving: HavenItem[]; you: HavenItem[]; stuck: HavenItem[] };
  blocked: HavenItem[];
  backlog: { ready: HavenItem[]; needsDef: HavenItem[] };
  done: HavenItem[];
}

/** The §5 buckets in the order the tabs list them. */
export function orderedTabs(b: HavenBuckets): OrderedTabs {
  return {
    flight: {
      moving: sortByPriority(b.moving),
      you: sortByPriority(b.you),
      stuck: sortByPriority(b.stuck),
    },
    blocked: sortByPriority(b.cantGo),
    backlog: { ready: sortByPriority(b.ready), needsDef: sortByPriority(b.needsDef) },
    done: sortByTouch(b.done),
  };
}

/** ref -> the tab that lists it. Absent means the item is on no tab (§9). */
export function tabIndex(lists: OrderedTabs): Map<string, WorkbenchTab> {
  const idx = new Map<string, WorkbenchTab>();
  const add = (list: HavenItem[], tab: WorkbenchTab) => {
    for (const i of list) if (!idx.has(i.ref)) idx.set(i.ref, tab);
  };
  add(lists.flight.moving, "flight");
  add(lists.flight.you, "flight");
  add(lists.flight.stuck, "flight");
  add(lists.blocked, "blocked");
  add(lists.backlog.ready, "backlog");
  add(lists.backlog.needsDef, "backlog");
  add(lists.done, "done");
  return idx;
}

export function tabOf(idx: Map<string, WorkbenchTab>, ref: string): WorkbenchTab | null {
  return idx.get(ref) ?? null;
}

/** Every item one tab lists — what search counts and what hover can reach. */
export function tabNodes(lists: OrderedTabs, tab: WorkbenchTab): HavenItem[] {
  if (tab === "flight") {
    return [...lists.flight.moving, ...lists.flight.you, ...lists.flight.stuck];
  }
  if (tab === "blocked") return lists.blocked;
  if (tab === "backlog") return [...lists.backlog.ready, ...lists.backlog.needsDef];
  if (tab === "done") return lists.done;
  return [];
}

/**
 * ref -> which Backlog zone lists it. The collapse set is keyed by zone as well
 * as epic because six roots appear in both zones on the fixture, and collapsing
 * Ready's copy must not collapse Needs definition's.
 */
export function zoneIndex(lists: OrderedTabs): Map<string, BacklogZone> {
  const idx = new Map<string, BacklogZone>();
  for (const i of lists.backlog.ready) idx.set(i.ref, "ready");
  for (const i of lists.backlog.needsDef) if (!idx.has(i.ref)) idx.set(i.ref, "needsDef");
  return idx;
}

export function zoneOf(idx: Map<string, BacklogZone>, ref: string): BacklogZone | null {
  return idx.get(ref) ?? null;
}

// ---------------------------------------------------------------- epics ----

export interface EpicGroup {
  /** The epic's ref, or `_none` for the ungrouped bucket. */
  key: string;
  root: string | null;
  name: string;
  /** The most urgent priority in the group — what orders the groups. */
  top: number;
  items: HavenItem[];
}

/**
 * Group by primary epic (§7). Epics lead with whichever holds the most urgent
 * work, size breaks ties, and rows inside a group are priority-ordered.
 */
export function groupByEpic(list: HavenItem[]): EpicGroup[] {
  const map = new Map<string, EpicGroup>();
  for (const i of list) {
    const key = i.root ?? "_none";
    const g = map.get(key);
    if (g) g.items.push(i);
    else {
      map.set(key, {
        key,
        root: i.root,
        name: epicShortName(i.rt),
        top: NO_PRIORITY,
        items: [i],
      });
    }
  }
  const groups = [...map.values()];
  for (const g of groups) {
    g.top = Math.min(...g.items.map(pri));
    g.items = sortByPriority(g.items);
  }
  groups.sort((a, b) => a.top - b.top || b.items.length - a.items.length);
  return groups;
}

/** The epic title cut at the first `:` or `—`, capped at 26 characters (§7). */
export function epicShortName(title: string | null): string {
  // A rootless item is `Ungrouped` wherever it appears — group head and tag
  // alike — so the board never has two names for one bucket.
  if (!title) return "Ungrouped";
  const s = String(title).split(/[:—]/)[0].trim();
  return s.length > 26 ? s.slice(0, 25).trim() + "…" : s;
}

const GOLDEN = 137.508;
const ACCENT_GUARD = 18;
/** Codezilla's default accent (green) hue — the mockup's fixed 84. */
export const DEFAULT_ACCENT_HUE = 84;

/**
 * Colour is computed, never assigned or stored (§7): hash the epic's ref to a
 * hue spaced by the golden angle, then push anything within 18° of the accent
 * clear of it so no epic competes with selection.
 */
export function hueOf(ref: string, accentHue: number = DEFAULT_ACCENT_HUE): number {
  let h = 0;
  for (let n = 0; n < ref.length; n++) h = (h * 31 + ref.charCodeAt(n)) >>> 0;
  let hue = ((h % 360) * GOLDEN) % 360;
  const delta = Math.abs(hue - accentHue);
  if (Math.min(delta, 360 - delta) < ACCENT_GUARD) hue = (hue + 2 * ACCENT_GUARD) % 360;
  return Math.round(hue);
}

/** Saturation and lightness are fixed per theme, so the palette re-derives. */
export function epicColour(
  root: string | null,
  theme: "dark" | "light",
  accentHue: number = DEFAULT_ACCENT_HUE,
): string {
  if (!root) return "var(--text-hint)";
  const hue = hueOf(root, accentHue);
  return theme === "light" ? `hsl(${hue} 62% 36%)` : `hsl(${hue} 58% 64%)`;
}

/** The hue of the configured accent, so the guard tracks the real selection colour. */
export function hexToHue(hex: string): number {
  const m = hex.replace("#", "").trim();
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
    return DEFAULT_ACCENT_HUE;
  }
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return ((h * 60) % 360 + 360) % 360;
}

// ------------------------------------------------------- card primitives ----

/**
 * `updated_at` moves on any edit, so the vocabulary never implies a state
 * change: `untouched 11d`, not "in progress for 11 days" (§2, §6).
 */
export function ageText(upd: string | null, nowMs: number): string {
  const ms = parseHavenTimestamp(upd);
  if (ms === null) return "";
  const h = Math.round((nowMs - ms) / HOUR_MS);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return d < 60 ? `${d}d` : `${Math.round(d / 30)}mo`;
}

/** Past seven days the age chip turns amber. */
export function isStale(upd: string | null, nowMs: number): boolean {
  const ms = parseHavenTimestamp(upd);
  return ms !== null && nowMs - ms > 7 * DAY_MS;
}

export function untouchedText(upd: string | null, nowMs: number): string {
  return `untouched ${ageText(upd, nowMs)}`;
}

export function touchedText(upd: string | null, nowMs: number): string {
  return `touched ${ageText(upd, nowMs)}`;
}

export function lastTouchedLine(upd: string | null, nowMs: number): string {
  return `Last touched ${ageText(upd, nowMs)} ago — any edit, not necessarily a state change`;
}

export const PRIORITY_WORDS = ["highest", "high", "normal", "low", "someday"];

export function priorityWord(p: number | null): string {
  if (p == null) return "unset";
  return PRIORITY_WORDS[p] ?? String(p);
}

export interface Meter {
  /** How many of the four slots are filled: `4 − priority`. */
  on: number;
  /** p0 and p1 fill amber. */
  top: boolean;
  title: string;
}

export function meterFill(p: number | null): Meter {
  if (p == null) return { on: 0, top: false, title: "No priority set" };
  return {
    on: Math.max(0, 4 - p),
    top: p <= 1,
    title: `Priority ${p} of 0–4 — ${priorityWord(p)} (more bars = more urgent)`,
  };
}

/** `AI` in the accent colour, `You` in amber, nothing when unowned (§6). */
export function ownerLabel(i: HavenItem): "AI" | "You" | null {
  if (i.owner === "ai") return "AI";
  if (i.owner === "human" || i.wait === "on_human") return "You";
  return null;
}

export function statusWord(status: string | null): string {
  return status ? String(status).replace(/_/g, " ") : "";
}

export function statusColour(status: string | null): string {
  if (status === "in_progress") return "var(--accent)";
  if (status === "blocked") return "var(--bad)";
  if (status === "done") return "var(--ok)";
  if (status === "ready") return "var(--info)";
  return "var(--text-secondary)";
}

/**
 * The cleared-blocker sentence (§6). Never "nothing is blocking it": the marking
 * may stand for a human or external reason the graph does not track.
 */
export function CLEARED_TEXT(had: number): string {
  const noun = had === 1 ? "dependency is" : "dependencies are";
  return `all ${had} tracked ${noun} complete — still marked blocked`;
}

export type Waits =
  | { kind: "none" }
  | { kind: "cleared"; had: number; text: string }
  | { kind: "waiting"; refs: string[]; external: boolean };

/**
 * What an item is waiting on, rendered only where it means something: the unmet
 * dependencies as chips, or — when a blocked item *had* dependencies and every
 * one has since finished — the cleared-blocker flag.
 */
export function waitsOf(view: HavenView, ref: string): Waits {
  const item = view.byRef.get(ref);
  const unmet = unmetBlockers(view, ref);
  const parked = item?.status === "blocked";
  if (unmet.length === 0) {
    const had = (view.dependsOn.get(ref) ?? []).length;
    if (parked && had > 0) return { kind: "cleared", had, text: CLEARED_TEXT(had) };
    return { kind: "none" };
  }
  return { kind: "waiting", refs: unmet, external: item?.wait === "on_external" };
}

/** How many unmet blockers a row's `waiting on N` reports; 0 hides it. */
export function unmetCount(view: HavenView, ref: string): number {
  return unmetBlockers(view, ref).length;
}

// -------------------------------------------------------- the Done log ----

/** Maps an instant to the start of the day that contains it, in some zone. */
export type StartOfDay = (ms: number) => number;

/** The start-of-day epoch an item's last touch falls in, or −1 when undated. */
export function dayKey(upd: string | null, startOfDay: StartOfDay): number {
  const ms = parseHavenTimestamp(upd);
  return ms === null ? -1 : startOfDay(ms);
}

/**
 * The label for a whole group, derived from its key — never from one of its
 * items. The UTC and Europe/London partitions of the fixture both have fourteen
 * days but differ in membership (nine items land after 23:00Z), so labelling in
 * a different zone from the one that grouped produces duplicate labels.
 *
 * `startOfDay` is here only to compute *today's* key for the Today/Yesterday
 * comparison — it is not redundant with `key`; do not simplify it away. It must
 * be the same function, in the same zone, that produced the key, and
 * `timeZone` must name that zone.
 */
export function dayLabel(
  key: number,
  nowMs: number,
  startOfDay: StartOfDay,
  timeZone?: string,
): string {
  if (key < 0) return "undated";
  const days = Math.floor((startOfDay(nowMs) - key) / DAY_MS);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Date(key).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone,
  });
}

export interface DayGroup {
  key: number;
  label: string;
  items: HavenItem[];
}

/**
 * Day separators for the completion log. The list is expected in last-touch
 * order; undated items collect in a trailing group.
 */
export function groupByDay(
  list: HavenItem[],
  nowMs: number,
  startOfDay: StartOfDay,
  timeZone?: string,
): DayGroup[] {
  const map = new Map<number, HavenItem[]>();
  for (const i of list) {
    const key = dayKey(i.upd, startOfDay);
    const bucket = map.get(key);
    if (bucket) bucket.push(i);
    else map.set(key, [i]);
  }
  const dated: DayGroup[] = [];
  let undated: DayGroup | null = null;
  for (const [key, items] of map) {
    const group = { key, label: dayLabel(key, nowMs, startOfDay, timeZone), items };
    if (key < 0) undated = group;
    else dated.push(group);
  }
  return undated ? [...dated, undated] : dated;
}

export const DONE_ZONE = {
  label: "Completed",
  note: "touched in the last 14 days",
  hint: "by last touch — Haven records no completion time",
};

/** The Done zone label in full (§5) — asserted verbatim so it cannot drift. */
export const DONE_LABEL = `${DONE_ZONE.label} · ${DONE_ZONE.note} · ${DONE_ZONE.hint}`;

// --------------------------------------------------------------- search ----

/**
 * What the filter looks at: ref, title, epic short name, the reason (`why` — the
 * item's own text, whether or not the card happens to show it) and the refs of
 * its unmet blockers.
 *
 * Deliberately excluded: the age chip, the owner label, the cleared-blocker
 * sentence, the blocker status words and the `external` chip. Each of those
 * would match every card or most cards on one common word.
 *
 * Because `why` is searchable on every tab, the `N of M` count can include
 * matches on text a Backlog or Done row does not display. That is the intended
 * trade — the alternative is a filter that misses the item you remember.
 */
export function searchText(view: HavenView, i: HavenItem): string {
  return [i.ref, i.title ?? "", epicShortName(i.rt), i.why, ...unmetBlockers(view, i.ref)]
    .join(" ")
    .toLowerCase();
}

export function matches(view: HavenView, i: HavenItem, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || searchText(view, i).includes(q);
}

export function filterList(view: HavenView, list: HavenItem[], query: string): HavenItem[] {
  const q = query.trim().toLowerCase();
  return q === "" ? list : list.filter((i) => searchText(view, i).includes(q));
}

export function searchCount(
  view: HavenView,
  nodes: HavenItem[],
  query: string,
): { hits: number; total: number } {
  return { hits: filterList(view, nodes, query).length, total: nodes.length };
}

// ------------------------------------------------ the detail column ----

export interface PartOfChip {
  ref: string;
  /** The primary epic, drawn in its own colour. */
  primary: boolean;
  label: string;
}

/**
 * The primary epic (§7) followed by every other direct parent, so nothing the
 * graph says about membership is hidden by the choice of one colour.
 */
export function partOf(view: HavenView, ref: string): PartOfChip[] {
  const i = view.byRef.get(ref);
  if (!i) return [];
  const chips: PartOfChip[] = [];
  if (i.root && i.rt) chips.push({ ref: i.root, primary: true, label: epicShortName(i.rt) });
  for (const p of i.parents) {
    if (p.ref === i.root) continue;
    const parent = view.byRef.get(p.ref);
    chips.push({ ref: p.ref, primary: false, label: epicShortName(parent?.title ?? null) });
  }
  return chips;
}

export interface NeighbourPill {
  ref: string;
  status: string;
  /** The pill you arrived from, marked so the trail never breaks (§9). */
  from: boolean;
}

export interface Neighbourhood {
  before: NeighbourPill[];
  after: NeighbourPill[];
  /** False when the item has no tracked dependencies on either side. */
  any: boolean;
}

/**
 * Both sides in full. The dependency graph is a DAG and 104 of RetroStack's
 * linked items branch, so any widget assuming a line lies at every fork.
 */
export function neighbourhood(
  view: HavenView,
  ref: string,
  cameFrom: string | null,
): Neighbourhood {
  const pill = (r: string): NeighbourPill => ({
    ref: r,
    status: statusWord(view.byRef.get(r)?.status ?? null),
    from: r === cameFrom,
  });
  const before = (view.dependsOn.get(ref) ?? []).map(pill);
  const after = (view.requiredBy.get(ref) ?? []).map(pill);
  return { before, after, any: before.length > 0 || after.length > 0 };
}

/**
 * The empty-side placeholder. Not "nothing": Haven knows tracked dependencies,
 * and "nothing" would read as "nothing is blocking it".
 */
export const NONE_TRACKED = "none tracked";

/** `NONE_TRACKED` for an empty side, `null` when the side has pills to draw. */
export function sideText(list: NeighbourPill[]): string | null {
  return list.length === 0 ? NONE_TRACKED : null;
}

/** Why a linked item has no row to jump to (§9). Null when it is on a tab. */
export function offViewNote(
  idx: Map<string, WorkbenchTab>,
  item: HavenItem | null | undefined,
  nowMs: number,
): string | null {
  if (!item || idx.has(item.ref)) return null;
  if (item.status === "done") {
    return `Completed — last touched ${ageText(item.upd, nowMs)} ago, outside the fortnight the Done tab shows, so there is no row to jump to.`;
  }
  if (item.status === "archived" || item.status === "superseded") {
    const word = item.status === "archived" ? "Archived" : "Superseded";
    return `${word} — kept for its links, not listed on any tab.`;
  }
  return `In ${statusWord(item.status)} and not committed, so it is not on a tab yet.`;
}

/** The header's read stamp. Null `readAt` has never been read, and says so. */
export function readStamp(readAt: number | null, nowMs: number): string {
  if (readAt == null) return "never read";
  const delta = Math.max(0, nowMs - readAt);
  if (delta < 5_000) return "read just now";
  if (delta < 60_000) return `read ${Math.floor(delta / 1000)}s ago`;
  if (delta < HOUR_MS) return `read ${Math.floor(delta / 60_000)}m ago`;
  return `read ${Math.floor(delta / HOUR_MS)}h ago`;
}

/** How long the ↻ pulse runs, matching the CSS animation's duration. */
export const PULSE_MS = 600;

/**
 * Is the refresh button spinning? A read in flight spins it, and so does a
 * click, for `PULSE_MS`, so an instant read still shows that something
 * happened.
 *
 * The pulse is bounded by the clock rather than by `animationend`, which never
 * arrives when the element is already spinning from a read — or when the
 * animation is suppressed entirely — and would otherwise leave it spinning for
 * good.
 */
export function shouldSpin(
  reading: boolean,
  pulseStartedAt: number | null,
  nowMs: number,
): boolean {
  if (reading) return true;
  return pulseStartedAt !== null && nowMs - pulseStartedAt < PULSE_MS;
}

/** The empty-tab lines, in each tab's own voice (§5). */
export const EMPTY_LINES: Record<Exclude<WorkbenchTab, "linked">, string> = {
  flight: "Nothing in flight",
  blocked: "Nothing parked",
  backlog: "Nothing in the backlog",
  done: "No completed work touched in the last 14 days",
};
