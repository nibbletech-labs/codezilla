import assert from "node:assert/strict";
import test from "node:test";
import { collapseProseWraps } from "../src/lib/proseCopy.ts";

// Regression guard for the reported bug: the left gutter bar Claude Code / Codex
// render is ▎ (U+258E LEFT ONE QUARTER BLOCK), which the old class (only ▌ U+258C)
// never matched, so it survived into the clipboard.
test("strips the U+258E ▎ left gutter bar (the reported bug)", () => {
  assert.equal(collapseProseWraps("▎ hello"), "hello");
});

test("strips every left-block glyph U+2588..U+258F", () => {
  for (const ch of ["█", "▉", "▊", "▋", "▌", "▍", "▎", "▏"]) {
    assert.equal(collapseProseWraps(`${ch} x`), "x", `failed for ${ch} (U+${ch.codePointAt(0)!.toString(16).toUpperCase()})`);
  }
});

test("strips box-drawing and dashed verticals", () => {
  for (const ch of ["│", "┃", "┆", "┇", "┊", "┋", "╎", "╏"]) {
    assert.equal(collapseProseWraps(`${ch} y`), "y", `failed for ${ch}`);
  }
});

test("leaves ASCII pipe table rows untouched", () => {
  assert.equal(collapseProseWraps("| a | b |\n| c | d |"), "| a | b |\n| c | d |");
});

test("collapses a wrapped ▎-quoted paragraph into one line", () => {
  const input = "▎ The quick brown\n▎ fox jumps over\n▎ the lazy dog";
  assert.equal(collapseProseWraps(input), "The quick brown fox jumps over the lazy dog");
});

test("preserves blank-line paragraph breaks and bullet markers under a ▎ gutter", () => {
  const input = "▎ intro line\n▎\n▎ - bullet one\n▎ - bullet two";
  assert.equal(collapseProseWraps(input), "intro line\n\n- bullet one\n- bullet two");
});

test("does not eat mid-line block chars (only the leading gutter is stripped)", () => {
  assert.equal(collapseProseWraps("progress █████ 80%"), "progress █████ 80%");
});

test("still strips the previously-handled ▌ half block", () => {
  assert.equal(collapseProseWraps("▌ kept working"), "kept working");
});
