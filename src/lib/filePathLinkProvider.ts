import type { Terminal, ILinkProvider, ILink, IBufferLine } from "@xterm/xterm";
import { useAppStore } from "../store/appStore";
import { parsePaths } from "./parsePaths";

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
            // Cmd+click: highlight in tree + open preview directly
            callbacks.onSelect(p.resolved);
            callbacks.onPreview(p.resolved, p.line, p.col);
          } else {
            // Plain click: show context menu
            callbacks.onShowMenu(p.resolved, { x: event.clientX, y: event.clientY }, p.line, p.col);
          }
        },
      }));

      callback(links);
    },
  };
}
