import type { Thread } from "../store/types";
import type { WorktreeInfo } from "./tauri";

export interface ResolvedWorktree {
  /** Effective root for the file tree, git status, branch, and diff stat. */
  workingDir: string;
  /** True when the thread is operating in a non-main worktree. */
  isWorktree: boolean;
  /** Matched worktree's branch (null when detached/bare/unknown). */
  branch: string | null;
  detached: boolean;
  /** "main" | "claude" | "codex" | "manual". */
  source: string;
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

/** True when `cwd` is inside a real (non-main) worktree from `worktrees`. */
export function cwdInWorktree(
  cwd: string | null,
  worktrees: { path: string; source: string }[],
): boolean {
  return !!cwd && worktrees.some((w) => w.source !== "main" && isPrefix(w.path, cwd));
}

/**
 * Resolve which working directory (and branch) a thread is operating in, by
 * matching its foreground cwd against the project's worktree list. Falls back
 * to the project root — which keeps the main-repo case byte-identical to the
 * pre-worktree behavior (zero regression).
 */
export function resolveWorktree(
  thread: Thread | null | undefined,
  worktrees: WorktreeInfo[],
  cwdByThreadId: Record<string, string | null>,
  projectPath: string | null,
): ResolvedWorktree {
  const fallback: ResolvedWorktree = {
    workingDir: projectPath ?? "",
    isWorktree: false,
    branch: null,
    detached: false,
    source: "main",
  };
  if (!thread || !projectPath) return fallback;

  const cwd = cwdByThreadId[thread.id] ?? thread.lastKnownCwd ?? null;
  if (!cwd) return fallback;

  // Longest-prefix match across all worktrees (the main repo root is in the
  // list too, so repo subdirs resolve to main and worktree subdirs resolve to
  // the worktree).
  let best: WorktreeInfo | null = null;
  for (const wt of worktrees) {
    if (isPrefix(wt.path, cwd) && (!best || norm(wt.path).length > norm(best.path).length)) {
      best = wt;
    }
  }
  if (!best) return fallback;

  const isMain = best.source === "main";
  return {
    // For the main repo keep the store's project path (avoids re-rooting churn
    // from a differently-canonicalized git path); for worktrees use the
    // worktree root so the tree shows the whole worktree even from a subdir.
    workingDir: isMain ? projectPath : best.path,
    isWorktree: !isMain,
    branch: best.branch,
    detached: best.detached,
    source: best.source,
  };
}
