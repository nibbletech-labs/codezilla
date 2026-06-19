import { useEffect, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { getGitWorktrees } from "../lib/tauri";
import { useAppStore } from "../store/appStore";

/**
 * Watches the active project's git worktrees and writes them into the store
 * (the single source of truth consumed by TitleBar, RightPanel, and
 * ThreadItem). Mirrors useGitBranch: fetch on project change and refresh on
 * fs-change events, debounced, never stacking concurrent git calls.
 */
export function useWorktrees(projectPath: string | null): void {
  const setWorktrees = useAppStore((s) => s.setWorktrees);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);

  const fetchWorktrees = useCallback(async () => {
    if (!projectPath) {
      setWorktrees([]);
      return;
    }
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const list = await getGitWorktrees(projectPath);
      setWorktrees(list);
    } catch {
      // Keep the prior worktree list on a transient git failure (e.g. during FS
      // churn while a file is being created) rather than blanking it — blanking
      // would make the WORKTREES rows + their +/- flicker out and back.
    } finally {
      inFlight.current = false;
    }
  }, [projectPath, setWorktrees]);

  const scheduleFetch = useCallback((delayMs = 350) => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      fetchWorktrees();
    }, delayMs);
  }, [fetchWorktrees]);

  useEffect(() => {
    fetchWorktrees();
  }, [fetchWorktrees]);

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
}
