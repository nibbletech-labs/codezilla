import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { bucketView, deriveView } from "../src/lib/havenGraph.ts";
import type { HavenGraphLike, HavenItem, HavenView } from "../src/lib/havenTypes.ts";
import {
  CLEARED_TEXT,
  DONE_LABEL,
  NONE_TRACKED,
  PRIORITY_WORDS,
  ageText,
  dayKey,
  dayLabel,
  epicColour,
  epicShortName,
  filterList,
  groupByDay,
  groupByEpic,
  hexToHue,
  hueOf,
  isStale,
  lastTouchedLine,
  matches,
  meterFill,
  neighbourhood,
  offViewNote,
  orderedTabs,
  ownerLabel,
  partOf,
  priorityWord,
  readStamp,
  searchCount,
  sideText,
  sortByPriority,
  statusColour,
  statusWord,
  tabIndex,
  tabNodes,
  tabOf,
  touchedText,
  untouchedText,
  waitsOf,
  zoneIndex,
  zoneOf,
} from "../src/lib/havenWorkbench.ts";

const FIXTURES = path.join(import.meta.dirname, "../src-tauri/tests/fixtures/haven");

/** The instant every fixture count is pinned at (spec §15, r13's render instant). */
const FIXTURE_NOW = Date.parse("2026-09-07T23:00:00Z");

// Read, never `import` — keeping 1.7 MB of JSON out of tsc's module graph.
function readFixture(name: string): any {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));
}
const raw = (): HavenGraphLike => readFixture("retrostack-2026-09-07.raw.json");

const view: HavenView = deriveView(raw());
const buckets = bucketView(view, FIXTURE_NOW);
const lists = orderedTabs(buckets);
const idx = tabIndex(lists);
const zones = zoneIndex(lists);
const item = (ref: string): HavenItem => {
  const i = view.byRef.get(ref);
  assert.ok(i, `${ref} missing from the fixture`);
  return i;
};

/** Local-zone-free start of day, so day grouping is deterministic in CI. */
const utcStartOfDay = (ms: number): number => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

// ---------------------------------------------------------------- Step 1 ----

test("orderedTabs reproduces the seven fixture counts", () => {
  assert.equal(lists.flight.moving.length, 8);
  assert.equal(lists.flight.you.length, 16);
  assert.equal(lists.flight.stuck.length, 5);
  assert.equal(lists.blocked.length, 4);
  assert.equal(lists.backlog.ready.length, 68);
  assert.equal(lists.backlog.needsDef.length, 21);
  assert.equal(lists.done.length, 168);
});

test("every live list is priority-ordered and stable; Done is newest-touch first", () => {
  const pri = (i: HavenItem) => (i.priority == null ? 9 : i.priority);
  const live = [
    lists.flight.moving,
    lists.flight.you,
    lists.flight.stuck,
    lists.blocked,
    lists.backlog.ready,
    lists.backlog.needsDef,
  ];
  for (const list of live) {
    for (let n = 1; n < list.length; n++) {
      assert.ok(pri(list[n]) >= pri(list[n - 1]), "priority band must not go backwards");
    }
    // Stable: the same-priority runs keep `view.items` order, which is Haven's
    // creation-order fallback (spec §5). Sorting an already-sorted list is a no-op.
    const order = new Map(view.items.map((i, n) => [i.ref, n]));
    for (let n = 1; n < list.length; n++) {
      if (pri(list[n]) === pri(list[n - 1])) {
        assert.ok(order.get(list[n].ref)! > order.get(list[n - 1].ref)!);
      }
    }
  }
  const ms = (i: HavenItem) => Date.parse(String(i.upd).replace(" ", "T") + "Z");
  for (let n = 1; n < lists.done.length; n++) {
    assert.ok(ms(lists.done[n]) <= ms(lists.done[n - 1]));
  }
});

test("sortByPriority is stable and puts null priority last", () => {
  const a = { ref: "A", priority: 2 } as HavenItem;
  const b = { ref: "B", priority: null } as HavenItem;
  const c = { ref: "C", priority: 2 } as HavenItem;
  const d = { ref: "D", priority: 0 } as HavenItem;
  assert.deepEqual(
    sortByPriority([a, b, c, d]).map((i) => i.ref),
    ["D", "A", "C", "B"],
  );
});

