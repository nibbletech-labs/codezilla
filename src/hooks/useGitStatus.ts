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

export function useGitStatus(projectPath: string | null): GitStatusMap {
  const [statusMap, setStatusMap] = useState<GitStatusMap>(new Map());
  const prevPath = useRef<string | null>(null);

  const fetchStatus = useCallback(async () => {
    if (!projectPath) {
      setStatusMap(new Map());
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

      setStatusMap(map);
    } catch (err) {
      console.error("Failed to fetch git status:", err);
      setStatusMap(new Map());
    }
  }, [projectPath]);

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
      fetchStatus();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [projectPath, fetchStatus]);

  return statusMap;
}
