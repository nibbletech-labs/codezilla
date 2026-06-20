import assert from "node:assert/strict";
import test from "node:test";
import { parsePaths } from "../src/lib/parsePaths.ts";

const PROJ = "/proj";

test("exact root-relative path resolves", () => {
  const r = parsePaths("src/foo.ts", PROJ, new Set(["/proj/src/foo.ts"]));
  assert.equal(r.length, 1);
  assert.equal(r[0].resolved, "/proj/src/foo.ts");
  assert.equal(r[0].startCol, 0);
});

test("absolute path that is indexed resolves", () => {
  const r = parsePaths("/proj/src/foo.ts", PROJ, new Set(["/proj/src/foo.ts"]));
  assert.equal(r.length, 1);
  assert.equal(r[0].resolved, "/proj/src/foo.ts");
});

test("partial multi-segment path resolves via suffix fallback (Change A)", () => {
  const r = parsePaths(
    "open CenterPanel/Terminal.tsx",
    PROJ,
    new Set(["/proj/src/components/CenterPanel/Terminal.tsx"]),
  );
  assert.equal(r.length, 1);
  assert.equal(r[0].resolved, "/proj/src/components/CenterPanel/Terminal.tsx");
});

test("leading-word 'Reading src/foo.ts' resolves and link starts at the path", () => {
  const line = "Reading src/foo.ts";
  const r = parsePaths(line, PROJ, new Set(["/proj/src/foo.ts"]));
  assert.equal(r.length, 1);
  assert.equal(r[0].resolved, "/proj/src/foo.ts");
  // startCol must skip the verb so the underline begins at "src", not "Reading"
  assert.equal(line.slice(r[0].startCol, r[0].endCol), "src/foo.ts");
});

test("git-status style 'M src/foo.ts' resolves", () => {
  const line = "M src/foo.ts";
  const r = parsePaths(line, PROJ, new Set(["/proj/src/foo.ts"]));
  assert.equal(r.length, 1);
  assert.equal(r[0].resolved, "/proj/src/foo.ts");
  assert.equal(line.slice(r[0].startCol, r[0].endCol), "src/foo.ts");
});

test("ambiguous partial path returns all candidates for the picker", () => {
  const r = parsePaths(
    "see utils/index.ts",
    PROJ,
    new Set(["/proj/a/utils/index.ts", "/proj/b/utils/index.ts"]),
  );
  assert.equal(r.length, 1);
  assert.equal(r[0].candidates.length, 2);
  assert.equal(r[0].resolved, "/proj/a/utils/index.ts"); // sorted first
});

test("legitimate spaced directory still resolves exactly (not over-trimmed)", () => {
  const r = parsePaths(
    "01_Projects/Second Brain/file.md",
    PROJ,
    new Set(["/proj/01_Projects/Second Brain/file.md"]),
  );
  assert.equal(r.length, 1);
  assert.equal(r[0].resolved, "/proj/01_Projects/Second Brain/file.md");
  assert.equal(r[0].startCol, 0);
});

test("bare filename resolves via suffix match", () => {
  const r = parsePaths("just package.json here", PROJ, new Set(["/proj/package.json"]));
  assert.equal(r.length, 1);
  assert.equal(r[0].resolved, "/proj/package.json");
});

test(":line:col suffix is parsed", () => {
  const r = parsePaths("src/foo.ts:42:7", PROJ, new Set(["/proj/src/foo.ts"]));
  assert.equal(r.length, 1);
  assert.equal(r[0].line, 42);
  assert.equal(r[0].col, 7);
});

test("no match returns empty", () => {
  assert.deepEqual(parsePaths("nothing path-like here", PROJ, new Set(["/proj/src/foo.ts"])), []);
});

test("a path not in the index does not resolve", () => {
  assert.deepEqual(parsePaths("src/missing.ts", PROJ, new Set(["/proj/src/foo.ts"])), []);
});