test("tabIndex indexes the 122 live items and the 168 done ones", () => {
  assert.equal(idx.size, 122 + 168);
  assert.equal(tabOf(idx, "RS-606"), "flight");
  assert.equal(tabOf(idx, "RS-160"), "backlog");
  assert.equal(tabOf(idx, "RS-257"), "blocked");
  assert.equal(tabOf(idx, "RS-184"), null);
  assert.equal(tabOf(idx, "RS-190"), null);
  assert.equal(tabOf(idx, "RS-189"), null);
});

test("tabNodes returns exactly the items a tab lists", () => {
  assert.equal(tabNodes(lists, "flight").length, 29);
  assert.equal(tabNodes(lists, "blocked").length, 4);
  assert.equal(tabNodes(lists, "backlog").length, 89);
  assert.equal(tabNodes(lists, "done").length, 168);
  assert.equal(tabNodes(lists, "linked").length, 0);
});

test("zoneIndex splits the Backlog tab into its two zones", () => {
  assert.equal(zoneOf(zones, "RS-160"), "ready");
  assert.equal(zoneOf(zones, "RS-214"), "needsDef");
  assert.equal(zoneOf(zones, "RS-606"), null);
});

// ---------------------------------------------------------------- Step 2 ----

test("groupByEpic groups Ready into 13 epics, most urgent first, size breaking ties", () => {
  const groups = groupByEpic(lists.backlog.ready);
  assert.equal(groups.length, 13);
  assert.equal(
    groups.reduce((n, g) => n + g.items.length, 0),
    68,
  );
  for (let n = 1; n < groups.length; n++) {
    const a = groups[n - 1];
    const b = groups[n];
    assert.ok(a.top < b.top || (a.top === b.top && a.items.length >= b.items.length));
  }
  const pri = (i: HavenItem) => (i.priority == null ? 9 : i.priority);
  for (const g of groups) {
    for (let n = 1; n < g.items.length; n++) {
      assert.ok(pri(g.items[n]) >= pri(g.items[n - 1]));
    }
  }
  const none = groups.find((g) => g.key === "_none");
  assert.ok(none);
  assert.equal(none.root, null);
  assert.equal(none.name, "Ungrouped");
  assert.equal(none.items.length, 19);

  const nd = groupByEpic(lists.backlog.needsDef);
  assert.equal(nd.length, 7);
  assert.equal(nd.find((g) => g.key === "_none")?.items.length, 11);
});

test("epicShortName cuts at the first colon or em dash and caps at 26", () => {
  assert.equal(
    epicShortName("DB tidy-up: everything the catalogue owes the app"),
    "DB tidy-up",
  );
  assert.equal(
    epicShortName("Track CLIENT — stand up the server-shaped client"),
    "Track CLIENT",
  );
  assert.equal(epicShortName("Finish the v2 catalogue pipeline"), "Finish the v2 catalogue p…");
  assert.equal(epicShortName("Reference Catalogue"), "Reference Catalogue");
  assert.equal(epicShortName(null), "ungrouped");
});

test("hueOf is pinned per epic ref and pushed clear of the accent", () => {
  assert.equal(hueOf("RS-37"), 282);
  assert.equal(hueOf("RS-38"), 60);
  assert.equal(hueOf("RS-161"), 322);
  assert.equal(hueOf("RS-214"), 138);
  // The guard: an accent sitting on RS-37's hue pushes it two guard-widths away.
  assert.equal(hueOf("RS-37", 282), (282 + 36) % 360);
  // ...and leaves a hue outside the guard alone.
  assert.equal(hueOf("RS-37", 180), 282);
});

test("epicColour is fixed saturation and lightness per theme", () => {
  assert.equal(epicColour("RS-37", "dark"), "hsl(282 58% 64%)");
  assert.equal(epicColour("RS-37", "light"), "hsl(282 62% 36%)");
  assert.equal(epicColour(null, "dark"), "var(--text-hint)");
  assert.equal(epicColour(null, "light"), "var(--text-hint)");
});

test("hexToHue reads the configured accent", () => {
  assert.ok(Math.abs(hexToHue("#C1FF72") - 84) <= 3);
  assert.equal(Math.round(hexToHue("#ff0000")), 0);
  assert.equal(Math.round(hexToHue("#888888")), 0);
});

// ---------------------------------------------------------------- Step 3 ----

