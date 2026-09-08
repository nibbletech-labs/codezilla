import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { bucketView, deriveView } from "../src/lib/havenGraph.ts";
import type { HavenGraphLike } from "../src/lib/havenTypes.ts";
import {
  groupByEpic,
  neighbourhood,
  orderedTabs,
  tabIndex,
  tabOf,
  zoneIndex,
  zoneOf,
} from "../src/lib/havenWorkbench.ts";
import {
  type NavCtx,
  type NavState,
  groupKey,
  initialNav,
  navReduce,
} from "../src/lib/havenNav.ts";

const FIXTURES = path.join(import.meta.dirname, "../src-tauri/tests/fixtures/haven");
const FIXTURE_NOW = Date.parse("2026-09-07T23:00:00Z");

function readFixture(name: string): any {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));
}
const view = deriveView(readFixture("retrostack-2026-09-07.raw.json") as HavenGraphLike);
const lists = orderedTabs(bucketView(view, FIXTURE_NOW));
const idx = tabIndex(lists);
const zones = zoneIndex(lists);

const ctx: NavCtx = {
  tabOf: (ref) => tabOf(idx, ref),
  has: (ref) => view.byRef.has(ref),
  rootOf: (ref) => view.byRef.get(ref)?.root ?? null,
  zoneOf: (ref) => zoneOf(zones, ref),
};

const run = (start: NavState, ...actions: Parameters<typeof navReduce>[1][]): NavState =>
  actions.reduce((s, a) => navReduce(s, a, ctx), start);

const onBacklog = () => navReduce(initialNav(), { type: "showTab", tab: "backlog" }, ctx);

test("the initial state shows In flight with nothing selected", () => {
  const s = initialNav();
  assert.equal(s.tab, "flight");
  assert.equal(s.current, null);
  assert.equal(s.linkedRef, null);
  assert.equal(s.cameFrom, null);
  assert.deepEqual(s.trail, []);
  assert.equal(s.query, "");
  assert.equal(s.collapsed.size, 0);
  assert.equal(s.scrollNonce, 0);
});

test("RS-184 → RS-160 → back keeps RS-184 listed and marked", () => {
  // Click RS-160 on the Backlog tab.
  const a = run(onBacklog(), { type: "select", ref: "RS-160" });
  assert.equal(a.tab, "backlog");
  assert.equal(a.current, "RS-160");
  assert.deepEqual(a.trail, []);
  assert.equal(a.cameFrom, null);
  assert.equal(a.scrollNonce, 0);

  // RS-184 is on no tab (completed 39 days ago), so it lands in the Linked view.
  const b = run(a, { type: "goTo", ref: "RS-184" });
  assert.equal(b.tab, "linked");
  assert.equal(b.linkedRef, "RS-184");
  assert.equal(b.current, "RS-184");
  assert.equal(b.cameFrom, "RS-160");
  assert.deepEqual(b.trail, ["RS-160"]);
  assert.equal(b.scrollNonce, 1);

  // Back out through the fork: RS-160 fans out to five dependents.
  const c = run(b, { type: "goTo", ref: "RS-160" });
  assert.equal(c.tab, "backlog");
  assert.equal(c.linkedRef, null);
  assert.equal(c.current, "RS-160");
  assert.equal(c.cameFrom, "RS-184");
  assert.deepEqual(c.trail, ["RS-160", "RS-184"]);
  const hood = neighbourhood(view, c.current!, c.cameFrom);
  assert.equal(hood.after.length, 5);
  assert.deepEqual(
    hood.after.filter((p) => p.from).map((p) => p.ref),
    ["RS-184"],
  );

  // ‹ RS-184 — still listed, still marked, and the came-from marking is dropped.
  const d = run(c, { type: "back" });
  assert.equal(d.current, "RS-184");
  assert.equal(d.tab, "linked");
  assert.equal(d.linkedRef, "RS-184");
  assert.equal(d.cameFrom, null);
  assert.deepEqual(d.trail, ["RS-160"]);
  assert.equal(d.scrollNonce, 3);

  const e = run(d, { type: "back" });
  assert.equal(e.current, "RS-160");
  assert.equal(e.tab, "backlog");
  assert.equal(e.linkedRef, null);
  assert.deepEqual(e.trail, []);

  // An empty trail is a dead end, not a crash.
  const f = run(e, { type: "back" });
  assert.deepEqual(f, e);
});

