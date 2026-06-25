import type { Terminal, ILinkProvider, ILink, IBufferLine } from "@xterm/xterm";
import { useAppStore } from "../store/appStore";
import { parsePaths, parseUnresolvedCandidates, type ParsedPath } from "./parsePaths";
import { pathExists } from "./tauri";

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
): ILinkProvider {
  const toLink = (p: ParsedPath, bufferLineNumber: number, lineText: string): ILink => ({
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
      const fileIndex = useAppStore.getState().fileIndex;

      const emit = (paths: ParsedPath[]) =>
        callback(paths.length > 0 ? paths.map((p) => toLink(p, bufferLineNumber, lineText)) : undefined);

      // Fast path: matches that resolve against the file index (sync, no IPC).
      const resolved = parsePaths(lineText, projectPath, fileIndex);

      // Fallback: syntactically-valid paths the index doesn't know about (just
      // created, or gitignored). Verify each on disk and link the ones that
      // exist, so a path is clickable whenever the file is really there.
      const candidates = parseUnresolvedCandidates(lineText, projectPath, fileIndex);
      if (candidates.length === 0) {
        emit(resolved);
        return;
      }

      void (async () => {
        const verified: ParsedPath[] = [];
        for (const c of candidates) {
          if (existsCache.has(c.resolved)) {
            verified.push(c);
            continue;
          }
          try {
            if (await pathExists(c.resolved)) {
              existsCache.add(c.resolved);
              verified.push(c);
            }
          } catch {
            // Treat a failed check as non-existent — no link.
          }
        }
        emit([...resolved, ...verified]);
      })();
    },
  };
}
