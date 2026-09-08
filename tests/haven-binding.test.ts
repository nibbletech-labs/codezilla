import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backlogRowMode,
  linkedKeysOf,
  orderProjectsForPicker,
  pickerLabel,
} from "../src/lib/havenBinding.ts";

test("no haven binary means no backlog row at all", () => {
  // null = not checked yet, false = checked and absent. Neither shows a row.
  assert.equal(backlogRowMode(null, "codezilla"), "none");
  assert.equal(backlogRowMode(null, undefined), "none");
  assert.equal(backlogRowMode(false, "codezilla"), "none");
  assert.equal(backlogRowMode(false, undefined), "none");
});

test("installed but unlinked offers the Link to Haven button", () => {
  assert.equal(backlogRowMode(true, undefined), "link");
  // An empty key is not a binding.
  assert.equal(backlogRowMode(true, ""), "link");
});

test("installed and linked shows the Backlog row", () => {
  assert.equal(backlogRowMode(true, "codezilla"), "backlog");
});

test("the suggested project leads the picker, order otherwise untouched", () => {
  const projects = [
    { key: "codezilla" },
    { key: "heed" },
    { key: "retrostack" },
  ];
  assert.deepEqual(
    orderProjectsForPicker(projects, "retrostack").map((p) => p.key),
    ["retrostack", "codezilla", "heed"],
  );
  assert.deepEqual(
    orderProjectsForPicker(projects, null).map((p) => p.key),
    ["codezilla", "heed", "retrostack"],
  );
  assert.deepEqual(
    orderProjectsForPicker(projects, "nothing-like-this").map((p) => p.key),
    ["codezilla", "heed", "retrostack"],
  );
  assert.deepEqual(orderProjectsForPicker([], "retrostack"), []);
});

test("picker labels never render a missing title or prefix", () => {
  assert.equal(
    pickerLabel({ key: "retrostack", ref_prefix: "RS", title: "RetroStack" }),
    "RetroStack · RS",
  );
  assert.equal(
    pickerLabel({ key: "retrostack", ref_prefix: null, title: "RetroStack" }),
    "RetroStack",
  );
  assert.equal(
    pickerLabel({ key: "retrostack", ref_prefix: "RS", title: null }),
    "retrostack · RS",
  );
  const bare = pickerLabel({ key: "retrostack", ref_prefix: null, title: null });
  assert.equal(bare, "retrostack");
  assert.ok(!bare.includes("null"));
});

test("linkedKeysOf dedupes, ignores unlinked projects and keeps first-seen order", () => {
  assert.deepEqual(
    linkedKeysOf([
      { havenProjectKey: "retrostack" },
      { havenProjectKey: undefined },
      { havenProjectKey: "codezilla" },
      // An empty key is not a binding, and the same key twice is one project's
      // worth of reads, not two.
      { havenProjectKey: "" },
      { havenProjectKey: "retrostack" },
      {},
    ]),
    ["retrostack", "codezilla"],
  );
  assert.deepEqual(linkedKeysOf([]), []);
  assert.deepEqual(linkedKeysOf([{ havenProjectKey: undefined }]), []);
});
