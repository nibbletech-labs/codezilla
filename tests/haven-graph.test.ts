import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  bucketView,
  deriveView,
  parseHavenTimestamp,
  tabCounts,
  unmetBlockers,
} from "../src/lib/havenGraph.ts";
import type { HavenGraphLike } from "../src/lib/havenTypes.ts";

const FIXTURES = path.join(
  import.meta.dirname,
  "../src-tauri/tests/fixtures/haven",
);

/**
 * The instant every fixture count is pinned at. The r13 mockup rendered its
 * counts with `Date.now()`, not with the capture's `pulled` stamp (20:00Z),
 * which is why Done is 168 here and 169 at `pulled`.
 */
const FIXTURE_NOW = Date.parse("2026-09-07T23:00:00Z");

// Read, never `import` — keeping 1.7 MB of JSON out of tsc's module graph.
function readFixture(name: string): any {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));
}
const raw = (): HavenGraphLike => readFixture("retrostack-2026-09-07.raw.json");
const derived = () => readFixture("retrostack-2026-09-07.json");

test("derivation of the raw fixture equals the derived fixture", () => {
  const out = deriveView(raw());
  const want = derived();
  assert.equal(out.items.length, 1041);
  assert.deepEqual(out.items, want.items);
  assert.deepEqual(out.deps, want.deps);
  assert.equal(out.project, "retrostack");
  assert.equal(out.prefix, "RS");
  // `pulled` is a CLI argument of the reference script, not a derivation.
  assert.equal("pulled" in (out as object), false);
  // Exactly the fourteen keys derive-view.py writes — no extras on the items.
  assert.deepEqual(Object.keys(out.items[0]).sort(), [
    "committed", "dll", "owner", "parents", "priority", "ref", "root",
    "rt", "status", "title", "type", "upd", "wait", "why",
  ]);
});

test("primary root: decomposition beats grouping, lowest ref breaks ties, cycles stop", () => {
  // Seven synthetic nodes, one per §7 rule.
  const g: HavenGraphLike = {
    project: "syn",
    nodes: [
      { ref: "RS-100", title: "Epic One" },
      { ref: "RS-101", title: "Decomposition wins" },
      { ref: "RS-102", title: "Mid" },
      { ref: "RS-103", title: "Tie break" },
      { ref: "RS-104", title: "Cycle A" },
      { ref: "RS-105", title: "Cycle B" },
      { ref: "RS-106", title: "Absent parent" },
    ],
    edges: [
      // RS-101 has both kinds of parent; decomposition wins even though the
      // grouping parent has the lower ref number.
      { from: "RS-100", kind: "grouping", to: "RS-101" },
      { from: "RS-102", kind: "decomposition", to: "RS-101" },
      { from: "RS-100", kind: "decomposition", to: "RS-102" },
      // Two parents of the same kind: the lower ref number wins.
      { from: "RS-102", kind: "grouping", to: "RS-103" },
      { from: "RS-100", kind: "grouping", to: "RS-103" },
      // A two-cycle: the walk stops at the last unvisited node.
      { from: "RS-105", kind: "grouping", to: "RS-104" },
      { from: "RS-104", kind: "grouping", to: "RS-105" },
      // A parent that is not in the graph at all. derive-view.py would raise a
      // KeyError here; the app must be tolerant and simply report no title.
      { from: "RS-800", kind: "decomposition", to: "RS-106" },
    ],
  };
  const by = new Map(deriveView(g).items.map((i) => [i.ref, i]));

  // Top-level: no parents, so no root.
  assert.equal(by.get("RS-100")!.root, null);
  assert.equal(by.get("RS-100")!.rt, null);
  // Decomposition beats grouping, then the chain runs up to the epic.
  assert.equal(by.get("RS-101")!.root, "RS-100");
  assert.equal(by.get("RS-101")!.rt, "Epic One");
  assert.deepEqual(by.get("RS-101")!.parents, [
    { ref: "RS-100", kind: "grouping" },
    { ref: "RS-102", kind: "decomposition" },
  ]);
  // Same kind, lower ref number wins (RS-100 over RS-102).
  assert.equal(by.get("RS-103")!.root, "RS-100");
  // Cycles stop on the visited set rather than spinning.
  assert.equal(by.get("RS-104")!.root, "RS-105");
  assert.equal(by.get("RS-105")!.root, "RS-104");
  // A parent outside the graph is still the root; it just has no title.
  assert.equal(by.get("RS-106")!.root, "RS-800");
  assert.equal(by.get("RS-106")!.rt, null);
  assert.equal(deriveView(g).prefix, "RS");
});

