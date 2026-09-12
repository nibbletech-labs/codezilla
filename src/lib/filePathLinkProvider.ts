import type { Terminal, ILinkProvider, ILink, IBuffer } from "@xterm/xterm";
import { parsePathCandidates, type ParsedPath } from "./parsePaths.ts";

// Positive-result cache for disk-existence checks: once a path is confirmed to
// exist we remember it so re-hovering the same line doesn't re-issue IPC. Only
// `true` is cached — a path that doesn't exist yet is re-checked on the next
// hover, so a file created after a miss becomes clickable without a TTL.
const existsCache = new Set<string>();

export function createFilePathLinkProviderForTerminal(
  terminal: Terminal,
  projectPath: string,
  callbacks: {
    onSelect: (resolvedPath: string) => void;
    onPreview: (resolvedPath: string, line?: number, col?: number) => void;
    onMultipleMatches: (candidates: string[], position: { x: number; y: number }, line?: number, col?: number) => void;
    onShowMenu: (resolvedPath: string, position: { x: number; y: number }, line?: number, col?: number) => void;
  },
  dependencies: {
    getFileIndex: () => Set<string>;
    pathExists: (path: string) => Promise<boolean>;
  },
): ILinkProvider {
  const pendingChecks = new Map<string, Promise<boolean>>();
  const exists = (path: string): Promise<boolean> => {
    if (existsCache.has(path)) return Promise.resolve(true);
    const pending = pendingChecks.get(path);
    if (pending) return pending;
    const check = dependencies.pathExists(path).then((found) => {
      if (found) existsCache.add(path);
      return found;
    }).catch(() => false).finally(() => pendingChecks.delete(path));
    pendingChecks.set(path, check);
    return check;
  };

  const toLink = (p: ParsedPath, line: WrappedLine): ILink => ({
    range: {
      start: line.starts[p.startCol],
      end: line.ends[p.endCol - 1],
    },
    text: line.text.slice(p.startCol, p.endCol),
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
        // Cmd+click: highlight in tree + open preview directly
        callbacks.onSelect(p.resolved);
        callbacks.onPreview(p.resolved, p.line, p.col);
      } else {
        // Plain click: show context menu
        callbacks.onShowMenu(p.resolved, { x: event.clientX, y: event.clientY }, p.line, p.col);
      }
    },
  });

  return {
    provideLinks(
      bufferLineNumber: number,
      callback: (links: ILink[] | undefined) => void,
    ) {
      const buffer = terminal.buffer.active;
      const line = readWrappedLine(buffer, bufferLineNumber);
      if (!line) {
        callback(undefined);
        return;
      }

      const fileIndex = dependencies.getFileIndex();

      const emit = (paths: ParsedPath[]) =>
        callback(paths.length > 0 ? paths.map((p) => toLink(p, line)).filter(({ range }) =>
          range.start.y <= bufferLineNumber && range.end.y >= bufferLineNumber) : undefined);

      // Fast path: matches that resolve against the file index (sync, no IPC).
      const { resolved, unresolved: candidates } = parsePathCandidates(line.text, projectPath, fileIndex);

      // Fallback: syntactically-valid paths the index doesn't know about (just
      // created, or gitignored). Verify each on disk and link the ones that
      // exist, so a path is clickable whenever the file is really there.
      const cached = candidates.filter((c) => existsCache.has(c.resolved));
      const unchecked = candidates.filter((c) => !existsCache.has(c.resolved));
      if (unchecked.length === 0) {
        emit([...resolved, ...cached]);
        return;
      }

      void (async () => {
        const results = await Promise.all(unchecked.map((c) => exists(c.resolved)));
        // Output can replace a row while IPC is in flight. Never publish links
        // whose ranges now refer to different text.
        if (terminal.buffer.active !== buffer || readWrappedLine(buffer, bufferLineNumber)?.snapshot !== line.snapshot) {
          callback(undefined);
          return;
        }
        emit([...resolved, ...cached, ...unchecked.filter((_, i) => results[i])]);
      })();
    },
  };
}

interface WrappedLine {
  text: string;
  starts: { x: number; y: number }[];
  ends: { x: number; y: number }[];
  snapshot: string;
}

/** Reassemble soft wraps only; actual newlines still separate paths. */
function readWrappedLine(buffer: IBuffer, row: number): WrappedLine | undefined {
  let first = row - 1;
  let line = buffer.getLine(first);
  if (!line) return;
  while (first > 0 && line.isWrapped) {
    const previous = buffer.getLine(first - 1);
    if (!previous) break;
    line = previous;
    first--;
  }

  const result: WrappedLine = { text: "", starts: [], ends: [], snapshot: "" };
  const rows = [];
  for (let y = first; line; y++) {
    const next = buffer.getLine(y + 1);
    const continues = !!next?.isWrapped;
    let text = line.translateToString(!continues);
    // xterm leaves an empty cell when a wide character wraps early. It isn't
    // part of the text, unlike an actual trailing space in a directory name.
    if (continues && line.getCell(line.length - 1)?.getChars() === "" && next?.getCell(0)?.getWidth() === 2) {
      text = text.slice(0, -1);
    }
    rows.push([y, line.isWrapped, line.length, text]);
    let offset = 0;
    for (let x = 0; x < line.length && offset < text.length; x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      // Regex offsets use UTF-16 characters; hitboxes use terminal cells.
      const length = Math.min(cell.getChars().length || 1, text.length - offset);
      for (let i = 0; i < length; i++) {
        result.starts.push({ x: x + 1, y: y + 1 });
        result.ends.push({ x: x + cell.getWidth(), y: y + 1 });
      }
      offset += length;
    }
    result.text += text;
    if (!continues) break;
    line = next!;
  }
  // Include row boundaries and cell coordinates so output and reflow invalidate
  // in-flight disk checks even if the concatenated path text stays the same.
  result.snapshot = JSON.stringify([rows, result.starts, result.ends]);
  return result;
}
