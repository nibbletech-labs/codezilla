/**
 * Shared tool→subtitle formatting. Used by both the legacy transcript state
 * machine and the hook-driven subtitle path, so they stay in lockstep when
 * we tweak verbs or target rendering.
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
  // Codex tools
  exec_command: "Running",
  read_file: "Reading",
  write_file: "Writing",
  list_dir: "Listing",
  apply_diff: "Editing",
  web_search: "Searching",
  file_search: "Searching",
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
 * Render "Reading package.json", "Running npm test", etc.
 * For commands (Bash / exec_command) the target shows in full (truncated);
 * for filey tools the target is shortened to the basename.
 */
export function formatToolSubtitle(name: string, target: string | null): string {
  const verb = TOOL_VERBS[name] ?? "Using " + name;
  const useFullTarget = name === "Bash" || name === "exec_command";
  const rendered = useFullTarget ? truncate(target, 40) : shortPath(target);
  return rendered ? `${verb} ${rendered}` : verb;
}
