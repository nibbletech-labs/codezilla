import type { Terminal, ILinkProvider, ILink, IBufferLine } from "@xterm/xterm";

// Matches 7-12 hex char sequences that look like short commit hashes.
const COMMIT_HASH_REGEX = /\b([0-9a-f]{7,12})\b/g;

function isLikelyCommitHash(lineText: string, matchIndex: number, matchStr: string): boolean {
  // Skip if preceded by # (hex color) or 0x (hex literal)
  if (matchIndex > 0 && lineText[matchIndex - 1] === "#") return false;
  if (matchIndex > 1 && lineText.slice(matchIndex - 2, matchIndex).toLowerCase() === "0x") return false;

  // Skip if the match has a hyphen immediately adjacent (part of a UUID)
  const charBefore = matchIndex > 0 ? lineText[matchIndex - 1] : "";
  const charAfter = lineText[matchIndex + matchStr.length] ?? "";
  if (charBefore === "-" || charAfter === "-") return false;

  return true;
}

export function createCommitHashLinkProviderForTerminal(
  terminal: Terminal,
  callbacks: {
    onPreviewCommit: (hash: string) => void;
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

      const lineText = line.translateToString(false);
      const links: ILink[] = [];

      COMMIT_HASH_REGEX.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = COMMIT_HASH_REGEX.exec(lineText)) !== null) {
        const hashStr = match[1];
        if (!isLikelyCommitHash(lineText, match.index, hashStr)) continue;

        links.push({
          range: {
            start: { x: match.index + 1, y: bufferLineNumber },
            end: { x: match.index + hashStr.length, y: bufferLineNumber },
          },
          text: hashStr,
          decorations: {
            pointerCursor: true,
            underline: true,
          },
          activate: (_event: MouseEvent, text: string) => {
            callbacks.onPreviewCommit(text);
          },
        });
      }

      callback(links.length > 0 ? links : undefined);
    },
  };
}
