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

export function parsePaths(
  lineText: string,
  projectPath: string,
  fileIndex: Set<string>,
): ParsedPath[] {
  const results: ParsedPath[] = [];
  const root = projectPath.endsWith("/") ? projectPath : projectPath + "/";

  // Track matched character ranges to avoid overlapping bare-filename matches
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

    // If the full capture didn't resolve, it may have a leading prose word glued
    // on (e.g. "Reading src/foo.ts"). Retry on the trimmed path and shift the
    // link's start column to the real path so the underline excludes the word.
    if (!resolved) {
      const trimmed = stripLeadingWords(rawPath);
      if (trimmed !== rawPath) {
        const retry = resolveAgainstIndex(trimmed, root, fileIndex);
        if (retry.resolved) {
          resolved = retry.resolved;
          candidates = retry.candidates;
          const rawOffset = match[0].indexOf(rawPath);
          startCol =
            match.index + (rawOffset < 0 ? 0 : rawOffset) + (rawPath.length - trimmed.length);
        }
      }
    }

    if (resolved) {
      coveredRanges.push([startCol, endCol]);
      results.push({
        resolved,
        candidates: candidates.length > 0 ? candidates : [resolved],
        line: lineNum,
        col: colNum,
        startCol,
        endCol,
      });
    }
  }

  // Second pass: bare filenames (no directory separator)
  BARE_FILENAME_REGEX.lastIndex = 0;

  while ((match = BARE_FILENAME_REGEX.exec(lineText)) !== null) {
    const start = match.index;
    const end = start + match[0].length;

    // Skip if overlapping with an already-matched path
    if (coveredRanges.some(([s, e]) => start < e && end > s)) continue;

    const filename = match[1];
    const lineNum = match[2] ? parseInt(match[2], 10) : undefined;
    const colNum = match[3] ? parseInt(match[3], 10) : undefined;

    const candidates = findByFilename(filename, fileIndex);
    if (candidates.length > 0) {
      results.push({
        resolved: candidates[0],
        candidates,
        line: lineNum,
        col: colNum,
        startCol: start,
        endCol: end,
      });
    }
  }

  return results;
}
