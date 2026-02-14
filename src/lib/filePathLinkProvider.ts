import type { Terminal, ILinkProvider, ILink, IBufferLine } from "@xterm/xterm";
import { useAppStore } from "../store/appStore";

interface ParsedPath {
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
const FILE_PATH_REGEX =
  /(?:["'])?(?:[ab]\/)?(\/?(?:[\w._-]+\/)+[\w._-]+(?:\.\w+)?)(?::(\d+)(?::(\d+))?)?(?:["'])?/g;

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

    // Try to resolve the path
    let resolved: string | null = null;

    if (rawPath.startsWith("/")) {
      // Absolute path
      if (fileIndex.has(rawPath)) {
        resolved = rawPath;
      }
    } else {
      // Relative path — resolve against project root
      const abs = root + rawPath;
      if (fileIndex.has(abs)) {
        resolved = abs;
      }
    }

    if (resolved) {
      coveredRanges.push([match.index, match.index + match[0].length]);
      results.push({
        resolved,
        candidates: [resolved],
        line: lineNum,
        col: colNum,
        startCol: match.index,
        endCol: match.index + match[0].length,
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

export function createFilePathLinkProviderForTerminal(
  terminal: Terminal,
  projectPath: string,
  callbacks: {
    onSelect: (resolvedPath: string) => void;
    onPreview: (resolvedPath: string, line?: number, col?: number) => void;
    onMultipleMatches: (candidates: string[], position: { x: number; y: number }, line?: number, col?: number) => void;
  },
): ILinkProvider {
  return {
    provideLinks(
      bufferLineNumber: number,
      callback: (links: ILink[] | undefined) => void,
    ) {
      const buffer = terminal.buffer.active;
      const line: IBufferLine | undefined = buffer.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }

      const lineText = line.translateToString(true);
      const fileIndex = useAppStore.getState().fileIndex;

      if (fileIndex.size === 0) {
        callback(undefined);
        return;
      }

      const parsed = parsePaths(lineText, projectPath, fileIndex);

      if (parsed.length === 0) {
        callback(undefined);
        return;
      }

      const links: ILink[] = parsed.map((p) => ({
        range: {
          start: { x: p.startCol + 1, y: bufferLineNumber },
          end: { x: p.endCol, y: bufferLineNumber },
        },
        text: lineText.slice(p.startCol, p.endCol),
        decorations: {
          pointerCursor: true,
          underline: true,
        },
        activate: (event: MouseEvent, _text: string) => {
          const withModifier = event.metaKey || event.ctrlKey;

          if (p.candidates.length > 1) {
            // Multiple matches — show picker regardless of modifier
            callbacks.onMultipleMatches(p.candidates, { x: event.clientX, y: event.clientY }, p.line, p.col);
          } else if (withModifier) {
            // Cmd+click: highlight in tree + open preview
            callbacks.onSelect(p.resolved);
            callbacks.onPreview(p.resolved, p.line, p.col);
          } else {
            // Plain click: highlight in file tree only
            callbacks.onSelect(p.resolved);
          }
        },
      }));

      callback(links);
    },
  };
}
