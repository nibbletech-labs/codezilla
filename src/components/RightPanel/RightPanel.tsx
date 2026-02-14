import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import Fuse from "fuse.js";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../../store/appStore";
import { useFileTree } from "../../hooks/useFileTree";
import { useFileWatcher } from "../../hooks/useFileWatcher";
import { useGitStatus } from "../../hooks/useGitStatus";
import FileTreeNode from "./FileTreeNode";
import FilterInput from "./FilterInput";
import FilePreview, { shouldUseNativePreview } from "../FilePreview/FilePreview";
import CommitPreview from "../FilePreview/CommitPreview";
import type { FileEntry } from "../../lib/tauri";
import { previewFile as nativePreview, scanAllFiles, revealInFinder } from "../../lib/tauri";

export default function RightPanel() {
  const activeProject = useAppStore((s) => s.getActiveProject());
  const projectId = activeProject?.id ?? null;
  const projectPath = activeProject?.path ?? null;

  const { rootEntries, dirCache, expandedPaths, toggleExpand, refresh, isLoading } =
    useFileTree(projectId, projectPath);

  useFileWatcher(projectPath, expandedPaths, refresh);
  const gitStatus = useGitStatus(projectPath);

  const [filterText, setFilterText] = useState("");
  const [filterSelectedIdx, setFilterSelectedIdx] = useState(0);

  // Use store for selectedFile and previewFile
  const selectedFile = useAppStore((s) => s.selectedFilePath);
  const previewFile = useAppStore((s) => s.previewFile);
  const setSelectedFile = useAppStore((s) => s.selectFileInTree);
  const openPreviewAction = useAppStore((s) => s.openPreview);
  const closePreviewAction = useAppStore((s) => s.closePreview);
  const setFileIndex = useAppStore((s) => s.setFileIndex);

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

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
    scanAllFiles(projectPath)
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
        scanAllFiles(projectPath)
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
      nativePreview(filePath);
    } else {
      openPreviewAction(filePath);
    }
  }, [openPreviewAction]);

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

  // Close context menu on outside click
  useEffect(() => {
    if (!contextMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [contextMenu]);

  const handleFileContextMenu = useCallback((path: string, x: number, y: number) => {
    setContextMenu({ x, y, path });
  }, []);

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
          nativePreview(entry.path);
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
          <FilterInput value={filterText} onChange={setFilterText} onKeyDown={filterText ? handleFilterKeyDown : undefined} />

          <div ref={treeRef} style={styles.tree} tabIndex={0}>
            {isLoading && rootEntries.length === 0 ? (
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
                        backgroundColor: idx === filterSelectedIdx ? "var(--accent-selection)" : "transparent",
                      }}
                      onClick={() => {
                        setFilterSelectedIdx(idx);
                        setSelectedFile(entry.path);
                      }}
                      onDoubleClick={() => openPreview(entry.path)}
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
              onClose={closePreviewAction}
            />
          ),
          document.body,
        )}

      {contextMenu &&
        createPortal(
          <div
            ref={contextMenuRef}
            style={{
              position: "fixed",
              left: contextMenu.x,
              top: contextMenu.y,
              zIndex: 1000,
              backgroundColor: "var(--bg-panel)",
              border: "1px solid var(--border-default)",
              borderRadius: "6px",
              padding: "4px 0",
              boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
              minWidth: "160px",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                padding: "6px 12px",
                fontSize: "var(--font-size)",
                color: "var(--text-primary)",
                cursor: "pointer",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "var(--bg-hover)")}
              onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
              onClick={() => {
                revealInFinder(contextMenu.path, projectPath ?? undefined);
                setContextMenu(null);
              }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <path d="M1.5 2A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5V5.5A1.5 1.5 0 0 0 14.5 4H8.21l-1.6-1.6A1.5 1.5 0 0 0 5.55 2H1.5z" />
              </svg>
              Reveal in Finder
            </div>
          </div>,
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
};
