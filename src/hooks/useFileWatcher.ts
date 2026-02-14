import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { startWatching, stopWatching } from "../lib/tauri";

export function useFileWatcher(
  projectPath: string | null,
  expandedPaths: Set<string>,
  refresh: (dirPath: string) => void,
) {
  // Start/stop watcher when project changes
  useEffect(() => {
    if (!projectPath) return;

    startWatching(projectPath).catch((err) =>
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

    const unlisten = listen<string[]>("fs-change", (event) => {
      const changedDirs = event.payload;
      for (const dir of changedDirs) {
        // Refresh if it's the root or an expanded directory
        if (dir === projectPath || expandedPaths.has(dir)) {
          refresh(dir);
        }
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, [projectPath, expandedPaths, refresh]);
}