test("RS-606 is the only Stuck or Parked item flagged as cleared, with the exact wording", () => {
  const flagged = (ref: string) => waitsOf(view, ref).kind === "cleared";
  assert.equal(flagged("RS-606"), true);
  for (const ref of ["RS-905", "RS-746", "RS-805", "RS-811"]) {
    assert.equal(flagged(ref), false, `${ref} must not claim a cleared blocker`);
  }
  // Parked items too — RS-257 has no dependencies at all, so the flag can never fire.
  for (const ref of ["RS-257", "RS-878", "RS-879", "RS-881"]) {
    assert.equal(flagged(ref), false, `${ref} must not claim a cleared blocker`);
  }
  for (const list of [lists.flight.stuck, lists.blocked]) {
    for (const i of list) {
      assert.equal(flagged(i.ref), i.ref === "RS-606");
    }
  }
  assert.deepEqual(waitsOf(view, "RS-606"), {
    kind: "cleared",
    had: 1,
    text: "all 1 tracked dependency is complete — still marked blocked",
  });
  assert.equal(CLEARED_TEXT(1), "all 1 tracked dependency is complete — still marked blocked");
  assert.equal(CLEARED_TEXT(3), "all 3 tracked dependencies are complete — still marked blocked");
});

test("waitsOf lists unmet blockers and the external chip", () => {
  assert.deepEqual(waitsOf(view, "RS-746"), {
    kind: "waiting",
    refs: ["RS-741"],
    external: true,
  });
  assert.deepEqual(waitsOf(view, "RS-905"), {
    kind: "waiting",
    refs: ["RS-886"],
    external: false,
  });
  assert.deepEqual(waitsOf(view, "RS-257"), { kind: "none" });
  // A synthetic plural: two dependencies, both finished, still marked blocked.
  const syn = deriveView({
    project: "syn",
    nodes: [
      { ref: "S-1", title: "Blocked", status: "blocked", owner_kind: "ai" },
      { ref: "S-2", title: "A", status: "done" },
      { ref: "S-3", title: "B", status: "archived" },
    ],
    edges: [
      { from: "S-1", kind: "dependency", to: "S-2" },
      { from: "S-1", kind: "dependency", to: "S-3" },
    ],
  });
  assert.deepEqual(waitsOf(syn, "S-1"), {
    kind: "cleared",
    had: 2,
    text: "all 2 tracked dependencies are complete — still marked blocked",
  });
});

test("ageText and isStale speak the mockup's vocabulary", () => {
  const at = (iso: string) => ageText(iso, FIXTURE_NOW);
  assert.equal(at("2026-09-07 22:40:00"), "just now");
  assert.equal(at("2026-09-07 20:00:00"), "3h");
  assert.equal(at("2026-08-27 23:00:00"), "11d");
  assert.equal(at("2026-07-09 23:00:00"), "2mo");
  assert.equal(ageText(null, FIXTURE_NOW), "");
  assert.equal(isStale("2026-09-05 23:00:00", FIXTURE_NOW), false);
  assert.equal(isStale("2026-08-27 23:00:00", FIXTURE_NOW), true);
  assert.equal(isStale(null, FIXTURE_NOW), false);
  assert.equal(untouchedText("2026-08-27 23:00:00", FIXTURE_NOW), "untouched 11d");
  assert.equal(touchedText("2026-09-04 23:00:00", FIXTURE_NOW), "touched 3d");
  assert.equal(
    lastTouchedLine("2026-08-27 23:00:00", FIXTURE_NOW),
    "Last touched 11d ago — any edit, not necessarily a state change",
  );
});

test("meterFill fills four slots downwards from Haven's priority", () => {
  assert.deepEqual(meterFill(0), {
    on: 4,
    top: true,
    title: "Priority 0 of 0–4 — highest (more bars = more urgent)",
  });
  assert.deepEqual(meterFill(1), {
    on: 3,
    top: true,
    title: "Priority 1 of 0–4 — high (more bars = more urgent)",
  });
  assert.equal(meterFill(4).on, 0);
  assert.equal(meterFill(4).top, false);
  assert.deepEqual(meterFill(null), { on: 0, top: false, title: "No priority set" });
  assert.deepEqual(PRIORITY_WORDS, ["highest", "high", "normal", "low", "someday"]);
  assert.equal(priorityWord(1), "high");
  assert.equal(priorityWord(null), "unset");
});

