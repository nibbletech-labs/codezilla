import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";

/**
 * Refreshes the file tree from `fs-change` events. Watching itself is owned by
 * useWatchRoots (mounted in TitleBar), which keeps the backend watcher covering
 * the project root and every worktree — this hook only consumes the events,
 * refreshing the tree root and any expanded directories that changed.
 */
export function useFileWatcher(
  projectPath: string | null,
  expandedPaths: Set<string>,
  refresh: (dirPath: string) => void,
) {
  const expandedPathsRef = useRef(expandedPaths);
  const refreshRef = useRef(refresh);

  useEffect(() => {
    expandedPathsRef.current = expandedPaths;
  }, [expandedPaths]);

  useEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  // Listen for fs-change events
  useEffect(() => {
    if (!projectPath) return;

    const pendingDirs = new Set<string>();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      flushTimer = null;
      const expanded = expandedPathsRef.current;
      const doRefresh = refreshRef.current;
      for (const dir of pendingDirs) {
        if (dir === projectPath || expanded.has(dir)) {
          doRefresh(dir);
        }
      }
      pendingDirs.clear();
    };

    const unlisten = listen<string[]>("fs-change", (event) => {
      for (const dir of event.payload) {
        pendingDirs.add(dir);
      }
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(flush, 120);
    });

    return () => {
      if (flushTimer) clearTimeout(flushTimer);
      pendingDirs.clear();
      unlisten.then((fn) => fn());
    };
  }, [projectPath]);
}
