import type { WorktreeInfo } from "./tauri";

function pathParts(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}

function basename(path: string): string {
  const parts = pathParts(path);
  return parts[parts.length - 1] ?? path;
}

function sourcePathLabel(worktree: WorktreeInfo): string {
  const parts = pathParts(worktree.path);
  const worktreesIndex = parts.lastIndexOf("worktrees");
  const relativeParts = worktreesIndex >= 0 ? parts.slice(worktreesIndex + 1) : parts.slice(-1);
  const relative = relativeParts.join("/") || basename(worktree.path);
  return `${worktree.source}/${relative}`;
}

/** Stable sidebar identity for branchless worktrees created by coding agents. */
export function worktreeLabel(worktree: WorktreeInfo): string {
  if (worktree.branch) return worktree.branch;

  const identity =
    worktree.source === "codex" || worktree.source === "claude"
      ? sourcePathLabel(worktree)
      : basename(worktree.path) || "detached";
  const shortHead = worktree.head.slice(0, 7);
  return shortHead ? `${identity} @ ${shortHead}` : identity;
}

export function worktreeTitle(worktree: WorktreeInfo): string {
  const state = worktree.detached && worktree.head
    ? `Detached at ${worktree.head.slice(0, 7)}`
    : worktree.branch
      ? `Branch: ${worktree.branch}`
      : "";
  return [worktreeLabel(worktree), worktree.path, state].filter(Boolean).join("\n");
}

/** Strip trailing slashes, preserving a bare root "/". */
function norm(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

/** True when `child` is `parent` or lives beneath it (path-boundary aware). */
export function isPrefix(parent: string, child: string): boolean {
  const a = norm(parent);
  const b = norm(child);
  return a === b || b.startsWith(a + "/");
}

/**
 * Attribute an edited file path to the most-specific environment it lives in.
 * Longest path-prefix wins, so a worktree (which nests under the repo root)
 * beats main. Returns the store `projectPath` for a main-repo match (keeping the
 * touch key identical to `selectedEnvPath ?? projectPath`), the worktree root for
 * a worktree match, or null when the path is non-absolute or outside every known
 * env. Pure and total — never throws (a stray Bash command / Grep pattern that
 * isn't an absolute path is rejected up front).
 */
export function attributeEnv(
  filePath: string | null,
  worktrees: WorktreeInfo[],
  projectPath: string | null,
): string | null {
  if (!filePath || !filePath.startsWith("/")) return null;

  let best: WorktreeInfo | null = null;
  for (const wt of worktrees) {
    if (isPrefix(wt.path, filePath) && (!best || norm(wt.path).length > norm(best.path).length)) {
      best = wt;
    }
  }
  if (best) return best.source === "main" ? projectPath : best.path;

  // No worktree matched (e.g. the list hasn't loaded yet) — attribute to main
  // when the file is under the project root, else it's outside every known env.
  if (projectPath && isPrefix(projectPath, filePath)) return projectPath;
  return null;
}

export function resolveProjectRootForPath(
  filePath: string,
  activeProjectPath: string | null,
  selectedEnvPath: string | null,
  worktrees: WorktreeInfo[],
): string | null {
  if (!filePath.startsWith("/")) return selectedEnvPath ?? activeProjectPath;

  const candidates = new Set<string>();
  if (selectedEnvPath) candidates.add(selectedEnvPath);
  for (const worktree of worktrees) candidates.add(worktree.path);
  if (activeProjectPath) candidates.add(activeProjectPath);

  return (
    Array.from(candidates)
      .filter((candidate) => isPrefix(candidate, filePath))
      .sort((a, b) => norm(b).length - norm(a).length)[0] ??
    selectedEnvPath ??
    activeProjectPath
  );
}
