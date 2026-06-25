import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import Fuse from "fuse.js";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../../store/appStore";
import { useFileTree } from "../../hooks/useFileTree";
import { useFileWatcher } from "../../hooks/useFileWatcher";
import { useGitStatus } from "../../hooks/useGitStatus";
import { useRecentFiles } from "../../hooks/useRecentFiles";
import { useAllFileDiffStats } from "../../hooks/useAllFileDiffStats";
import { timeAgo } from "../../lib/timeAgo";
import FileTreeNode from "./FileTreeNode";
import FilterInput from "./FilterInput";
import WorktreeList from "./WorktreeList";
import FilePreview, { shouldUseNativePreview } from "../FilePreview/FilePreview";
import CommitPreview from "../FilePreview/CommitPreview";
import type { FileEntry } from "../../lib/tauri";
import { previewFile as nativePreview, scanAllFiles } from "../../lib/tauri";

type ViewMode = "all" | "recent" | "changes";

export default function RightPanel() {
  const activeProject = useAppStore((s) => s.getActiveProject());
  const selectedEnvPath = useAppStore((s) => s.selectedEnvPath);
  const projectId = activeProject?.id ?? null;

  // The whole panel reflects the selected environment: the chosen worktree, else
  // the project root (main). `projectPath` (= effectiveRoot) threads through every
  // hook and relative-path calc below unchanged.
  const projectPath = selectedEnvPath ?? activeProject?.path ?? null;

  const { rootEntries, dirCache, expandedPaths, toggleExpand, refresh, isLoading } =
    useFileTree(projectId, projectPath);

  useFileWatcher(projectPath, expandedPaths, refresh);
  const gitStatus = useGitStatus(projectPath);

  const [viewMode, setViewMode] = useState<ViewMode>("all");
  const recentFiles = useRecentFiles(projectPath, viewMode === "recent");
  const fileDiffStats = useAllFileDiffStats(projectPath, viewMode === "changes");

  // Tick counter for updating relative times
  const [, setAgeTick] = useState(0);
  useEffect(() => {
    if (viewMode !== "recent") return;
    const id = setInterval(() => setAgeTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, [viewMode]);

  const [filterText, setFilterText] = useState("");
  const [filterSelectedIdx, setFilterSelectedIdx] = useState(0);
  const [hoveredPath, setHoveredPath] = useState<string | null>(null);

  // Use store for selectedFile and previewFile
  const selectedFile = useAppStore((s) => s.selectedFilePath);
  const previewFile = useAppStore((s) => s.previewFile);
  const setSelectedFile = useAppStore((s) => s.selectFileInTree);
  const openPreviewAction = useAppStore((s) => s.openPreview);
  const closePreviewAction = useAppStore((s) => s.closePreview);
  const setFileIndex = useAppStore((s) => s.setFileIndex);

  const showFileLinkMenu = useAppStore((s) => s.showFileLinkMenu);

  const treeRef = useRef<HTMLDivElement>(null);

  // Refs so the window-level listener always sees current values
  const selectedFileRef = useRef(selectedFile);
  selectedFileRef.current = selectedFile;
  const previewFileRef = useRef(previewFile);
  previewFileRef.current = previewFile;

  // Build full fileIndex via recursive scan when project changes
  useEffect(() => {
    if (!projectPath) {
      setFileIndex(new Set());
      return;
    }
    scanAllFiles(projectPath, projectPath)
      .then((files) => setFileIndex(new Set(files)))
      .catch((err) => console.error("Failed to scan files:", err));
  }, [projectPath, setFileIndex]);

  // Keep fileIndex fresh: rescan (debounced) when files change on disk
  useEffect(() => {
    if (!projectPath) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unlisten = listen<string[]>("fs-change", () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        scanAllFiles(projectPath, projectPath)
          .then((files) => setFileIndex(new Set(files)))
          .catch((err) => console.error("Failed to rescan files:", err));
      }, 2000);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unlisten.then((fn) => fn());
    };
  }, [projectPath, setFileIndex]);

  // Open preview: native Quick Look for binary files, in-app modal for text
  const openPreview = useCallback((filePath: string) => {
    if (shouldUseNativePreview(filePath)) {
      if (projectPath) nativePreview(filePath, projectPath);
    } else {
      openPreviewAction(filePath);
    }
  }, [openPreviewAction, projectPath]);

  // Flat ordered list of all visible entries (respects expanded/collapsed state)
  const visibleEntries = useMemo(() => {
    const result: FileEntry[] = [];
    const walk = (entries: FileEntry[]) => {
      for (const entry of entries) {
        result.push(entry);
        if (entry.is_dir && expandedPaths.has(entry.path)) {
          const children = dirCache.get(entry.path) ?? [];
          walk(children);
        }
      }
    };
    walk(rootEntries);
    return result;
  }, [rootEntries, expandedPaths, dirCache]);

  // Find parent directory path for a given entry
  const getParentPath = useCallback((entryPath: string) => {
    const idx = entryPath.lastIndexOf("/");
    return idx > 0 ? entryPath.substring(0, idx) : null;
  }, []);

  // Scroll selected item into view
  useEffect(() => {
    if (!selectedFile || !treeRef.current) return;
    const el = treeRef.current.querySelector(`[data-path="${CSS.escape(selectedFile)}"]`);
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [selectedFile]);

  // Clear selection when clicking outside the file tree
  useEffect(() => {
    const handleGlobalClick = (e: MouseEvent) => {
      if (treeRef.current && !treeRef.current.contains(e.target as Node)) {
        useAppStore.setState({ selectedFilePath: null });
      }
    };
    window.addEventListener("mousedown", handleGlobalClick);
    return () => window.removeEventListener("mousedown", handleGlobalClick);
  }, []);

  const handleFileContextMenu = useCallback((path: string, x: number, y: number) => {
    showFileLinkMenu(path, { x, y });
  }, [showFileLinkMenu]);

  // Keyboard handler: Space toggles preview, arrows navigate
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (e.key === " ") {
        e.preventDefault();
        if (previewFileRef.current) {
          closePreviewAction();
        } else if (selectedFileRef.current) {
          const entry = visibleEntries.find((e) => e.path === selectedFileRef.current);
          if (entry && !entry.is_dir) {
            openPreview(selectedFileRef.current);
          }
        }
        return;
      }

      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
      e.preventDefault();

      const entries = visibleEntries;
      if (entries.length === 0) return;

      const currentPath = selectedFileRef.current;
      const currentIdx = currentPath ? entries.findIndex((e) => e.path === currentPath) : -1;

      const navigateTo = (entry: FileEntry) => {
        setSelectedFile(entry.path);
        if (!previewFileRef.current) return;
        if (entry.is_dir) {
          // Show "select a file" placeholder in the modal
          openPreviewAction(entry.path);
        } else if (shouldUseNativePreview(entry.path)) {
          // Close in-app preview, launch native Quick Look
          closePreviewAction();
          if (projectPath) nativePreview(entry.path, projectPath);
        } else {
          openPreviewAction(entry.path);
        }
      };

      if (e.key === "ArrowDown") {
        const nextIdx = currentIdx < entries.length - 1 ? currentIdx + 1 : currentIdx;
        navigateTo(entries[nextIdx]);
      } else if (e.key === "ArrowUp") {
        const prevIdx = currentIdx > 0 ? currentIdx - 1 : 0;
        navigateTo(entries[prevIdx]);
      } else if (e.key === "ArrowRight") {
        if (currentIdx === -1) return;
        const entry = entries[currentIdx];
        if (entry.is_dir && !expandedPaths.has(entry.path)) {
          toggleExpand(entry.path);
        } else if (entry.is_dir && expandedPaths.has(entry.path)) {
          // Already expanded — move to first child
          if (currentIdx + 1 < entries.length) {
            setSelectedFile(entries[currentIdx + 1].path);
          }
        }
      } else if (e.key === "ArrowLeft") {
        if (currentIdx === -1) return;
        const entry = entries[currentIdx];
        if (entry.is_dir && expandedPaths.has(entry.path)) {
          toggleExpand(entry.path);
        } else {
          // Move to parent directory
          const parentPath = getParentPath(entry.path);
          if (parentPath) {
            const parentIdx = entries.findIndex((e) => e.path === parentPath);
            if (parentIdx !== -1) {
              setSelectedFile(entries[parentIdx].path);
            }
          }
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [visibleEntries, expandedPaths, toggleExpand, openPreview, openPreviewAction, closePreviewAction, getParentPath, setSelectedFile]);

  // Build flat list from cache for filtering
  const allLoadedEntries = useMemo(() => {
    if (!filterText || !projectPath) return [];
    const flat: (FileEntry & { relativePath: string })[] = [];
    for (const [, entries] of dirCache) {
      for (const entry of entries) {
        flat.push({
          ...entry,
          relativePath: entry.path.startsWith(projectPath)
            ? entry.path.slice(projectPath.length + 1)
            : entry.path,
        });
      }
    }
    return flat;
  }, [filterText, dirCache, projectPath]);

  const filteredEntries = useMemo(() => {
    if (!filterText) return [];
    const fuse = new Fuse(allLoadedEntries, {
      keys: ["name", "relativePath"],
      threshold: 0.4,
    });
    return fuse.search(filterText).map((r) => r.item);
  }, [filterText, allLoadedEntries]);

  // Filtered recent files (supports search within the view)
  const filteredRecentFiles = useMemo(() => {
    if (!filterText) return recentFiles;
    const lower = filterText.toLowerCase();
    return recentFiles.filter(
      (f) => f.name.toLowerCase().includes(lower) || f.path.toLowerCase().includes(lower),
    );
  }, [recentFiles, filterText]);

  // Filtered diff stats (supports search within the view)
  const filteredDiffStats = useMemo(() => {
    if (!filterText) return fileDiffStats;
    const lower = filterText.toLowerCase();
    return fileDiffStats.filter((f) => f.path.toLowerCase().includes(lower));
  }, [fileDiffStats, filterText]);

  // Reset filter selection when results change
  useEffect(() => {
    setFilterSelectedIdx(0);
  }, [filteredEntries.length, filterText]);

  const filterListRef = useRef<HTMLDivElement>(null);

  // Scroll selected filter result into view
  useEffect(() => {
    if (!filterText || !filterListRef.current) return;
    const el = filterListRef.current.querySelector("[data-filter-selected='true']");
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [filterSelectedIdx, filterText]);

  const handleFilterKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFilterSelectedIdx((i) => Math.min(i + 1, filteredEntries.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFilterSelectedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const entry = filteredEntries[filterSelectedIdx];
      if (!entry) return;
      setSelectedFile(entry.path);
      if (e.key === " " && previewFileRef.current) {
        // Toggle preview off
        closePreviewAction();
      } else if (!entry.is_dir) {
        openPreview(entry.path);
      }
    } else if (e.key === "Escape") {
      if (previewFileRef.current) {
        closePreviewAction();
      } else {
        setFilterText("");
      }
    }
  }, [filteredEntries, filterSelectedIdx, setSelectedFile, openPreview, closePreviewAction]);

  return (
    <div style={styles.container} onContextMenu={(e) => e.preventDefault()}>
      {!activeProject ? (
        <div style={styles.empty}>No project selected</div>
      ) : (
        <>
          <div style={styles.sectionHeader}>Worktrees</div>
          <WorktreeList />
          <div style={styles.sectionHeader}>Files</div>
          <div style={styles.viewModeBar}>
            {(["all", "recent", "changes"] as ViewMode[]).map((mode) => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                style={{
                  ...styles.viewModeBtn,
                  ...(viewMode === mode ? styles.viewModeBtnActive : {}),
                }}
              >
                {mode === "all" ? "All" : mode === "recent" ? "Recent" : "Changes"}
              </button>
            ))}
          </div>
          <FilterInput value={filterText} onChange={setFilterText} onKeyDown={filterText ? handleFilterKeyDown : undefined} />

          <div ref={treeRef} style={styles.tree} tabIndex={0}>
            {viewMode === "all" ? (
              isLoading && rootEntries.length === 0 ? (
                <div style={styles.empty}>Loading...</div>
              ) : filterText ? (
                filteredEntries.length === 0 ? (
                  <div style={styles.empty}>No matches</div>
                ) : (
                  <div ref={filterListRef}>
                    {filteredEntries.map((entry, idx) => (
                      <div
                        key={entry.path}
                        data-filter-selected={idx === filterSelectedIdx}
                        style={{
                          ...styles.filterResult,
                          backgroundColor: idx === filterSelectedIdx
                            ? "var(--accent-selection)"
                            : hoveredPath === entry.path
                              ? "var(--bg-hover)"
                              : "transparent",
                        }}
                        onMouseEnter={() => setHoveredPath(entry.path)}
                        onMouseLeave={() => setHoveredPath(null)}
                        onClick={() => {
                          setFilterSelectedIdx(idx);
                          setSelectedFile(entry.path);
                          openPreview(entry.path);
                        }}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleFileContextMenu(entry.path, e.clientX, e.clientY);
                        }}
                      >
                        <span style={styles.filterName}>{entry.name}</span>
                        <span style={styles.filterPath}>{entry.relativePath}</span>
                      </div>
                    ))}
                  </div>
                )
              ) : (
                rootEntries.map((entry) => (
                  <FileTreeNode
                    key={entry.path}
                    entry={entry}
                    depth={0}
                    expandedPaths={expandedPaths}
                    dirCache={dirCache}
                    toggleExpand={toggleExpand}
                    gitStatus={gitStatus}
                    onFileSelect={setSelectedFile}
                    onFileDoubleClick={openPreview}
                    selectedPath={selectedFile}
                    onContextMenu={handleFileContextMenu}
                  />
                ))
              )
            ) : viewMode === "recent" ? (
              filteredRecentFiles.length === 0 ? (
                <div style={styles.empty}>No recent files</div>
              ) : (
                filteredRecentFiles.map((file) => {
                  const relPath = projectPath && file.path.startsWith(projectPath)
                    ? file.path.slice(projectPath.length + 1)
                    : file.path;
                  return (
                    <div
                      key={file.path}
                      style={{
                        ...styles.flatRow,
                        backgroundColor: selectedFile === file.path
                          ? "var(--accent-selection)"
                          : hoveredPath === file.path
                            ? "var(--bg-hover)"
                            : "transparent",
                      }}
                      onMouseEnter={() => setHoveredPath(file.path)}
                      onMouseLeave={() => setHoveredPath(null)}
                      onClick={() => {
                        setSelectedFile(file.path);
                        openPreview(file.path);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        handleFileContextMenu(file.path, e.clientX, e.clientY);
                      }}
                    >
                      <div style={styles.flatRowLeft}>
                        <span style={styles.filterName}>{file.name}</span>
                        <span style={styles.filterPath}>{relPath}</span>
                      </div>
                      <span style={styles.ageLabel}>{timeAgo(file.mtime_ms)}</span>
                    </div>
                  );
                })
              )
            ) : (
              filteredDiffStats.length === 0 ? (
                <div style={styles.empty}>No uncommitted changes</div>
              ) : (
                filteredDiffStats.map((file) => {
                  const name = file.path.split("/").pop() ?? file.path;
                  return (
                    <div
                      key={file.path}
                      style={{
                        ...styles.flatRow,
                        backgroundColor:
                          projectPath && selectedFile === projectPath + "/" + file.path
                            ? "var(--accent-selection)"
                            : hoveredPath === file.path
                              ? "var(--bg-hover)"
                              : "transparent",
                      }}
                      onMouseEnter={() => setHoveredPath(file.path)}
                      onMouseLeave={() => setHoveredPath(null)}
                      onClick={() => {
                        const absPath = projectPath ? projectPath + "/" + file.path : file.path;
                        setSelectedFile(absPath);
                        openPreview(absPath);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const absPath = projectPath ? projectPath + "/" + file.path : file.path;
                        handleFileContextMenu(absPath, e.clientX, e.clientY);
                      }}
                    >
                      <div style={styles.flatRowLeft}>
                        <span style={styles.filterName}>{name}</span>
                        <span style={styles.filterPath}>{file.path}</span>
                      </div>
                      <span style={styles.diffStats}>
                        {file.added > 0 && <span style={styles.diffAdded}>+{file.added}</span>}
                        {file.added > 0 && file.removed > 0 && <span style={styles.diffSep}>{" "}</span>}
                        {file.removed > 0 && <span style={styles.diffRemoved}>-{file.removed}</span>}
                      </span>
                    </div>
                  );
                })
              )
            )}
          </div>
        </>
      )}

      {previewFile &&
        createPortal(
          previewFile.kind === "commit" ? (
            <CommitPreview
              commitHash={previewFile.hash}
              onClose={closePreviewAction}
            />
          ) : (
            <FilePreview
              filePath={previewFile.path}
              line={previewFile.line}
              initialMode={previewFile.mode}
              onClose={closePreviewAction}
            />
          ),
          document.body,
        )}

    </div>
  );
}