test("ownerLabel, statusWord and statusColour never invent a state", () => {
  assert.equal(ownerLabel(item("RS-606")), "AI");
  assert.equal(ownerLabel({ owner: "human", wait: null } as HavenItem), "You");
  assert.equal(ownerLabel({ owner: null, wait: "on_human" } as HavenItem), "You");
  assert.equal(ownerLabel({ owner: null, wait: null } as HavenItem), null);
  assert.equal(statusWord("in_progress"), "in progress");
  assert.equal(statusWord(null), "");
  assert.equal(statusColour("in_progress"), "var(--accent)");
  assert.equal(statusColour("blocked"), "var(--bad)");
  assert.equal(statusColour("done"), "var(--ok)");
  assert.equal(statusColour("ready"), "var(--info)");
  assert.equal(statusColour(null), "var(--text-secondary)");
});

// ---------------------------------------------------------------- Step 4 ----

test("groupByDay partitions Done into 14 day groups, labelled from the group key", () => {
  // The UTC and Europe/London partitions of this fixture both have 14 groups but
  // differ in membership: nine items land after 23:00Z and belong to the next
  // London day. Grouping in one zone and labelling in another produces duplicate
  // labels, which is why the label is derived from the group's key, never from an
  // item, and the same zone is used for both.
  const groups = groupByDay(lists.done, FIXTURE_NOW, utcStartOfDay, "UTC");
  assert.equal(groups.length, 14);
  assert.equal(
    groups.reduce((n, g) => n + g.items.length, 0),
    168,
  );
  const keys = groups.map((g) => g.key);
  assert.equal(new Set(keys).size, 14);
  for (let n = 1; n < keys.length; n++) assert.ok(keys[n] < keys[n - 1]);
  for (const g of groups) {
    for (const i of g.items) assert.equal(dayKey(i.upd, utcStartOfDay), g.key);
  }
  assert.equal(groups[0].key, Date.UTC(2026, 8, 7));
  assert.equal(groups[0].label, "Today");
  assert.equal(groups[1].key, Date.UTC(2026, 8, 6));
  assert.equal(groups[1].label, "Yesterday");
});

test("an undated item lands in a trailing `undated` group", () => {
  const undated = { ...item("RS-190"), ref: "RS-000", upd: null };
  const groups = groupByDay(
    [...lists.done.slice(0, 3), undated],
    FIXTURE_NOW,
    utcStartOfDay,
    "UTC",
  );
  const last = groups[groups.length - 1];
  assert.equal(last.key, -1);
  assert.equal(last.label, "undated");
  assert.deepEqual(last.items.map((i) => i.ref), ["RS-000"]);
  assert.equal(dayKey(null, utcStartOfDay), -1);
});

test("an older day formats from its key in the grouping's own zone", () => {
  const label = dayLabel(Date.UTC(2026, 8, 5), FIXTURE_NOW, utcStartOfDay, "UTC");
  assert.ok(label.length > 0);
  assert.ok(label.includes("5"), label);
  assert.notEqual(label, "Today");
  assert.notEqual(label, "Yesterday");
});

// ---------------------------------------------------------------- Step 5 ----

test("all 21 Needs-definition items are findable by ref and by a title fragment", () => {
  assert.equal(lists.backlog.needsDef.length, 21);
  for (const i of lists.backlog.needsDef) {
    assert.equal(matches(view, i, i.ref.toLowerCase()), true, `${i.ref} not findable by ref`);
    const fragment = String(i.title).slice(0, 8).toLowerCase();
    assert.ok(fragment.length >= 8, `${i.ref} title too short to fragment`);
    assert.equal(matches(view, i, fragment), true, `${i.ref} not findable by title`);
  }
});

test("searchCount counts hits against the whole tab", () => {
  const nodes = tabNodes(lists, "backlog");
  assert.deepEqual(searchCount(view, nodes, "rs-"), { hits: 89, total: 89 });
  assert.deepEqual(searchCount(view, nodes, "zzzzz-nothing"), { hits: 0, total: 89 });
  assert.deepEqual(searchCount(view, nodes, ""), { hits: 89, total: 89 });
});

test("filtering runs before grouping, so no epic group is ever empty", () => {
  for (const q of ["", "catalogue", "rs-2", "zzzzz-nothing"]) {
    for (const g of groupByEpic(filterList(view, lists.backlog.ready, q))) {
      assert.ok(g.items.length > 0);
    }
  }
});

