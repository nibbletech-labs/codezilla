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

export function formatToolSubtitle(name: string, target: string | null): string {
  // MCP tools (`mcp__<server>__<tool>`): render "Calling <tool>". The args
  // are opaque (per-server schema), so we don't try to surface the target.
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    const toolPart = parts[parts.length - 1] ?? name;
    return `Calling ${truncate(toolPart, 40)}`;
  }
  const verb = TOOL_VERBS[name] ?? "Using " + name;
  const useFullTarget = name === "Bash";
  const rendered = useFullTarget ? truncate(target, 40) : shortPath(target);
  return rendered ? `${verb} ${rendered}` : verb;
}