test("a link to an archived item opens the Linked-item view", () => {
  const s = run(
    onBacklog(),
    { type: "select", ref: "RS-193" },
    { type: "goTo", ref: "RS-189" },
  );
  assert.equal(s.tab, "linked");
  assert.equal(s.linkedRef, "RS-189");
  assert.equal(s.current, "RS-189");
  assert.equal(view.byRef.get("RS-189")?.status, "archived");
});

test("a ref outside the read selects without moving the tab", () => {
  const s = run(onBacklog(), { type: "select", ref: "RS-160" }, {
    type: "goTo",
    ref: "RS-99999",
  });
  assert.equal(s.tab, "backlog");
  assert.equal(s.linkedRef, null);
  assert.equal(s.current, "RS-99999");
  assert.deepEqual(s.trail, ["RS-160"]);
});

test("goTo clears the search box and expands the target's zone-qualified group", () => {
  const collapsed = new Set([groupKey("ready", "RS-37"), groupKey("needsDef", "RS-38")]);
  const start: NavState = { ...onBacklog(), query: "zzz", collapsed };
  const s = navReduce(start, { type: "goTo", ref: "RS-160" }, ctx);
  assert.equal(s.query, "");
  assert.equal(s.collapsed.has("ready:RS-37"), false);
  // Every other collapsed group is left as it was.
  assert.equal(s.collapsed.has("needsDef:RS-38"), true);
  // The starting state is not mutated.
  assert.equal(start.collapsed.has("ready:RS-37"), true);
  assert.equal(start.query, "zzz");
});

test("the same zone-qualified key reaches an ungrouped target", () => {
  const ungrouped = lists.backlog.ready.find((i) => i.root === null);
  assert.ok(ungrouped);
  const start: NavState = {
    ...onBacklog(),
    query: "zzz",
    collapsed: new Set([groupKey("ready", null)]),
  };
  assert.equal(groupKey("ready", null), "ready:_none");
  const s = navReduce(start, { type: "goTo", ref: ungrouped.ref }, ctx);
  assert.equal(s.collapsed.has("ready:_none"), false);
  assert.equal(s.query, "");
});

test("Ready and Needs definition collapse independently even for the same epic", () => {
  // Six roots appear in both zones on the fixture, so the collapse key must carry
  // the zone or collapsing one would collapse the other.
  const readyRs37 = lists.backlog.ready.find((i) => i.root === "RS-37");
  const needsDefRs37 = lists.backlog.needsDef.find((i) => i.root === "RS-37");
  assert.ok(readyRs37 && needsDefRs37);
  assert.ok(groupByEpic(lists.backlog.ready).some((g) => g.key === "RS-37"));
  assert.ok(groupByEpic(lists.backlog.needsDef).some((g) => g.key === "RS-37"));

  const both: NavState = {
    ...onBacklog(),
    collapsed: new Set(["ready:RS-37", "needsDef:RS-37"]),
  };
  const s = navReduce(both, { type: "goTo", ref: readyRs37.ref }, ctx);
  assert.equal(s.collapsed.has("ready:RS-37"), false);
  assert.equal(s.collapsed.has("needsDef:RS-37"), true);

  const t = navReduce(both, { type: "goTo", ref: needsDefRs37.ref }, ctx);
  assert.equal(t.collapsed.has("needsDef:RS-37"), false);
  assert.equal(t.collapsed.has("ready:RS-37"), true);
});

