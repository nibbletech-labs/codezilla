import { useEffect, useState, useCallback, useRef } from "react";
import { getCommitInfo } from "../../lib/tauri";
import type { CommitInfo } from "../../lib/tauri";
import { useAppStore } from "../../store/appStore";
import { timeAgo } from "../../lib/timeAgo";

interface CommitPreviewProps {
  commitHash: string;
  onClose: () => void;
}

export default function CommitPreview({ commitHash, onClose }: CommitPreviewProps) {
  const [info, setInfo] = useState<CommitInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const activeProject = useAppStore((s) => s.getActiveProject());
  const projectPath = activeProject?.path ?? null;

  useEffect(() => {
    setInfo(null);
    setError(null);

    if (!projectPath) {
      setError("No project selected");
      return;
    }

    getCommitInfo(projectPath, commitHash)
      .then(setInfo)
      .catch((err) => setError(String(err)));
  }, [commitHash, projectPath]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  const shortHash = commitHash.slice(0, 7);
  const relDate = info?.date ? timeAgo(new Date(info.date).getTime()) : "";

  const renderBody = () => {
    if (error) return <div style={styles.message}>{error}</div>;
    if (!info) return <div style={styles.message}>Loading...</div>;

    if (info.file_stats.length === 0) {
      return <div style={styles.message}>No file changes</div>;
    }

    const maxChange = Math.max(...info.file_stats.map((f) => f.additions + f.deletions), 1);

    return (
      <div style={styles.statTable}>
        {info.file_stats.map((f) => {
          const total = f.additions + f.deletions;
          const barWidth = Math.max(Math.round((total / maxChange) * 120), 2);
          const addWidth = total > 0 ? Math.round((f.additions / total) * barWidth) : 0;
          const delWidth = barWidth - addWidth;

          return (
            <div key={f.file} style={styles.statRow}>
              <span style={styles.statFile}>{f.file}</span>
              <span style={styles.statNumbers}>
                {f.additions > 0 && (
                  <span style={{ color: "#89d185" }}>+{f.additions}</span>
                )}
                {f.additions > 0 && f.deletions > 0 && " "}
                {f.deletions > 0 && (
                  <span style={{ color: "#f48771" }}>-{f.deletions}</span>
                )}
                {f.additions === 0 && f.deletions === 0 && (
                  <span style={{ color: "var(--text-hint)" }}>0</span>
                )}
              </span>
              <span style={styles.statBar}>
                {addWidth > 0 && (
                  <span
                    style={{
                      display: "inline-block",
                      width: `${addWidth}px`,
                      height: "8px",
                      backgroundColor: "#89d185",
                      borderRadius: delWidth > 0 ? "2px 0 0 2px" : "2px",
                    }}
                  />
                )}
                {delWidth > 0 && (
                  <span
                    style={{
                      display: "inline-block",
                      width: `${delWidth}px`,
                      height: "8px",
                      backgroundColor: "#f48771",
                      borderRadius: addWidth > 0 ? "0 2px 2px 0" : "2px",
                    }}
                  />
                )}
              </span>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div style={styles.backdrop} onClick={handleBackdropClick}>
      <style>{`
        @keyframes preview-backdrop-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes preview-modal-in {
          from { opacity: 0; transform: scale(0.96); }
          to { opacity: 1; transform: scale(1); }
        }
      `}</style>
      <div style={styles.modal}>
        {/* Header */}
        <div style={styles.header}>
          <div style={styles.headerLeft}>
            <span style={styles.hashLabel}>{shortHash}</span>
            {info && (
              <span style={styles.authorDate}>
                {info.author} &middot; {relDate}
              </span>
            )}
          </div>
          <div style={styles.headerRight}>
            <button style={styles.closeButton} onClick={onClose}>
              &times;
            </button>
          </div>
        </div>

        {/* Sub-header: commit message + totals */}
        {info && (
          <div style={styles.subHeader}>
            <div style={styles.subject}>{info.subject}</div>
            {info.body && <div style={styles.bodyText}>{info.body}</div>}
            <div style={styles.statsBar}>
              <span>{info.files_changed} file{info.files_changed !== 1 ? "s" : ""} changed</span>
              {info.additions > 0 && (
                <span style={{ color: "#89d185" }}>+{info.additions}</span>
              )}
              {info.deletions > 0 && (
                <span style={{ color: "#f48771" }}>-{info.deletions}</span>
              )}
            </div>
          </div>
        )}

        {/* Body */}
        <div ref={bodyRef} style={styles.bodyContainer}>
          {renderBody()}
        </div>
      </div>
    </div>
  );
}

const styles = {
  backdrop: {
    position: "fixed" as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "color-mix(in srgb, var(--bg-primary) 60%, transparent)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
    animation: "preview-backdrop-in 0.15s ease-out",
  } as React.CSSProperties,
  modal: {
    width: "calc(100vw - 250px - var(--right-panel-width, 250px) - 10px)",
    height: "calc(100vh - 24px - 10px)",
    backgroundColor: "var(--bg-primary)",
    borderRadius: "8px",
    border: "1px solid var(--border-default)",
    display: "flex",
    flexDirection: "column" as const,
    overflow: "hidden",
    boxShadow: "0 8px 32px rgba(0, 0, 0, 0.5)",
    animation: "preview-modal-in 0.15s ease-out",
  } as React.CSSProperties,
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "6px 16px",
    borderBottom: "1px solid var(--border-default)",
    backgroundColor: "var(--bg-panel)",
    flexShrink: 0,
  } as React.CSSProperties,
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    overflow: "hidden",
    minWidth: 0,
  } as React.CSSProperties,
  headerRight: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    flexShrink: 0,
  } as React.CSSProperties,
  hashLabel: {
    color: "var(--accent)",
    fontSize: "var(--font-size)",
    fontWeight: 600,
    fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
  } as React.CSSProperties,
  authorDate: {
    color: "var(--text-secondary)",
    fontSize: "var(--font-size)",
    whiteSpace: "nowrap" as const,
  } as React.CSSProperties,
  closeButton: {
    background: "none",
    border: "none",
    color: "var(--text-secondary)",
    fontSize: "18px",
    cursor: "pointer",
    padding: "0 4px",
    lineHeight: 1,
  } as React.CSSProperties,
  subHeader: {
    padding: "8px 16px",
    borderBottom: "1px solid var(--border-default)",
    flexShrink: 0,
  } as React.CSSProperties,
  subject: {
    color: "var(--text-primary)",
    fontSize: "var(--font-size)",
    fontWeight: 600,
    marginBottom: "2px",
  } as React.CSSProperties,
  bodyText: {
    color: "var(--text-primary)",
    fontSize: "var(--font-size)",
    whiteSpace: "pre-wrap" as const,
    marginBottom: "6px",
    borderLeft: "2px solid var(--border-default)",
    paddingLeft: "8px",
  } as React.CSSProperties,
  statsBar: {
    display: "flex",
    gap: "8px",
    fontSize: "var(--font-size-sm)",
    color: "var(--text-secondary)",
  } as React.CSSProperties,
  bodyContainer: {
    flex: 1,
    overflowY: "auto" as const,
    overflowX: "hidden" as const,
    padding: 0,
    position: "relative" as const,
  } as React.CSSProperties,
  message: {
    padding: "24px",
    textAlign: "center" as const,
    color: "var(--text-secondary)",
    fontSize: "var(--font-size)",
  } as React.CSSProperties,
  // Stat view styles
  statTable: {
    padding: "8px 0",
  } as React.CSSProperties,
  statRow: {
    display: "flex",
    alignItems: "center",
    padding: "3px 16px",
    gap: "12px",
    fontSize: "var(--font-size)",
    fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
  } as React.CSSProperties,
  statFile: {
    color: "var(--text-primary)",
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    minWidth: 0,
  } as React.CSSProperties,
  statNumbers: {
    fontSize: "var(--font-size)",
    whiteSpace: "nowrap" as const,
    minWidth: "70px",
    textAlign: "right" as const,
  } as React.CSSProperties,
  statBar: {
    display: "flex",
    alignItems: "center",
    flexShrink: 0,
    width: "120px",
  } as React.CSSProperties,
};
