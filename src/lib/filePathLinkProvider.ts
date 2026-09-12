import type { Terminal, ILinkProvider, ILink, IBufferLine } from "@xterm/xterm";
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

  const toLink = (p: ParsedPath, bufferLineNumber: number, lineText: string, line: IBufferLine): ILink => ({
    range: {
      start: { x: stringOffsetToCell(line, p.startCol) + 1, y: bufferLineNumber },
      end: { x: stringOffsetToCell(line, p.endCol), y: bufferLineNumber },
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
      const line: IBufferLine | undefined = buffer.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }

      const lineText = line.translateToString(true);
      const fileIndex = dependencies.getFileIndex();

      const emit = (paths: ParsedPath[]) =>
        callback(paths.length > 0 ? paths.map((p) => toLink(p, bufferLineNumber, lineText, line)) : undefined);

      // Fast path: matches that resolve against the file index (sync, no IPC).
      const { resolved, unresolved: candidates } = parsePathCandidates(lineText, projectPath, fileIndex);

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
        if (terminal.buffer.active !== buffer || buffer.getLine(bufferLineNumber - 1)?.translateToString(true) !== lineText) {
          callback(undefined);
          return;
        }
        emit([...resolved, ...cached, ...unchecked.filter((_, i) => results[i])]);
      })();
    },
  };
}

// Regex offsets count UTF-16 characters; xterm ranges count screen cells.
// Wide characters and combining marks before a path must not shift its hitbox.
function stringOffsetToCell(line: IBufferLine, offset: number): number {
  let stringIndex = 0;
  for (let cellIndex = 0; cellIndex < line.length; cellIndex++) {
    const cell = line.getCell(cellIndex);
    if (!cell || cell.getWidth() === 0) continue;
    if (stringIndex >= offset) return cellIndex;
    stringIndex += cell.getChars().length || 1;
  }
  return line.length;
}
