import { useState, useEffect, useRef, useCallback } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAppStore } from "../../store/appStore";
import { useGitDiffStat } from "../../hooks/useGitDiffStat";
import { getLeftPanelWidth } from "../../lib/constants";
import TitleBarDropdown from "./TitleBarDropdown";

const SIDEBAR_TRANSITION = "220ms cubic-bezier(0.22, 1, 0.36, 1)";

export default function TitleBar() {
  const thread = useAppStore((s) => s.getActiveThread());
  const project = useAppStore((s) => s.getActiveProject());
  const showLeftPanel = useAppStore((s) => s.showLeftPanel);
  const showRightPanel = useAppStore((s) => s.showRightPanel);
  const toggleLeftPanel = useAppStore((s) => s.toggleLeftPanel);
  const toggleRightPanel = useAppStore((s) => s.toggleRightPanel);
  const baseFontSize = useAppStore((s) => s.baseFontSize);
  const projectPath = project?.path ?? null;
  const diffStat = useGitDiffStat(projectPath);
  const leftPanelWidth = getLeftPanelWidth(baseFontSize);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fsTransition, setFsTransition] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const prevFullscreen = useRef(false);

  useEffect(() => {
    const win = getCurrentWindow();
    const check = () => {
      win.isFullscreen().then((fs) => {
        if (fs !== prevFullscreen.current) {
          prevFullscreen.current = fs;
          // Suppress transitions during fullscreen toggle
          setFsTransition(true);
          setIsFullscreen(fs);
          requestAnimationFrame(() => {
            requestAnimationFrame(() => setFsTransition(false));
          });
        }
      }).catch(() => {});
    };
    check();
    const unlisten = win.onResized(() => check());
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  const handleDrag = useCallback((e: React.MouseEvent) => {
    // Don't drag when interacting with controls inside the title bar.
    if ((e.target as HTMLElement).closest("button, input, textarea, select, a")) return;
    void getCurrentWindow().startDragging().catch((err) => {
      console.error("Failed to start window dragging:", err);
    });
  }, []);

  const getAnchorRect = useCallback(() => {
    if (!moreRef.current) return { x: 0, y: 0, width: 0, height: 0 };
    const r = moreRef.current.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }, []);

  const projectName = project?.name ?? "Codezilla";
  const leftInset = isFullscreen ? 12 : 78;
  const leftZoneWidth = leftInset + 24;
  const labelTargetLeft = showLeftPanel ? leftPanelWidth + 12 : leftZoneWidth + 16;
  const centerOffset = Math.max(12, labelTargetLeft - leftZoneWidth);

  return (
    <div style={styles.bar} onMouseDown={handleDrag}>
      {/* Left zone */}
      <div style={{ ...styles.leftZone, paddingLeft: `${leftInset}px`, transition: fsTransition ? "none" : "padding-left 0.3s ease" }}>
        <button
          onClick={toggleLeftPanel}
          style={{
            ...styles.iconBtn,
            color: showLeftPanel ? "var(--text-primary)" : "var(--text-hint)",
          }}
          title="Toggle sidebar"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
            <line x1="5.5" y1="2.5" x2="5.5" y2="13.5" />
          </svg>
        </button>
      </div>

      {/* Center zone */}
      <div
        style={{
          ...styles.centerZone,
          paddingLeft: `${centerOffset}px`,
          transition: fsTransition ? "none" : `padding-left ${SIDEBAR_TRANSITION}`,
        }}
      >
        <div style={styles.centerLabels}>
          {thread ? (
            <>
              <span style={styles.threadName}>{thread.name}</span>
              <span style={styles.projectLabel}>{projectName}</span>
            </>
          ) : (
            <span style={styles.threadName}>{projectName}</span>
          )}
        </div>
        {thread && (
          <button
            ref={moreRef}
            onClick={() => setDropdownOpen((v) => !v)}
            style={styles.moreBtn}
            title="Thread options"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <circle cx="4" cy="8" r="1.5" />
              <circle cx="8" cy="8" r="1.5" />
              <circle cx="12" cy="8" r="1.5" />
            </svg>
          </button>
        )}
      </div>

      {/* Right zone */}
      <div style={styles.rightZone}>
        {diffStat !== null && (
          <span style={styles.diffStat}>
            {diffStat.added === 0 && diffStat.removed === 0 ? (
              <span title="Working directory clean" style={{ color: "#89d185" }}>&#x2713;</span>
            ) : (
              <>
                <span style={{ color: "#89d185" }}>+{diffStat.added}</span>
                {" "}
                <span style={{ color: "#f48771" }}>-{diffStat.removed}</span>
              </>
            )}
          </span>
        )}
        <button
          onClick={toggleRightPanel}
          style={{
            ...styles.iconBtn,
            color: showRightPanel ? "var(--text-primary)" : "var(--text-hint)",
          }}
          title="Toggle file panel"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
            <line x1="10.5" y1="2.5" x2="10.5" y2="13.5" />
          </svg>
        </button>
      </div>

      {dropdownOpen && (
        <TitleBarDropdown
          anchorRect={getAnchorRect()}
          onClose={() => setDropdownOpen(false)}
        />
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    minHeight: "38px",
    padding: "6px 0",
    boxSizing: "border-box" as const,
    display: "flex",
    alignItems: "center",
    backgroundColor: "var(--bg-panel)",
    userSelect: "none",
    position: "relative",
    zIndex: 100,
  } as React.CSSProperties,
  leftZone: {
    display: "flex",
    alignItems: "center",
    flexShrink: 0,
  },
  centerZone: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-start",
    gap: "4px",
    minWidth: 0,
    overflow: "hidden",
    paddingLeft: "8px",
  },
  centerLabels: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    minWidth: 0,
    overflow: "hidden",
  },
  moreBtn: {
    background: "none",
    border: "none",
    color: "var(--text-secondary)",
    cursor: "pointer",
    padding: "4px",
    borderRadius: "4px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 1,
    flexShrink: 0,
  } as React.CSSProperties,
  rightZone: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    paddingRight: "12px",
    flexShrink: 0,
  },
  threadName: {
    color: "var(--text-primary)",
    fontSize: "calc(var(--font-size) + 1px)",
    fontWeight: 600,
    whiteSpace: "nowrap" as const,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  projectLabel: {
    color: "var(--text-secondary)",
    fontSize: "calc(var(--font-size) + 1px)",
    fontWeight: 400,
    whiteSpace: "nowrap" as const,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  diffStat: {
    fontFamily: "monospace",
    fontSize: "var(--font-size-sm)",
    whiteSpace: "nowrap" as const,
  },
  iconBtn: {
    background: "none",
    border: "none",
    color: "var(--text-primary)",
    cursor: "pointer",
    padding: "4px",
    borderRadius: "4px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    lineHeight: 1,
  } as React.CSSProperties,
};
