import { useState } from "react";
import type { FileEntry, GitFileStatus } from "../../lib/tauri";
import type { GitStatusMap } from "../../hooks/useGitStatus";

const GIT_STATUS_COLORS: Record<GitFileStatus, string> = {
  Modified: "#e2c08d",
  Added: "#73c991",
  Deleted: "#c74e39",
  Renamed: "#73c991",
  Untracked: "#73c991",
  Ignored: "#636b62",
  Conflicted: "#e4676b",
};

const STATUS_LETTER: Record<GitFileStatus, string> = {
  Modified: "M",
  Added: "A",
  Deleted: "D",
  Renamed: "R",
  Untracked: "U",
  Ignored: "!",
  Conflicted: "C",
};

interface FileTreeNodeProps {
  entry: FileEntry;
  depth: number;
  expandedPaths: Set<string>;
  dirCache: Map<string, FileEntry[]>;
  toggleExpand: (path: string) => void;
  gitStatus: GitStatusMap;
  onFileSelect?: (path: string) => void;
  onFileDoubleClick?: (path: string) => void;
  selectedPath?: string | null;
  onContextMenu?: (path: string, x: number, y: number) => void;
}

export default function FileTreeNode({
  entry,
  depth,
  expandedPaths,
  dirCache,
  toggleExpand,
  gitStatus,
  onFileSelect,
  onFileDoubleClick,
  selectedPath,
  onContextMenu,
}: FileTreeNodeProps) {
  const [hovered, setHovered] = useState(false);
  const isExpanded = expandedPaths.has(entry.path);
  const children = isExpanded ? dirCache.get(entry.path) ?? [] : [];

  const fileStatus = gitStatus.get(entry.path);
  const nameColor = fileStatus ? GIT_STATUS_COLORS[fileStatus] : "var(--text-primary)";

  return (
    <>
      <div
        data-path={entry.path}
        style={{
          ...styles.row,
          paddingLeft: depth * 16 + 4,
          backgroundColor:
            entry.path === selectedPath
              ? "var(--accent-selection)"
              : hovered
                ? "var(--bg-hover)"
                : "transparent",
        }}
        onClick={() => {
          onFileSelect?.(entry.path);
          if (entry.is_dir) toggleExpand(entry.path);
          else onFileDoubleClick?.(entry.path);
        }}
        onContextMenu={(e) => {
          if (onContextMenu) {
            e.preventDefault();
            e.stopPropagation();
            onContextMenu(entry.path, e.clientX, e.clientY);
          }
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {entry.is_dir ? (
          <span style={styles.chevron}>{isExpanded ? "▾" : "▸"}</span>
        ) : (
          <span style={styles.chevronSpacer} />
        )}
        <span style={{ ...styles.name, color: nameColor }}>{entry.name}</span>
        {fileStatus && !entry.is_dir && (
          <span style={{ ...styles.badge, color: nameColor }}>
            {STATUS_LETTER[fileStatus]}
          </span>
        )}
      </div>
      {isExpanded &&
        children.map((child) => (
          <FileTreeNode
            key={child.path}
            entry={child}
            depth={depth + 1}
            expandedPaths={expandedPaths}
            dirCache={dirCache}
            toggleExpand={toggleExpand}
            gitStatus={gitStatus}
            onFileSelect={onFileSelect}
            onFileDoubleClick={onFileDoubleClick}
            selectedPath={selectedPath}
            onContextMenu={onContextMenu}
          />
        ))}
    </>
  );
}

const styles = {
  row: {
    display: "flex",
    alignItems: "center",
    padding: "2px 4px",
    cursor: "pointer",
    userSelect: "none" as const,
    gap: "4px",
    transition: "background-color 0.1s ease",
  } as React.CSSProperties,
  chevron: {
    color: "var(--text-secondary)",
    fontSize: "var(--font-size)",
    width: "16px",
    flexShrink: 0,
    textAlign: "center" as const,
    lineHeight: 1,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    transform: "scale(2)",
  } as React.CSSProperties,
  chevronSpacer: {
    width: "16px",
    flexShrink: 0,
  },
  name: {
    color: "var(--text-primary)",
    fontSize: "var(--font-size)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    flex: 1,
  },
  badge: {
    fontSize: "var(--font-size-sm)",
    marginLeft: "auto",
    paddingRight: "8px",
    flexShrink: 0,
    fontWeight: 600,
  } as React.CSSProperties,
};
