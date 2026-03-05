import { useState, useEffect, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { getGitStatus, type GitFileStatus } from "../lib/tauri";

const STATUS_PRIORITY: Record<GitFileStatus, number> = {
  Conflicted: 6,
  Modified: 5,
  Added: 4,
  Deleted: 3,
  Renamed: 2,
  Untracked: 1,
  Ignored: 0,
};

export type GitStatusMap = Map<string, GitFileStatus>;

function mapsEqual(a: GitStatusMap, b: GitStatusMap): boolean {
  if (a.size !== b.size) return false;
  for (const [path, status] of a) {
    if (b.get(path) !== status) return false;
  }
  return true;
}

export function useGitStatus(projectPath: string | null): GitStatusMap {
  const [statusMap, setStatusMap] = useState<GitStatusMap>(new Map());
  const prevPath = useRef<string | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchStatus = useCallback(async () => {
    if (!projectPath) {
      setStatusMap((prev) => (prev.size === 0 ? prev : new Map()));
      return;
    }

    try {
      const entries = await getGitStatus(projectPath);
      const map: GitStatusMap = new Map();
      const root = projectPath.endsWith("/") ? projectPath : projectPath + "/";

      for (const entry of entries) {
        const absPath = root + entry.path;
        map.set(absPath, entry.status);

        // Folder rollup: propagate status to every ancestor
        const parts = entry.path.split("/");
        for (let i = 1; i < parts.length; i++) {
          const dirAbsolute = root + parts.slice(0, i).join("/");
          const existing = map.get(dirAbsolute);
          if (!existing || STATUS_PRIORITY[entry.status] > STATUS_PRIORITY[existing]) {
            map.set(dirAbsolute, entry.status);
          }
        }
      }

      setStatusMap((prev) => (mapsEqual(prev, map) ? prev : map));
    } catch (err) {
      console.error("Failed to fetch git status:", err);
      setStatusMap((prev) => (prev.size === 0 ? prev : new Map()));
    }
  }, [projectPath]);

  const scheduleFetchStatus = useCallback((delayMs = 350) => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      fetchStatus();
    }, delayMs);
  }, [fetchStatus]);

  useEffect(() => {
    if (projectPath !== prevPath.current) {
      prevPath.current = projectPath;
      fetchStatus();
    }
  }, [projectPath, fetchStatus]);

  // Re-fetch on file system changes
  useEffect(() => {
    if (!projectPath) return;
    const unlisten = listen<string[]>("fs-change", () => {
      scheduleFetchStatus();
    });
    return () => {
      if (refreshTimer.current) {
        clearTimeout(refreshTimer.current);
        refreshTimer.current = null;
      }
      unlisten.then((fn) => fn());
    };
  }, [projectPath, scheduleFetchStatus]);

  return statusMap;
}
