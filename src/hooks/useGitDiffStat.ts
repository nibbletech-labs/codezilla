import { useState, useEffect, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { getGitDiffStat } from "../lib/tauri";
import { useAppStore } from "../store/appStore";

export type GitDiffStat = { added: number; removed: number } | null;

export function useGitDiffStat(projectPath: string | null): GitDiffStat {
  const [stat, setStat] = useState<GitDiffStat>(null);
  const prevPath = useRef<string | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchStat = useCallback(async () => {
    if (!projectPath) {
      setStat((prev) => (prev === null ? prev : null));
      return;
    }
    try {
      const [added, removed] = await getGitDiffStat(projectPath);
      setStat((prev) => (
        prev && prev.added === added && prev.removed === removed
          ? prev
          : { added, removed }
      ));
    } catch (err) {
      console.error("Failed to fetch git diff stat:", err);
      setStat((prev) => (prev === null ? prev : null));
    }
  }, [projectPath]);

  const scheduleFetchStat = useCallback((delayMs = 350) => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      fetchStat();
    }, delayMs);
  }, [fetchStat]);

  useEffect(() => {
    if (projectPath !== prevPath.current) {
      prevPath.current = projectPath;
      fetchStat();
    }
  }, [projectPath, fetchStat]);

  useEffect(() => {
    if (!projectPath) return;
    const unlisten = listen<string[]>("fs-change", () => {
      scheduleFetchStat();
    });
    return () => {
      if (refreshTimer.current) {
        clearTimeout(refreshTimer.current);
        refreshTimer.current = null;
      }
      unlisten.then((fn) => fn());
    };
  }, [projectPath, scheduleFetchStat]);

  // Poll every 10s, but only if the project had activity in the past 60s.
  // Read threads via getState() inside the interval to avoid subscribing to the
  // full threads array, which would re-render this hook on every thread mutation.
  useEffect(() => {
    if (!projectPath) return;
    const id = setInterval(() => {
      if (document.hidden) return;
      const state = useAppStore.getState();
      const now = Date.now();
      const projectThreads = state.threads.filter((t) => t.projectId === state.activeProjectId);
      const recentActivity = projectThreads.some((t) => now - t.lastActivityAt < 60_000);
      if (recentActivity) fetchStat();
    }, 10_000);
    return () => clearInterval(id);
  }, [projectPath, fetchStat]);

  return stat;
}
