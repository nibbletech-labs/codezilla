import assert from "node:assert/strict";
import test from "node:test";
import { parsePaths, parseUnresolvedCandidates } from "../src/lib/parsePaths.ts";

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

// --- parseUnresolvedCandidates: disk-fallback candidates for paths the index
//     doesn't know about (just-created or gitignored files). ---

test("unresolved relative path becomes a root-relative disk candidate", () => {
  const r = parseUnresolvedCandidates("docs/new.md", PROJ, new Set());
  assert.equal(r.length, 1);
  assert.equal(r[0].resolved, "/proj/docs/new.md");
  assert.equal(r[0].candidates.length, 1);
  assert.equal(r[0].startCol, 0);
});

test("unresolved absolute path is kept verbatim", () => {
  const r = parseUnresolvedCandidates("/proj/docs/new.md", PROJ, new Set());
  assert.equal(r.length, 1);
  assert.equal(r[0].resolved, "/proj/docs/new.md");
});

test("an indexed path produces no unresolved candidate", () => {
  const r = parseUnresolvedCandidates("src/foo.ts", PROJ, new Set(["/proj/src/foo.ts"]));
  assert.deepEqual(r, []);
});

test("parsePaths and parseUnresolvedCandidates split the same line", () => {
  // Bare filenames (no slash) are matched individually, unlike slashed paths
  // which the space-in-segment regex can glue together. foo.ts is indexed,
  // bar.ts is not.
  const index = new Set(["/proj/foo.ts"]);
  const line = "edit foo.ts and bar.ts";
  assert.equal(parsePaths(line, PROJ, index).length, 1);
  const u = parseUnresolvedCandidates(line, PROJ, index);
  assert.equal(u.length, 1);
  assert.equal(u[0].resolved, "/proj/bar.ts");
});

test("leading-word trim applies to unresolved candidates", () => {
  const line = "Created docs/new.md";
  const r = parseUnresolvedCandidates(line, PROJ, new Set());
  assert.equal(r.length, 1);
  assert.equal(r[0].resolved, "/proj/docs/new.md");
  assert.equal(line.slice(r[0].startCol, r[0].endCol), "docs/new.md");
});

test(":line:col suffix is parsed on unresolved candidates", () => {
  const r = parseUnresolvedCandidates("docs/new.md:10:3", PROJ, new Set());
  assert.equal(r.length, 1);
  assert.equal(r[0].resolved, "/proj/docs/new.md");
  assert.equal(r[0].line, 10);
  assert.equal(r[0].col, 3);
});

test("bare filename not in the index becomes a root-level disk candidate", () => {
  const r = parseUnresolvedCandidates("see notes.md here", PROJ, new Set());
  assert.equal(r.length, 1);
  assert.equal(r[0].resolved, "/proj/notes.md");
});

test("no path-like text yields no unresolved candidates", () => {
  assert.deepEqual(parseUnresolvedCandidates("nothing path-like here", PROJ, new Set()), []);
});
