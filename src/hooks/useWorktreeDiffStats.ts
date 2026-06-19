import { useEffect, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { getGitDiffStat } from "../lib/tauri";
import { useAppStore } from "../store/appStore";

/**
 * Keeps each environment's uncommitted +/- totals fresh in store.envDiffStats,
 * keyed by env path: the active project root (main) plus every non-main worktree.
 * Writing the stats also prunes touch records for any env now clean (0/0), so a
 * surviving touch == uncommitted work. Mounted in the always-rendered TitleBar.
 *
 * Mirrors useGitDiffStat: refresh on the env set changing, on fs-change, and on a
 * 10s activity-gated poll; never stacks concurrent batches. getGitDiffStat returns
 * a [added, removed] tuple, destructured here into the {added, removed} store shape.
 */
export function useWorktreeDiffStats(): void {
  const worktrees = useAppStore((s) => s.worktrees);
  const projectPath = useAppStore(
    (s) => s.projects.find((p) => p.id === s.activeProjectId)?.path ?? null,
  );
  const setEnvDiffStats = useAppStore((s) => s.setEnvDiffStats);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);

  const fetchAll = useCallback(async () => {
    // Env path set: the project root (main, keyed by the store path so it matches
    // attributeEnv + the ThreadItem dot), then each non-main worktree by its path.
    const envPaths: string[] = [];
    if (projectPath) envPaths.push(projectPath);
    for (const wt of worktrees) {
      if (wt.source !== "main" && !envPaths.includes(wt.path)) envPaths.push(wt.path);
    }
    if (envPaths.length === 0) {
      setEnvDiffStats({});
      return;
    }
    if (inFlight.current) return;
    inFlight.current = true;
    // Last known stats — on a transient git failure (common while a file is being
    // created and the FS is churning) keep the prior value for that env rather
    // than resetting to 0/0, which would blank the +/- and make it flicker.
    const prev = useAppStore.getState().envDiffStats;
    try {
      const entries = await Promise.all(
        envPaths.map(async (p) => {
          try {
            const [added, removed] = await getGitDiffStat(p);
            return [p, { added, removed }] as const;
          } catch {
            return [p, prev[p] ?? { added: 0, removed: 0 }] as const;
          }
        }),
      );
      setEnvDiffStats(Object.fromEntries(entries));
    } finally {
      inFlight.current = false;
    }
  }, [worktrees, projectPath, setEnvDiffStats]);

  const scheduleFetch = useCallback((delayMs = 350) => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      fetchAll();
    }, delayMs);
  }, [fetchAll]);

  // Refresh whenever the env set changes (project switch, worktree add/remove).
  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    if (!projectPath) return;
    const unlisten = listen<string[]>("fs-change", () => {
      scheduleFetch();
    });
    return () => {
      if (refreshTimer.current) {
        clearTimeout(refreshTimer.current);
        refreshTimer.current = null;
      }
      unlisten.then((fn) => fn());
    };
  }, [projectPath, scheduleFetch]);

  // Poll every 10s, but only when the project had activity in the past 60s.
  useEffect(() => {
    if (!projectPath) return;
    const id = setInterval(() => {
      if (document.hidden) return;
      const state = useAppStore.getState();
      const now = Date.now();
      const projectThreads = state.threads.filter((t) => t.projectId === state.activeProjectId);
      const recentActivity = projectThreads.some((t) => now - t.lastActivityAt < 60_000);
      if (recentActivity) fetchAll();
    }, 10_000);
    return () => clearInterval(id);
  }, [projectPath, fetchAll]);
}
