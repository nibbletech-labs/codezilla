import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { startWatching, stopWatching } from "../lib/tauri";

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

  // Start/stop watcher when project changes
  useEffect(() => {
    if (!projectPath) return;

    startWatching(projectPath, projectPath).catch((err) =>
      console.error("Failed to start watcher:", err),
    );

    return () => {
      stopWatching().catch((err) =>
        console.error("Failed to stop watcher:", err),
      );
    };
  }, [projectPath]);

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
