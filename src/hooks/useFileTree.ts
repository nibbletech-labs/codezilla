import { useState, useCallback, useEffect, useRef } from "react";
import { readDirectory, type FileEntry } from "../lib/tauri";
import { useAppStore } from "../store/appStore";

export function useFileTree(projectId: string | null, projectPath: string | null) {
  const [dirCache, setDirCache] = useState<Map<string, FileEntry[]>>(new Map());
  const [isLoading, setIsLoading] = useState(false);
  const expandedPaths = useAppStore((s) =>
    projectId ? s.getExpandedPaths(projectId) : new Set<string>(),
  );
  const toggleExpandedPath = useAppStore((s) => s.toggleExpandedPath);
  const prevProjectPath = useRef<string | null>(null);

  // Load root when project changes
  useEffect(() => {
    if (projectPath && projectPath !== prevProjectPath.current) {
      prevProjectPath.current = projectPath;
      setDirCache(new Map());
      setIsLoading(true);
      readDirectory(projectPath)
        .then((entries) => {
          setDirCache(new Map([[projectPath, entries]]));
        })
        .catch((err) => console.error("Failed to read root directory:", err))
        .finally(() => setIsLoading(false));
    } else if (!projectPath) {
      prevProjectPath.current = null;
      setDirCache(new Map());
    }
  }, [projectPath]);

  // Load expanded directories that aren't cached yet
  useEffect(() => {
    if (!projectPath) return;
    const uncached = Array.from(expandedPaths).filter((p) => !dirCache.has(p));
    if (uncached.length === 0) return;

    Promise.allSettled(
      uncached.map((dirPath) =>
        readDirectory(dirPath).then((entries) => [dirPath, entries] as const),
      ),
    ).then((results) => {
      setDirCache((prev) => {
        const next = new Map(prev);
        for (const result of results) {
          if (result.status === "fulfilled") {
            const [dirPath, entries] = result.value;
            next.set(dirPath, entries);
          }
        }
        return next;
      });
    });
  }, [expandedPaths, projectPath, dirCache]);

  const toggleExpand = useCallback(
    (path: string) => {
      if (!projectId) return;
      const isExpanded = expandedPaths.has(path);
      toggleExpandedPath(projectId, path);

      if (!isExpanded && !dirCache.has(path)) {
        readDirectory(path)
          .then((entries) => {
            setDirCache((prev) => new Map(prev).set(path, entries));
          })
          .catch((err) => console.error("Failed to read directory:", err));
      }
    },
    [projectId, expandedPaths, toggleExpandedPath, dirCache],
  );

  const refresh = useCallback(
    (dirPath: string) => {
      // Only refresh if this directory is the root or is expanded
      if (!projectPath) return;
      if (dirPath !== projectPath && !expandedPaths.has(dirPath)) return;

      readDirectory(dirPath)
        .then((entries) => {
          setDirCache((prev) => new Map(prev).set(dirPath, entries));
        })
        .catch((err) => console.error("Failed to refresh directory:", err));
    },
    [projectPath, expandedPaths],
  );

  const rootEntries = projectPath ? dirCache.get(projectPath) ?? [] : [];

  return {
    rootEntries,
    dirCache,
    expandedPaths,
    toggleExpand,
    refresh,
    isLoading,
  };
}
