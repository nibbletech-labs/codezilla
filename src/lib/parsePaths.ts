export interface ParsedPath {
  resolved: string;
  candidates: string[];
  line?: number;
  col?: number;
  startCol: number;
  endCol: number;
}

// Matches relative paths (src/foo.ts), dotted (./foo.ts), absolute paths (/foo/bar.ts),
// paths with :line:col suffix, git diff prefixes (a/, b/), and quoted paths.
// Requires at least one "/" to avoid false positives on bare words.
// Supports spaces within directory segments (e.g. "01_Projects/Second Brain/file.md").
const FILE_PATH_REGEX =
  /(?:["'])?(?:[ab]\/)?(\/?(?:[\w._-]+(?:[ ][\w._-]+)*\/)+[\w._-]+(?:\.\w+)?)(?::(\d+)(?::(\d+))?)?(?:["'])?/g;

// Matches bare filenames like package.json, index.ts, README.md (no directory separator).
// Negative lookbehind avoids matching filenames already part of a path.
const BARE_FILENAME_REGEX =
  /(?<![\/\w])([\w][\w.-]*\.[\w]{1,10})(?::(\d+)(?::(\d+))?)?/g;

/** Search fileIndex for all files whose name matches the given bare filename. */
function findByFilename(filename: string, fileIndex: Set<string>): string[] {
  const suffix = "/" + filename;
  const matches: string[] = [];
  for (const p of fileIndex) {
    if (p.endsWith(suffix)) {
      matches.push(p);
    }
  }
  return matches.sort();
}

/** Resolve a single path string against the file index. Exact hit first
 *  (absolute, or relative-to-root), then a *suffix* match so that partial
 *  multi-segment paths like "CenterPanel/Terminal.tsx", and paths scoped to a
 *  different environment/worktree than the link provider's cwd, still resolve.
 *  Returns the best resolved absolute path plus all candidates (>1 feeds the
 *  multi-match picker). */
function resolveAgainstIndex(
  pathStr: string,
  root: string,
  fileIndex: Set<string>,
): { resolved: string | null; candidates: string[] } {
  // Exact resolution
  if (pathStr.startsWith("/")) {
    if (fileIndex.has(pathStr)) return { resolved: pathStr, candidates: [pathStr] };
  } else {
    const abs = root + pathStr;
    if (fileIndex.has(abs)) return { resolved: abs, candidates: [abs] };
  }

  // Suffix fallback — any indexed file whose path ends with "/" + pathStr.
  const suffix = "/" + (pathStr.startsWith("/") ? pathStr.slice(1) : pathStr);
  const matches: string[] = [];
  for (const p of fileIndex) {
    if (p.endsWith(suffix)) matches.push(p);
  }
  matches.sort();
  if (matches.length === 1) return { resolved: matches[0], candidates: [matches[0]] };
  if (matches.length > 1) return { resolved: matches[0], candidates: matches };
  return { resolved: null, candidates: [] };
}

/** FILE_PATH_REGEX allows spaces inside a directory segment (to support paths
 *  like "01_Projects/Second Brain/file.md"), which has the side effect of gluing
 *  a leading prose word onto a path: "M src/foo.ts", "Reading src/foo.ts",
 *  "Edit src/components/...". When the full capture doesn't resolve, drop the
 *  leading space-separated tokens that precede the first token containing a "/"
 *  and retry. Returns the path beginning at the first slash-bearing token, or
 *  the original string when there is nothing to trim. */
function stripLeadingWords(pathStr: string): string {
  if (!pathStr.includes(" ")) return pathStr;
  const tokens = pathStr.split(" ");
  const firstSlash = tokens.findIndex((t) => t.includes("/"));
  if (firstSlash <= 0) return pathStr;
  return tokens.slice(firstSlash).join(" ");
}

/** Single scan of a line, splitting matches into those that resolve against the
 *  file index (`resolved`) and syntactically-valid paths that do NOT
 *  (`unresolved`). The latter carry a concrete absolute path in `resolved` for
 *  a downstream on-disk existence check (relative -> root + path, absolute as
 *  is). The `resolved` list is identical to what the old single-pass parser
 *  produced — callers depending on index-only behaviour are unaffected. */
function scanLine(
  lineText: string,
  root: string,
  fileIndex: Set<string>,
): { resolved: ParsedPath[]; unresolved: ParsedPath[] } {
  const resolvedResults: ParsedPath[] = [];
  const unresolvedResults: ParsedPath[] = [];

  // Track matched character ranges to avoid overlapping bare-filename matches.
  // Only resolved (index) paths cover ranges — matching the original parser, and
  // safe because the bare-filename regex's `(?<![\/\w])` lookbehind already
  // prevents it matching inside any slashed path.
  const coveredRanges: [number, number][] = [];

  let match: RegExpExecArray | null;
  FILE_PATH_REGEX.lastIndex = 0;

  while ((match = FILE_PATH_REGEX.exec(lineText)) !== null) {
    const rawPath = match[1];
    const lineNum = match[2] ? parseInt(match[2], 10) : undefined;
    const colNum = match[3] ? parseInt(match[3], 10) : undefined;

    let { resolved, candidates } = resolveAgainstIndex(rawPath, root, fileIndex);
    let startCol = match.index;
    const endCol = match.index + match[0].length;

    // Concrete path + start column for the disk-fallback candidate, applying the
    // same leading-word trim used for the index retry below.
    let candidatePath = rawPath;
    let candidateStart = startCol;

    // If the full capture didn't resolve, it may have a leading prose word glued
    // on (e.g. "Reading src/foo.ts"). Retry on the trimmed path and shift the
    // link's start column to the real path so the underline excludes the word.
    if (!resolved) {
      const trimmed = stripLeadingWords(rawPath);
      if (trimmed !== rawPath) {
        const rawOffset = match[0].indexOf(rawPath);
        const adjStart =
          match.index + (rawOffset < 0 ? 0 : rawOffset) + (rawPath.length - trimmed.length);
        candidatePath = trimmed;
        candidateStart = adjStart;
        const retry = resolveAgainstIndex(trimmed, root, fileIndex);
        if (retry.resolved) {
          resolved = retry.resolved;
          candidates = retry.candidates;
          startCol = adjStart;
        }
      }
    }

    if (resolved) {
      coveredRanges.push([startCol, endCol]);
      resolvedResults.push({
        resolved,
        candidates: candidates.length > 0 ? candidates : [resolved],
        line: lineNum,
        col: colNum,
        startCol,
        endCol,
      });
    } else {
      const abs = candidatePath.startsWith("/") ? candidatePath : root + candidatePath;
      unresolvedResults.push({
        resolved: abs,
        candidates: [abs],
        line: lineNum,
        col: colNum,
        startCol: candidateStart,
        endCol,
      });
    }
  }

  // Second pass: bare filenames (no directory separator)
  BARE_FILENAME_REGEX.lastIndex = 0;

  while ((match = BARE_FILENAME_REGEX.exec(lineText)) !== null) {
    const start = match.index;
    const end = start + match[0].length;

    // Skip if overlapping with an already-matched (resolved) path
    if (coveredRanges.some(([s, e]) => start < e && end > s)) continue;

    const filename = match[1];
    const lineNum = match[2] ? parseInt(match[2], 10) : undefined;
    const colNum = match[3] ? parseInt(match[3], 10) : undefined;

    const candidates = findByFilename(filename, fileIndex);
    if (candidates.length > 0) {
      resolvedResults.push({
        resolved: candidates[0],
        candidates,
        line: lineNum,
        col: colNum,
        startCol: start,
        endCol: end,
      });
    } else {
      const abs = root + filename;
      unresolvedResults.push({
        resolved: abs,
        candidates: [abs],
        line: lineNum,
        col: colNum,
        startCol: start,
        endCol: end,
      });
    }
  }

  return { resolved: resolvedResults, unresolved: unresolvedResults };
}

function rootOf(projectPath: string): string {
  return projectPath.endsWith("/") ? projectPath : projectPath + "/";
}

/** Paths in the line that resolve against the file index. */
export function parsePaths(
  lineText: string,
  projectPath: string,
  fileIndex: Set<string>,
): ParsedPath[] {
  return scanLine(lineText, rootOf(projectPath), fileIndex).resolved;
}

/** Syntactically-valid paths in the line that do NOT resolve against the file
 *  index. Each carries a concrete absolute path (`resolved`) for the caller to
 *  verify on disk — the basis for making just-created or gitignored files (which
 *  the index excludes) clickable. */
export function parseUnresolvedCandidates(
  lineText: string,
  projectPath: string,
  fileIndex: Set<string>,
): ParsedPath[] {
  return scanLine(lineText, rootOf(projectPath), fileIndex).unresolved;
}
