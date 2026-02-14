export type AccentColorId = "blue" | "green" | "purple" | "orange" | "rose" | "teal" | "amber";
export type AppearanceMode = "dark" | "light" | "system";

export interface AccentColor {
  id: AccentColorId;
  label: string;
  value: string;
  selectionDark: string;
  selectionLight: string;
  textOnAccent: string;
}

export const ACCENT_COLORS: AccentColor[] = [
  { id: "green",  label: "Green",  value: "#C1FF72", selectionDark: "#3d5c14", selectionLight: "#e0ffb8", textOnAccent: "#1e1e1e" },
  { id: "blue",   label: "Blue",   value: "#007acc", selectionDark: "#094771", selectionLight: "#b4d7ef", textOnAccent: "#ffffff" },
  { id: "purple", label: "Purple", value: "#8b5cf6", selectionDark: "#3b1f7a", selectionLight: "#d4c4fb", textOnAccent: "#ffffff" },
  { id: "orange", label: "Orange", value: "#e97319", selectionDark: "#5c2d0a", selectionLight: "#f5d0a9", textOnAccent: "#ffffff" },
  { id: "rose",   label: "Rose",   value: "#e5446d", selectionDark: "#5c1a2b", selectionLight: "#f4b8c7", textOnAccent: "#ffffff" },
  { id: "teal",   label: "Teal",   value: "#14b8a6", selectionDark: "#083b35", selectionLight: "#b2ebe4", textOnAccent: "#ffffff" },
  { id: "amber",  label: "Amber",  value: "#f59e0b", selectionDark: "#5c3d04", selectionLight: "#fbe0a1", textOnAccent: "#ffffff" },
];

export interface Palette {
  bgPrimary: string;
  bgPanel: string;
  bgInput: string;
  bgHover: string;
  bgElevated: string;
  bgEmptyPlaceholder: string;
  textPrimary: string;
  textSecondary: string;
  textHeading: string;
  textHint: string;
  borderDefault: string;
  borderSubtle: string;
  borderMedium: string;
  kbdBg: string;
  kbdText: string;
  kbdBorder: string;
  diffInfoColor: string;
}

export const DARK_PALETTE: Palette = {
  bgPrimary: "#1e1e1e",
  bgPanel: "#252526",
  bgInput: "#3c3c3c",
  bgHover: "#2a2d2e",
  bgElevated: "#2d2d2d",
  bgEmptyPlaceholder: "#1a1a1a",
  textPrimary: "#cccccc",
  textSecondary: "#808080",
  textHeading: "#e0e0e0",
  textHint: "#555555",
  borderDefault: "#3c3c3c",
  borderSubtle: "#2d2d2d",
  borderMedium: "#555555",
  kbdBg: "#333333",
  kbdText: "#aaaaaa",
  kbdBorder: "#555555",
  diffInfoColor: "#569cd6",
};

export const LIGHT_PALETTE: Palette = {
  bgPrimary: "#ffffff",
  bgPanel: "#f3f3f3",
  bgInput: "#ffffff",
  bgHover: "#e8e8e8",
  bgElevated: "#f5f5f5",
  bgEmptyPlaceholder: "#fafafa",
  textPrimary: "#333333",
  textSecondary: "#717171",
  textHeading: "#1e1e1e",
  textHint: "#a0a0a0",
  borderDefault: "#d4d4d4",
  borderSubtle: "#e5e5e5",
  borderMedium: "#c0c0c0",
  kbdBg: "#e8e8e8",
  kbdText: "#555555",
  kbdBorder: "#c0c0c0",
  diffInfoColor: "#0451a5",
};

export function applyTheme(palette: Palette, accent: AccentColor, isDark: boolean): void {
  const root = document.documentElement;
  const sel = isDark ? accent.selectionDark : accent.selectionLight;

  root.style.setProperty("--bg-primary", palette.bgPrimary);
  root.style.setProperty("--bg-panel", palette.bgPanel);
  root.style.setProperty("--bg-input", palette.bgInput);
  root.style.setProperty("--bg-hover", palette.bgHover);
  root.style.setProperty("--bg-elevated", palette.bgElevated);
  root.style.setProperty("--bg-empty-placeholder", palette.bgEmptyPlaceholder);

  root.style.setProperty("--text-primary", palette.textPrimary);
  root.style.setProperty("--text-secondary", palette.textSecondary);
  root.style.setProperty("--text-heading", palette.textHeading);
  root.style.setProperty("--text-on-accent", accent.textOnAccent);
  root.style.setProperty("--text-hint", palette.textHint);

  root.style.setProperty("--border-default", palette.borderDefault);
  root.style.setProperty("--border-subtle", palette.borderSubtle);
  root.style.setProperty("--border-medium", palette.borderMedium);

  root.style.setProperty("--accent", accent.value);
  root.style.setProperty("--accent-selection", sel);

  root.style.setProperty("--kbd-bg", palette.kbdBg);
  root.style.setProperty("--kbd-text", palette.kbdText);
  root.style.setProperty("--kbd-border", palette.kbdBorder);
  root.style.setProperty("--diff-info-color", palette.diffInfoColor);

  // Light mode: add a thin border below the title bar so they don't bleed together
  root.style.setProperty("--window-top-border", isDark ? "none" : `1px solid ${palette.borderDefault}`);
}

export interface TerminalTheme {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

const DARK_ANSI = {
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
};

const LIGHT_ANSI = {
  black: "#000000",
  red: "#cd3131",
  green: "#00bc00",
  yellow: "#949800",
  blue: "#0451a5",
  magenta: "#bc05bc",
  cyan: "#0598bc",
  white: "#555555",
  brightBlack: "#666666",
  brightRed: "#cd3131",
  brightGreen: "#14ce14",
  brightYellow: "#b5ba00",
  brightBlue: "#0451a5",
  brightMagenta: "#bc05bc",
  brightCyan: "#0598bc",
  brightWhite: "#a5a5a5",
};

export function getTerminalTheme(palette: Palette, isDark: boolean): TerminalTheme {
  const ansi = isDark ? DARK_ANSI : LIGHT_ANSI;
  return {
    background: palette.bgPrimary,
    foreground: palette.textPrimary,
    cursor: isDark ? "#ffffff" : "#000000",
    selectionBackground: "#264f78",
    ...ansi,
  };
}

export function getAccentColor(id: AccentColorId): AccentColor {
  return ACCENT_COLORS.find((c) => c.id === id) ?? ACCENT_COLORS[0];
}