test("search is case-insensitive and covers ref, title, epic, reason and unmet refs", () => {
  const i160 = item("RS-160");
  assert.equal(matches(view, i160, ""), true);
  assert.equal(matches(view, i160, "RS-160"), true);
  assert.equal(matches(view, i160, "rs-160"), true);
  // The epic short name is searchable...
  assert.equal(matches(view, i160, "reference catalogue"), true);
  // ...and so is the unmet-blocker ref.
  assert.equal(matches(view, item("RS-905"), "rs-886"), true);
});

test("the labels that would match every card are deliberately not searchable", () => {
  // The cleared-blocker sentence, the `external` chip and the blocker status
  // words each match most cards on a common word; none is part of the text.
  assert.equal(matches(view, item("RS-606"), "complete"), false);
  assert.equal(matches(view, item("RS-746"), "external"), false);
  assert.equal(matches(view, item("RS-905"), "ready"), false);
});

// ---------------------------------------------------------------- Step 6 ----

test("partOf lists the primary epic in colour, then every other direct parent", () => {
  assert.deepEqual(partOf(view, "RS-190"), [
    { ref: "RS-37", primary: true, label: "Reference Catalogue" },
    { ref: "RS-159", primary: false, label: "Pipeline discipline" },
    { ref: "RS-214", primary: false, label: "Track V2" },
  ]);
  // A top-level epic is part of nothing.
  assert.deepEqual(partOf(view, "RS-37"), []);
});

test("neighbourhood shows both sides in full and marks where you came from", () => {
  const hood = neighbourhood(view, "RS-160", "RS-184");
  assert.deepEqual(hood.before.map((p) => p.ref), ["RS-169", "RS-193"]);
  assert.deepEqual(hood.before.map((p) => p.status), ["done", "ready"]);
  assert.equal(hood.after.length, 5);
  assert.deepEqual(hood.after.map((p) => p.ref), [
    "RS-156",
    "RS-157",
    "RS-158",
    "RS-183",
    "RS-184",
  ]);
  assert.deepEqual(
    hood.after.map((p) => p.from),
    [false, false, false, false, true],
  );
  const rs193 = neighbourhood(view, "RS-193", null);
  assert.deepEqual(rs193.before, []);
  assert.ok(rs193.after.some((p) => p.ref === "RS-189"));
  assert.equal(rs193.after.every((p) => p.from === false), true);
});

test("an empty dependency side reads `none tracked`, never `nothing`", () => {
  assert.equal(NONE_TRACKED, "none tracked");
  assert.equal(sideText([]), "none tracked");
  assert.equal(sideText(neighbourhood(view, "RS-193", null).before), "none tracked");
  assert.equal(sideText(neighbourhood(view, "RS-160", null).before), null);
});

test("an item with no dependencies at all has no Dependencies block", () => {
  const hood = neighbourhood(view, "RS-257", null);
  assert.deepEqual(hood.before, []);
  assert.deepEqual(hood.after, []);
  assert.equal(hood.any, false);
  assert.equal(neighbourhood(view, "RS-160", null).any, true);
});

test("offViewNote explains why a linked item has no row", () => {
  assert.equal(
    offViewNote(idx, item("RS-184"), FIXTURE_NOW),
    "Completed — last touched 39d ago, outside the fortnight the Done tab shows, so there is no row to jump to.",
  );
  assert.equal(
    offViewNote(idx, item("RS-189"), FIXTURE_NOW),
    "Archived — kept for its links, not listed on any tab.",
  );
  assert.equal(
    offViewNote(idx, item("RS-224"), FIXTURE_NOW),
    "Superseded — kept for its links, not listed on any tab.",
  );
  assert.equal(
    offViewNote(idx, item("RS-504"), FIXTURE_NOW),
    "In discovery and not committed, so it is not on a tab yet.",
  );
  assert.equal(offViewNote(idx, item("RS-160"), FIXTURE_NOW), null);
  assert.equal(offViewNote(idx, null, FIXTURE_NOW), null);
});

test("readStamp counts down from the read, never claims a read that never happened", () => {
  const now = FIXTURE_NOW;
  assert.equal(readStamp(null, now), "never read");
  assert.equal(readStamp(now - 1_000, now), "read just now");
  assert.equal(readStamp(now - 12_000, now), "read 12s ago");
  assert.equal(readStamp(now - 3 * 60_000, now), "read 3m ago");
  assert.equal(readStamp(now - 2 * 3_600_000, now), "read 2h ago");
});

test("the Done zone label says exactly what Haven knows", () => {
  assert.equal(
    DONE_LABEL,
    "Completed · touched in the last 14 days · by last touch — Haven records no completion time",
  );
});