test("why and dll are cut at 220/230 and \"\" when absent", () => {
  const g: HavenGraphLike = {
    nodes: [
      { ref: "RS-1", why: "w".repeat(400), done_looks_like: "d".repeat(400) },
      { ref: "RS-2" },
    ],
    edges: [],
  };
  const [long, bare] = deriveView(g).items;
  assert.equal(long.why.length, 220);
  assert.equal(long.dll.length, 230);
  assert.equal(bare.why, "");
  assert.equal(bare.dll, "");
});

test("buckets on the fixture", () => {
  const view = deriveView(raw());
  const b = bucketView(view, FIXTURE_NOW);
  assert.equal(b.moving.length, 8);
  assert.equal(b.you.length, 16);
  assert.equal(b.stuck.length, 5);
  assert.equal(b.cantGo.length, 4);
  assert.equal(b.ready.length, 68);
  assert.equal(b.needsDef.length, 21);
  assert.equal(b.done.length, 168);
  assert.equal(b.live, 29);
  assert.deepEqual(tabCounts(b), {
    inFlight: 29,
    blocked: 4,
    backlog: 89,
    done: 168,
  });

  // §5's coverage claim: every committed live item is on exactly one tab.
  const DEAD = new Set(["done", "archived", "superseded"]);
  const tabs = [b.moving, b.you, b.stuck, b.cantGo, b.ready, b.needsDef];
  const counted = new Map<string, number>();
  for (const bucket of tabs)
    for (const i of bucket) counted.set(i.ref, (counted.get(i.ref) ?? 0) + 1);
  for (const i of view.items) {
    if (i.committed && !DEAD.has(String(i.status))) {
      assert.equal(counted.get(i.ref), 1, `${i.ref} should be on exactly one tab`);
    }
  }
  assert.equal([...counted.values()].every((n) => n === 1), true);
  assert.equal(counted.size, 122);

  // "On you" never holds finished work.
  assert.equal(b.you.some((i) => DEAD.has(String(i.status))), false);
});

test("an item with no updated_at is never Done", () => {
  const g: HavenGraphLike = {
    nodes: [
      { ref: "RS-1", status: "done" },
      { ref: "RS-2", status: "done", updated_at: "2026-09-07 12:00:00" },
    ],
    edges: [],
  };
  const b = bucketView(deriveView(g), FIXTURE_NOW);
  assert.deepEqual(b.done.map((i) => i.ref), ["RS-2"]);
});

test("timestamps parse as UTC", () => {
  assert.equal(
    parseHavenTimestamp("2026-09-07 23:37:14"),
    Date.parse("2026-09-07T23:37:14Z"),
  );
  assert.equal(parseHavenTimestamp(null), null);
  assert.equal(parseHavenTimestamp(""), null);
  assert.equal(parseHavenTimestamp("not a date"), null);
  assert.equal(parseHavenTimestamp(undefined), null);
});

