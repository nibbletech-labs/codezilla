import { useState, useEffect, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { getAllFileDiffStats, type FileDiffStat } from "../lib/tauri";

export function useAllFileDiffStats(
  projectPath: string | null,
  enabled: boolean,
): FileDiffStat[] {
  const [stats, setStats] = useState<FileDiffStat[]>([]);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchStats = useCallback(async () => {
    if (!projectPath) {
      setStats([]);
      return;
    }
    try {
      const result = await getAllFileDiffStats(projectPath);
      setStats(result);
    } catch (err) {
      console.error("Failed to fetch file diff stats:", err);
    }
  }, [projectPath]);

  useEffect(() => {
    if (enabled) fetchStats();
    else setStats([]);
  }, [enabled, fetchStats]);

  useEffect(() => {
    if (!projectPath || !enabled) return;
    const unlisten = listen<string[]>("fs-change", () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(fetchStats, 500);
    });
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      unlisten.then((fn) => fn());
    };
  }, [projectPath, enabled, fetchStats]);

  return stats;
}
