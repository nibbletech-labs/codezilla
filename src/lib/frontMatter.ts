import yaml from "js-yaml";

export interface FrontMatterSplit {
  /** Parsed front matter data, or null if there was no front matter block. */
  data: unknown;
  /** The raw front matter text (without delimiters), present even when parsing fails. */
  raw: string | null;
  /** True when a front matter block was found but could not be parsed as YAML. */
  parseError: boolean;
  /** The markdown body with the front matter block removed. */
  body: string;
}

// Matches a YAML front matter block only when `---` is the very first line of
// the file, so a legitimate horizontal rule mid-document is never mistaken for
// front matter. Tolerates a leading BOM and CRLF line endings.
const FRONT_MATTER_RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function splitFrontMatter(content: string): FrontMatterSplit {
  const match = content.match(FRONT_MATTER_RE);
  if (!match) {
    return { data: null, raw: null, parseError: false, body: content };
  }

  const raw = match[1];
  const body = content.slice(match[0].length);

  try {
    const data = yaml.load(raw);
    // A block that parses to a scalar/array/empty isn't really key/value
    // metadata — treat anything that isn't a plain object as a parse failure so
    // it falls back to a raw display rather than rendering an awkward panel.
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return { data: null, raw, parseError: true, body };
    }
    return { data, raw, parseError: false, body };
  } catch {
    return { data: null, raw, parseError: true, body };
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return String(value);
}

// Renders one field as a row. Nested objects recurse into an indented group;
// arrays of scalars render as a compact comma-joined value, while arrays of
// objects recurse as nested rows.
function renderField(key: string, value: unknown): string {
  const label = `<div class="fm-key">${escapeHtml(key)}</div>`;

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return `<div class="fm-row fm-row-nested">${label}<div class="fm-nested">${renderEntries(
      value as Record<string, unknown>,
    )}</div></div>`;
  }

  if (Array.isArray(value)) {
    const allScalar = value.every((v) => v === null || typeof v !== "object");
    if (allScalar) {
      const text = value.length ? value.map((v) => formatScalar(v)).join(", ") : "—";
      return `<div class="fm-row">${label}<div class="fm-value">${escapeHtml(text)}</div></div>`;
    }
    const items = value
      .map((v) =>
        v !== null && typeof v === "object" && !Array.isArray(v)
          ? `<div class="fm-nested">${renderEntries(v as Record<string, unknown>)}</div>`
          : `<div class="fm-value">${escapeHtml(formatScalar(v))}</div>`,
      )
      .join("");
    return `<div class="fm-row fm-row-nested">${label}<div class="fm-nested">${items}</div></div>`;
  }

  return `<div class="fm-row">${label}<div class="fm-value">${escapeHtml(formatScalar(value))}</div></div>`;
}

function renderEntries(obj: Record<string, unknown>): string {
  return Object.entries(obj)
    .map(([key, value]) => renderField(key, value))
    .join("");
}

/**
 * Builds the HTML for the front matter metadata panel. Returns an empty string
 * when there is no front matter. On a YAML parse error, falls back to showing
 * the raw block so the content is never silently lost.
 */
export function renderFrontMatterPanel(split: FrontMatterSplit): string {
  if (split.raw === null) return "";

  if (split.parseError || split.data === null) {
    return `<div class="fm-panel fm-panel-raw"><pre class="fm-raw"><code>${escapeHtml(
      split.raw,
    )}</code></pre></div>`;
  }

  const rows = renderEntries(split.data as Record<string, unknown>);
  if (!rows) return "";
  return `<div class="fm-panel">${rows}</div>`;
}