test("dependency maps on the fixture", () => {
  const view = deriveView(raw());
  const want = derived();

  assert.deepEqual(view.requiredBy.get("RS-160"), [
    "RS-156", "RS-157", "RS-158", "RS-183", "RS-184",
  ]);
  assert.deepEqual(view.dependsOn.get("RS-160"), ["RS-169", "RS-193"]);
  assert.equal(view.dependsOn.size, 319);
  assert.equal(view.requiredBy.size, 315);

  // Between them the two maps cover exactly the refs the deps mention.
  const refsInDeps = new Set<string>();
  for (const d of want.deps) {
    refsInDeps.add(d.src);
    refsInDeps.add(d.dst);
  }
  assert.deepEqual(
    new Set([...view.dependsOn.keys(), ...view.requiredBy.keys()]),
    refsInDeps,
  );
  assert.equal(refsInDeps.size, 452);

  // An item with no dependency edge at all is in neither map.
  const loner = view.items.find(
    (i) => !view.dependsOn.has(i.ref) && !view.requiredBy.has(i.ref),
  )!;
  assert.ok(loner);
  assert.equal(refsInDeps.has(loner.ref), false);

  // The cleared-blocker primitive CZ-47 reads (§9: "all tracked dependencies
  // are complete - still marked blocked"). Of the five Stuck items, RS-606 and
  // only RS-606 has nothing unfinished left to wait for; the other four each
  // have at least one blocker still open.
  const stuck = bucketView(view, FIXTURE_NOW).stuck.map((i) => i.ref);
  assert.deepEqual(stuck.slice().sort(), [
    "RS-606", "RS-746", "RS-805", "RS-811", "RS-905",
  ]);
  assert.deepEqual(
    stuck.filter((ref) => unmetBlockers(view, ref).length === 0),
    ["RS-606"],
  );
  assert.deepEqual(unmetBlockers(view, "RS-606"), []);
  assert.deepEqual(view.dependsOn.get("RS-606"), ["RS-603"]);
  assert.equal(view.byRef.get("RS-603")!.status, "done");
  for (const ref of ["RS-905", "RS-746", "RS-805", "RS-811"]) {
    assert.ok(
      unmetBlockers(view, ref).length > 0,
      `${ref} should still be waiting on tracked work`,
    );
  }
});

test("edge-only edit changes the derived view with no revision change", () => {
  // §2: edge operations never bump `revision`, so the view must be recomputed
  // from the whole graph on every read, never gated on a revision diff.
  const g = raw();
  const gPrime = raw();
  gPrime.edges!.push({ from: "RS-184", kind: "dependency", to: "RS-37" });
  assert.equal(JSON.stringify(g.nodes), JSON.stringify(gPrime.nodes));

  const view = deriveView(g);
  const next = deriveView(gPrime);
  assert.equal(next.deps.length, view.deps.length + 1);
  assert.equal(view.requiredBy.get("RS-37"), undefined);
  assert.deepEqual(next.requiredBy.get("RS-37"), ["RS-184"]);
  assert.deepEqual(view.dependsOn.get("RS-184"), ["RS-160", "RS-209"]);
  assert.equal(next.dependsOn.get("RS-184")!.length, 3);
  assert.ok(next.dependsOn.get("RS-184")!.includes("RS-37"));
  assert.notEqual(view, next);
});

test("completing a blocker changes the dependent's derived state", () => {
  const graph = (): HavenGraphLike => ({
    nodes: [
      { ref: "RS-1", status: "blocked", owner_kind: "ai", revision: 7 },
      { ref: "RS-2", status: "ready", revision: 3 },
    ],
    edges: [{ from: "RS-1", kind: "dependency", to: "RS-2" }],
  });
  const before = deriveView(graph());
  assert.deepEqual(unmetBlockers(before, "RS-1"), ["RS-2"]);

  // Only the blocker changes; RS-1 is untouched and keeps revision 7.
  const g2 = graph();
  g2.nodes![1].status = "done";
  assert.equal(g2.nodes![0].revision, 7);
  const after = deriveView(g2);
  assert.deepEqual(unmetBlockers(after, "RS-1"), []);
  // A fresh Map per read — never reused across reads.
  assert.notEqual(after.byRef, before.byRef);
  // A dependency pointing at a node that isn't in the graph stays unmet.
  assert.deepEqual(unmetBlockers(deriveView({
    nodes: [{ ref: "RS-1" }],
    edges: [{ from: "RS-1", kind: "dependency", to: "RS-9" }],
  }), "RS-1"), ["RS-9"]);
});

test("deriveView over the raw fixture is fast enough for the 1 s clause", () => {
  const g = raw();
  const started = performance.now();
  const view = deriveView(g);
  const elapsed = performance.now() - started;
  assert.equal(view.items.length, 1041);
  // Generous: measured cost is single-digit ms. The bound exists to catch an
  // accidental O(n2) walk, not to be tight.
  assert.ok(elapsed < 150, `deriveView took ${elapsed.toFixed(1)}ms`);
});
