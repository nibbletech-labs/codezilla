import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chooserSections,
  folderNameOf,
  linkedKeysOf,
  linkedLineSegments,
  showBacklogRow,
  takenByOthers,
} from "../src/lib/havenBinding.ts";

// --- CZ-99: the repo file is the binding -------------------------------------

test("showBacklogRow: no haven binary means no row at all", () => {
  assert.equal(showBacklogRow(null, "codezilla"), false);
  assert.equal(showBacklogRow(null, null), false);
  assert.equal(showBacklogRow(false, "codezilla"), false);
  assert.equal(showBacklogRow(false, undefined), false);
});

test("showBacklogRow: installed but unbound shows nothing either", () => {
  // Unbound projects get no sidebar affordance at all — linking lives on the
  // project page.
  assert.equal(showBacklogRow(true, null), false);
  assert.equal(showBacklogRow(true, undefined), false);
  assert.equal(showBacklogRow(true, ""), false);
  assert.equal(showBacklogRow(true, "codezilla"), true);
});

test("linkedKeysOf reads the bindings map, deduped, in insertion order", () => {
  assert.deepEqual(
    linkedKeysOf({ a: "retrostack", b: null, c: "codezilla", d: "", e: "retrostack" }),
    ["retrostack", "codezilla"],
  );
  assert.deepEqual(linkedKeysOf({}), []);
  assert.deepEqual(linkedKeysOf({ a: null }), []);
});

test("folderNameOf takes the last real path segment", () => {
  assert.equal(folderNameOf("/Users/tom/Local_Projects/codezilla"), "codezilla");
  assert.equal(folderNameOf("/Users/tom/Local_Projects/codezilla/"), "codezilla");
  assert.equal(folderNameOf("/"), "");
  assert.equal(folderNameOf(""), "");
});

test("takenByOthers names the other Codezilla project holding each key", () => {
  const projects = [
    { id: "p1", name: "retrostack" },
    { id: "p2", name: "haven" },
    { id: "p3", name: "codezilla" },
  ];
  const bindings = { p1: "retrostack", p2: "haven", p3: null };
  assert.deepEqual(takenByOthers(projects, bindings, "p3"), {
    retrostack: "retrostack",
    haven: "haven",
  });
  // A project never reports its own key as taken.
  assert.deepEqual(takenByOthers(projects, bindings, "p1"), { haven: "haven" });
  // Two projects on one key: the first wins.
  assert.deepEqual(
    takenByOthers(
      [...projects, { id: "p4", name: "retrostack copy" }],
      { ...bindings, p4: "retrostack" },
      "p3",
    ).retrostack,
    "retrostack",
  );
});

const HAVEN_PROJECTS = [
  { key: "codezilla", title: "Codezilla" },
  { key: "haven", title: "haven" },
  { key: "retrostack", title: "RetroStack" },
  { key: "heed", title: "Heed" },
  { key: "dsm", title: "Design System Manager — Tokens" },
  { key: "article-to-video", title: "Article-to-Video Pipeline" },
];

test("chooserSections: free alphabetically, taken after, folder match highlighted", () => {
  const takenBy = { retrostack: "retrostack", haven: "haven" };
  const s = chooserSections(HAVEN_PROJECTS, takenBy, "codezilla");
  assert.deepEqual(
    s.free.map((p) => p.key),
    ["article-to-video", "codezilla", "dsm", "heed"],
  );
  assert.deepEqual(
    s.taken.map((t) => [t.project.key, t.boundBy]),
    [
      ["haven", "haven"],
      ["retrostack", "retrostack"],
    ],
  );
  // Keyboard order is exactly what the DOM renders: free, then taken.
  assert.deepEqual(
    s.ordered.map((p) => p.key),
    ["article-to-video", "codezilla", "dsm", "heed", "haven", "retrostack"],
  );
  assert.equal(s.highlightKey, "codezilla");
});

test("chooserSections: no folder match highlights the first row", () => {
  const s = chooserSections(HAVEN_PROJECTS, {}, "nothing-like-this");
  assert.equal(s.highlightKey, "article-to-video");
  assert.equal(s.highlightKey, s.ordered[0].key);
});

test("chooserSections: every project taken still highlights the first row", () => {
  const takenBy = Object.fromEntries(HAVEN_PROJECTS.map((p) => [p.key, "someone"]));
  const s = chooserSections(HAVEN_PROJECTS, takenBy, "codezilla");
  assert.equal(s.free.length, 0);
  assert.equal(s.taken.length, 6);
  assert.equal(s.highlightKey, s.ordered[0].key);
  // A taken key is never the folder-match highlight — it is only the fallback.
  assert.equal(s.highlightKey, "article-to-video");
});

test("chooserSections: an empty list has nothing to highlight", () => {
  assert.deepEqual(chooserSections([], {}, "codezilla"), {
    free: [],
    taken: [],
    ordered: [],
    highlightKey: null,
  });
});

test("chooserSections: a null title sorts by key and never renders \"null\"", () => {
  const s = chooserSections(
    [
      { key: "zebra", title: null },
      { key: "alpha", title: null },
      { key: "codezilla", title: "Codezilla" },
    ],
    {},
    "codezilla",
  );
  assert.deepEqual(
    s.ordered.map((p) => p.key),
    ["alpha", "codezilla", "zebra"],
  );
  assert.ok(!s.ordered.some((p) => String(p.title) === "null" && p.title !== null));
});

test("linkedLineSegments reads as the mockup's line", () => {
  assert.equal(
    linkedLineSegments("RetroStack", "RS", 29, 68).join(" · "),
    "RetroStack · RS · 29 live · 68 ready",
  );
  assert.equal(linkedLineSegments("RetroStack", "RS", 29, 68).length, 4);
  // No prefix — the segment is omitted, not rendered blank.
  assert.equal(
    linkedLineSegments("codezilla", null, null, null).join(" · "),
    "codezilla · — live · — ready",
  );
  assert.equal(linkedLineSegments("codezilla", null, null, null).length, 3);
  // Zero is a count, not a dash.
  assert.equal(
    linkedLineSegments("Heed", "HD", 0, 0).join(" · "),
    "Heed · HD · 0 live · 0 ready",
  );
});