test("back makes its target visible the same way goTo does", () => {
  const walked = run(
    onBacklog(),
    { type: "select", ref: "RS-160" },
    { type: "goTo", ref: "RS-184" },
  );
  const hidden: NavState = {
    ...walked,
    query: "zzz",
    collapsed: new Set(["ready:RS-37"]),
  };
  const s = navReduce(hidden, { type: "back" }, ctx);
  assert.equal(s.current, "RS-160");
  assert.equal(s.query, "");
  assert.equal(s.collapsed.has("ready:RS-37"), false);
});

test("select leaves the filter and the collapsed groups alone", () => {
  const start: NavState = {
    ...onBacklog(),
    query: "cat",
    collapsed: new Set(["ready:RS-37"]),
  };
  const s = navReduce(start, { type: "select", ref: "RS-160" }, ctx);
  assert.equal(s.query, "cat");
  assert.equal(s.collapsed.has("ready:RS-37"), true);
  assert.equal(s.scrollNonce, start.scrollNonce);
});

test("toggleGroup flips one key; showTab and resetGroups reopen every group", () => {
  const a = navReduce(onBacklog(), { type: "toggleGroup", zone: "ready", root: "RS-37" }, ctx);
  assert.deepEqual([...a.collapsed], ["ready:RS-37"]);
  const b = navReduce(a, { type: "toggleGroup", zone: "ready", root: "RS-37" }, ctx);
  assert.equal(b.collapsed.size, 0);
  const c = navReduce(a, { type: "resetGroups" }, ctx);
  assert.equal(c.collapsed.size, 0);
  const d = navReduce(a, { type: "showTab", tab: "done" }, ctx);
  assert.equal(d.collapsed.size, 0);
  assert.equal(a.collapsed.size, 1);
});

test("showTab keeps the selection, drops the linked ref, and leaves the query", () => {
  const linked = run(
    onBacklog(),
    { type: "select", ref: "RS-160" },
    { type: "goTo", ref: "RS-184" },
    { type: "setQuery", query: "cat" },
  );
  assert.equal(linked.query, "cat");
  const s = navReduce(linked, { type: "showTab", tab: "done" }, ctx);
  assert.equal(s.tab, "done");
  assert.equal(s.linkedRef, null);
  assert.equal(s.current, "RS-184");
  assert.deepEqual(s.trail, ["RS-160"]);
  assert.equal(s.query, "cat");
});

test("selecting resets the trail; closing clears the column", () => {
  const walked = run(
    onBacklog(),
    { type: "select", ref: "RS-160" },
    { type: "goTo", ref: "RS-184" },
  );
  assert.deepEqual(walked.trail, ["RS-160"]);
  const s = navReduce(walked, { type: "select", ref: "RS-193" }, ctx);
  assert.deepEqual(s.trail, []);
  assert.equal(s.cameFrom, null);
  const c = navReduce(walked, { type: "close" }, ctx);
  assert.equal(c.current, null);
  assert.equal(c.cameFrom, null);
  assert.deepEqual(c.trail, []);
});

test("goTo the item already open does not push the trail", () => {
  const a = run(onBacklog(), { type: "select", ref: "RS-160" });
  const b = navReduce(a, { type: "goTo", ref: "RS-160" }, ctx);
  assert.deepEqual(b.trail, []);
  assert.equal(b.cameFrom, "RS-160");
  // ...but it still asks for a scroll, so the jump lands visible.
  assert.equal(b.scrollNonce, a.scrollNonce + 1);
});

test("scrollNonce moves on goTo and back, never on a direct click", () => {
  const a = run(onBacklog(), { type: "select", ref: "RS-160" });
  assert.equal(a.scrollNonce, 0);
  const b = navReduce(a, { type: "goTo", ref: "RS-184" }, ctx);
  assert.equal(b.scrollNonce, 1);
  const c = navReduce(b, { type: "back" }, ctx);
  assert.equal(c.scrollNonce, 2);
  const d = navReduce(c, { type: "select", ref: "RS-193" }, ctx);
  assert.equal(d.scrollNonce, 2);
  const e = navReduce(d, { type: "setQuery", query: "x" }, ctx);
  assert.equal(e.scrollNonce, 2);
});
