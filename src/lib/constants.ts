export const TERMINAL_CONFIG = {
  fontSize: 14,
  fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
  cursorBlink: true,
  scrollback: 5000,
  allowProposedApi: true,
} as const;

export const TERMINAL_THEME = {
  background: "#1e1e1e",
  foreground: "#cccccc",
  cursor: "#ffffff",
  selectionBackground: "#264f78",
  black: "#1e1e1e",
  red: "#f44747",
  green: "#4ec9b0",
  yellow: "#dcdcaa",
  blue: "#569cd6",
  magenta: "#c586c0",
  cyan: "#9cdcfe",
  white: "#d4d4d4",
  brightBlack: "#808080",
  brightRed: "#f44747",
  brightGreen: "#4ec9b0",
  brightYellow: "#dcdcaa",
  brightBlue: "#569cd6",
  brightMagenta: "#c586c0",
  brightCyan: "#9cdcfe",
  brightWhite: "#ffffff",
} as const;

export const RESIZE_DEBOUNCE_MS = 100;

export const FONT_SIZE_DEFAULT = 14;
export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 22;
export const FONT_SIZE_STEP = 2;

export const PANEL_WIDTHS = {
  left: 250,
  right: 250,
} as const;

/** Left panel width scaled proportionally to font size (base: 250px at 14px). */
export function getLeftPanelWidth(fontSize: number): number {
  return Math.round(PANEL_WIDTHS.left * fontSize / FONT_SIZE_DEFAULT);
}
