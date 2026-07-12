import { useEffect, useCallback, useMemo, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { getGitWorktrees } from "../lib/tauri";
import { useAppStore } from "../store/appStore";
import { singleFlight } from "../lib/singleFlight";
import { onWorktreeListRefresh } from "../lib/refreshBus";

/**
 * Watches the active project's git worktrees and writes them into the store
 * (the single source of truth consumed by TitleBar, RightPanel, ThreadItem and
 * useWatchRoots). Fetches on project change, on fs-change events (debounced),
 * and on refresh-bus requests — the bus signal fires when an agent writes to a
 * path outside every known env, which almost always means a freshly created
 * worktree the list doesn't have yet (`git worktree add` itself only touches
 * `.git/`, which the watcher deliberately ignores).
 */
export function useWorktrees(projectPath: string | null): void {
  const setWorktrees = useAppStore((s) => s.setWorktrees);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchWorktrees = useMemo(
    () =>
      singleFlight(async () => {
        if (!projectPath) {
          setWorktrees([]);
          return;
        }
        try {
          const list = await getGitWorktrees(projectPath);
          setWorktrees(list);
        } catch {
          // Keep the prior worktree list on a transient git failure (e.g. during FS
          // churn while a file is being created) rather than blanking it — blanking
          // would make the WORKTREES rows + their +/- flicker out and back.
        }
      }),
    [projectPath, setWorktrees],
  );

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

  // Refresh-bus requests: a file-write landed outside every known env, so the
  // list is probably stale. Short debounce — the worktree may still be settling.
  useEffect(() => {
    return onWorktreeListRefresh(() => scheduleFetch(150));
  }, [scheduleFetch]);
}
