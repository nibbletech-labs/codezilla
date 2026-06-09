/**
 * Shared tool→subtitle formatting for the hook-driven subtitle path.
 * Used to render "Reading package.json", "Running npm test", etc. in the
 * sidebar + status bar from hook events.
 */

const TOOL_VERBS: Record<string, string> = {
  // Claude tools
  Edit: "Editing",
  Write: "Writing",
  Read: "Reading",
  Bash: "Running",
  Grep: "Searching",
  Glob: "Searching",
  WebSearch: "Searching",
  WebFetch: "Fetching",
  Task: "Delegating",
  TodoWrite: "Updating plan",
  TaskCreate: "Planning",
  TaskUpdate: "Executing plan",
  TaskList: "Checking plan",
  TaskGet: "Checking task",
  // Codex tools — Codex's built-in surface is much smaller than Claude's.
  // apply_patch collapses Read/Write/Edit; we don't parse per-file targets
  // out of the patch body in v1, so the subtitle is just "Editing files".
  apply_patch: "Editing files",
  // PermissionRequest is mainly a status-bar fallback — the reducer flips
  // activityState to "awaiting_input" on this event, and the sidebar uses
  // that to drive the orange badge dot.
  PermissionRequest: "Awaiting input",
};

function shortPath(p: string | null): string | null {
  if (!p) return null;
  const parts = p.split("/");
  return parts[parts.length - 1] ?? p;
}

function truncate(s: string | null, max: number): string | null {
  if (!s) return null;
  return s.length > max ? s.slice(0, max) + "..." : s;
}

/**
 * Split a shell command into argv-ish tokens, respecting single/double quotes.
 * Not a full shell parser — anything ambiguous (backticks, nested quotes,
 * variable expansion) returns its best-effort token list; callers should
 * treat the result as a hint, not ground truth.
 */
function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === " " || ch === "\t") {
      if (cur.length > 0) {
        tokens.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0) tokens.push(cur);
  return tokens;
}

/**
 * Return the last token that isn't a flag (`-x`, `--long`) and isn't a quoted
 * sed-range argument. Used to find the file argument in commands like
 * `sed -n '1,220p' package.json` or `head -n 50 README.md`.
 */
function lastPositional(tokens: string[]): string | null {
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const t = tokens[i];
    if (t && !t.startsWith("-")) return t;
  }
  return null;
}

function firstPositional(tokens: string[]): string | null {
  for (let i = 1; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t && !t.startsWith("-")) return t;
  }
  return null;
}

/**
 * Recognize common Bash shapes and return a prettier (verb, target) pair, or
 * null when no pattern matches (caller falls back to "Running <cmd>").
 * Deliberately small — only handles patterns we've observed in Claude / Codex
 * dogfooding. Pipelines and chains use only the first command's shape.
 */
export function simplifyBashCommand(
  cmd: string,
): { verb: string; target: string | null } | null {
  if (!cmd) return null;
  // For pipelines / chains, only look at the first segment.
  const first = cmd.split(/\s*[|&;]\s*/, 1)[0] ?? cmd;
  const tokens = tokenize(first.trim());
  if (tokens.length === 0) return null;
  const head = tokens[0];
  switch (head) {
    case "cat":
    case "head":
    case "tail":
    case "less":
    case "more":
    case "bat": {
      const file = lastPositional(tokens);
      return { verb: "Reading", target: file ? shortPath(file) : null };
    }
    case "sed": {
      // `sed -n '<range>' <file>` — script arg is a positional but always a
      // sed program; treat the last positional as the file.
      const file = lastPositional(tokens);
      // Heuristic: if the file is actually the script (no other positional),
      // fall through to Running.
      const positionals = tokens.filter((t, i) => i > 0 && !t.startsWith("-"));
      if (positionals.length < 2) return null;
      return { verb: "Reading", target: file ? shortPath(file) : null };
    }
    case "rg":
    case "grep": {
      // `rg --files …` is a listing operation, not a search.
      if (tokens.includes("--files")) {
        return { verb: "Listing", target: "files" };
      }
      const pattern = firstPositional(tokens);
      return { verb: "Searching", target: pattern ? truncate(pattern, 30) : null };
    }
    case "find": {
      const path = firstPositional(tokens);
      return { verb: "Searching", target: path ? shortPath(path) : null };
    }
    case "ls": {
      const path = firstPositional(tokens);
      return { verb: "Listing", target: path ? shortPath(path) : null };
    }
    case "pwd":
      return { verb: "Checking cwd", target: null };
    case "git": {
      const sub = tokens[1] ?? "";
      if (!sub || sub.startsWith("-")) return null;
      // Capitalize first letter of the subcommand for the verb.
      const verb = `Git ${sub}`;
      return { verb, target: null };
    }
    case "mkdir": {
      const path = lastPositional(tokens);
      return { verb: "Creating", target: path ? shortPath(path) : null };
    }
    case "rm": {
      const path = lastPositional(tokens);
      return { verb: "Removing", target: path ? shortPath(path) : null };
    }
    case "mv": {
      const path = firstPositional(tokens);
      return { verb: "Moving", target: path ? shortPath(path) : null };
    }
    case "cp": {
      const path = firstPositional(tokens);
      return { verb: "Copying", target: path ? shortPath(path) : null };
    }
    default:
      return null;
  }
}

export function formatToolSubtitle(name: string, target: string | null): string {
  // MCP tools (`mcp__<server>__<tool>`): render "Calling <tool>". The args
  // are opaque (per-server schema), so we don't try to surface the target.
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    const toolPart = parts[parts.length - 1] ?? name;
    return `Calling ${truncate(toolPart, 40)}`;
  }
  // Bash: try to recognize common shapes and render a prettier verb+target.
  // Falls back to "Running <truncated cmd>" for anything we don't handle.
  if (name === "Bash" && target) {
    const pretty = simplifyBashCommand(target);
    if (pretty) {
      return pretty.target ? `${pretty.verb} ${pretty.target}` : pretty.verb;
    }
    return `Running ${truncate(target, 40)}`;
  }
  const verb = TOOL_VERBS[name] ?? "Using " + name;
  const rendered = shortPath(target);
  return rendered ? `${verb} ${rendered}` : verb;
}
