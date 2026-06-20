/** Collapse hard-wrapped paragraph lines into continuous text.
 *  The user explicitly opted in by clicking "Copy as prose", so we
 *  aggressively strip leading whitespace and collapse single newlines.
 *  We only preserve breaks for: blank lines (paragraph separators),
 *  list/bullet markers, table rows (pipes), and separator rules.
 *
 *  Extracted from Terminal.tsx as a pure string->string function so it can be
 *  unit-tested (see tests/prose-copy.test.ts). */
export function collapseProseWraps(sel: string): string {
  // Strip a leading blockquote/gutter bar plus its trailing space, then strip
  // leading/trailing whitespace so collapsed joins always produce exactly one
  // space between words. The class covers the box-drawing verticals and the
  // full left-block family (U+2588..U+258F) that Claude Code / Codex render down
  // the left edge of quoted text — including ▎ (U+258E), the bar that the
  // previous class (which only had ▌ U+258C) missed. ASCII "|" is deliberately
  // left alone — that's a table pipe, handled separately below.
  const lines = sel
    .split("\n")
    .map((l) => l.replace(/^\s*[│┃┆┇┊┋╎╏█▉▊▋▌▍▎▏⎜⎢]\s?/, "").trim());

  const result: string[] = [lines[0]];
  for (let i = 1; i < lines.length; i++) {
    const prev = result[result.length - 1];
    const next = lines[i];
    // Preserve blank lines (paragraph breaks)
    if (next.length === 0 || prev.length === 0) {
      result.push(next);
      continue;
    }
    // Preserve list/bullet markers
    if (/^[-*•>]\s/.test(next) || /^\d+[.)]\s/.test(next)) {
      result.push(next);
      continue;
    }
    // Preserve table rows and separator rules
    if (prev.includes("|") || /^[\-=─━┄┈═~_│|+┃┊·•*#]{3,}$/.test(prev)) {
      result.push(next);
      continue;
    }
    // Collapse: join with space
    result[result.length - 1] = prev + " " + next;
  }
  return result.join("\n");
}