const styles = {
  container: {
    height: "100%",
    backgroundColor: "var(--bg-panel)",
    borderLeft: "1px solid var(--border-default)",
    display: "flex",
    flexDirection: "column" as const,
    overflow: "hidden",
  },
  tree: {
    flex: 1,
    overflow: "auto",
    paddingTop: "4px",
    outline: "none",
  },
  empty: {
    padding: "24px 12px",
    textAlign: "center" as const,
    color: "var(--text-secondary)",
    fontSize: "var(--font-size)",
  },
  filterResult: {
    display: "flex",
    flexDirection: "column" as const,
    padding: "3px 12px",
    cursor: "pointer",
  },
  filterName: {
    color: "var(--text-primary)",
    fontSize: "var(--font-size)",
  },
  filterPath: {
    color: "var(--text-secondary)",
    fontSize: "var(--font-size-sm)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  sectionHeader: {
    textTransform: "uppercase" as const,
    fontSize: "var(--font-size-sm)",
    letterSpacing: "0.5px",
    color: "var(--text-secondary)",
    fontWeight: 600,
    padding: "8px 8px 4px",
    flexShrink: 0,
  } as React.CSSProperties,
  viewModeBar: {
    display: "flex",
    gap: "1px",
    padding: "6px 8px 0",
  },
  viewModeBtn: {
    flex: 1,
    background: "transparent",
    border: "1px solid var(--border-default)",
    color: "var(--text-secondary)",
    fontSize: "var(--font-size-sm)",
    padding: "3px 0",
    cursor: "pointer",
    borderRadius: "2px",
    transition: "background 0.1s, color 0.1s",
  } as React.CSSProperties,
  viewModeBtnActive: {
    background: "var(--accent-selection)",
    color: "var(--text-primary)",
    borderColor: "var(--accent)",
  },
  flatRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "3px 12px",
    cursor: "pointer",
    gap: "8px",
  },
  flatRowLeft: {
    display: "flex",
    flexDirection: "column" as const,
    overflow: "hidden",
    minWidth: 0,
  },
  ageLabel: {
    color: "var(--text-secondary)",
    fontSize: "var(--font-size-sm)",
    fontFamily: "var(--font-mono, monospace)",
    flexShrink: 0,
    userSelect: "none" as const,
  },
  diffStats: {
    flexShrink: 0,
    fontSize: "var(--font-size-sm)",
    fontFamily: "var(--font-mono, monospace)",
    userSelect: "none" as const,
    display: "flex",
    gap: "2px",
  },
  diffAdded: {
    color: "#73c991",
  },
  diffRemoved: {
    color: "#c74e39",
  },
  diffSep: {
    color: "var(--text-secondary)",
  },
};
