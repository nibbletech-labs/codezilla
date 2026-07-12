import { useState, useEffect, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { getRecentFiles, type RecentFileEntry } from "../lib/tauri";
import { isPrefix } from "../lib/worktree";

export function useRecentFiles(
  projectPath: string | null,
  enabled: boolean,
  limit = 500,
): RecentFileEntry[] {
  const [entries, setEntries] = useState<RecentFileEntry[]>([]);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchEntries = useCallback(async () => {
    if (!projectPath) {
      setEntries([]);
      return;
    }
    try {
      const result = await getRecentFiles(projectPath, projectPath, limit);
      setEntries(result);
    } catch (err) {
      console.error("Failed to fetch recent files:", err);
    }
  }, [projectPath, limit]);

  // Fetch on mount / when enabled
  useEffect(() => {
    if (enabled) fetchEntries();
    else setEntries([]);
  }, [enabled, fetchEntries]);

  // Re-fetch on fs-change (only for dirs under this root — the watcher covers
  // every env root, and another env's churn can't change this list)
  useEffect(() => {
    if (!projectPath || !enabled) return;
    const unlisten = listen<string[]>("fs-change", (event) => {
      if (!event.payload.some((dir) => isPrefix(projectPath, dir))) return;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(fetchEntries, 500);
    });
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      unlisten.then((fn) => fn());
    };
  }, [projectPath, enabled, fetchEntries]);

  return entries;
}
