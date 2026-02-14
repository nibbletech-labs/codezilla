import { useState, useRef, useEffect, useCallback } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../../store/appStore";
import type { Thread } from "../../store/types";
import type { ThreadBadge } from "../../store/transcriptTypes";
import { getThreadSubtitle } from "../../lib/threadRuntime";
import { timeAgo } from "../../lib/timeAgo";
import ThreadIcon from "./ThreadIcons";

interface ThreadItemProps {
  thread: Thread;
  isActive: boolean;
  onSelect: () => void;
}

const BADGE_COLORS: Record<string, string> = {
  done: "#73c991",
  needs_input: "#e5a63c",
  needs_approval: "#e5a63c",
  error: "#f14c4c",
};

function BadgeDot({ badge }: { badge: ThreadBadge }) {
  if (badge && BADGE_COLORS[badge]) {
    return (
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          backgroundColor: BADGE_COLORS[badge],
          flexShrink: 0,
          display: "inline-block",
        }}
      />
    );
  }
  // Invisible placeholder to prevent jitter
  return (
    <span
      style={{
        width: 8,
        height: 8,
        flexShrink: 0,
        display: "inline-block",
      }}
    />
  );
}

export default function ThreadItem({ thread, isActive, onSelect }: ThreadItemProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(thread.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const renameThread = useAppStore((s) => s.renameThread);
  const removeThread = useAppStore((s) => s.removeThread);
  const renamingThreadId = useAppStore((s) => s.renamingThreadId);
  const clearRenamingThread = useAppStore((s) => s.clearRenamingThread);
  const sidebarOpenedForRename = useAppStore((s) => s.sidebarOpenedForRename);
  const [hovered, setHovered] = useState(false);

  // Periodic tick to keep age labels fresh
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const age = timeAgo(thread.lastActivityAt);

  // Subscribe to transcript info for this thread
  const info = useAppStore((s) => s.transcriptInfo[thread.id]);
  const rawSubtitle = getThreadSubtitle(thread, info);
  const badge: ThreadBadge = info?.badge ?? null;

  // Debounce "Waiting for ..." subtitles — in bypass-permission mode Claude
  // emits approval-like tool_use events that are auto-approved instantly, so
  // the waiting state flashes for a single frame.  Only show it if it persists
  // for 500ms; otherwise keep showing the previous subtitle.
  const [subtitle, setSubtitle] = useState(rawSubtitle);
  const waitingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const isWaiting = rawSubtitle.startsWith("Waiting for");
    if (isWaiting && !subtitle.startsWith("Waiting for")) {
      waitingTimerRef.current = setTimeout(() => {
        setSubtitle(rawSubtitle);
        waitingTimerRef.current = null;
      }, 500);
    } else if (isWaiting && rawSubtitle !== subtitle) {
      if (waitingTimerRef.current) {
        clearTimeout(waitingTimerRef.current);
        waitingTimerRef.current = null;
      }
      setSubtitle(rawSubtitle);
    } else if (!isWaiting) {
      if (waitingTimerRef.current) {
        clearTimeout(waitingTimerRef.current);
        waitingTimerRef.current = null;
      }
      setSubtitle(rawSubtitle);
    }
    return () => {
      if (waitingTimerRef.current) clearTimeout(waitingTimerRef.current);
    };
  }, [rawSubtitle]);

  // Enter edit mode when triggered from title bar dropdown
  useEffect(() => {
    if (renamingThreadId === thread.id) {
      setEditValue(thread.name);
      setEditing(true);
      clearRenamingThread();
    }
  }, [renamingThreadId, thread.id, thread.name, clearRenamingThread]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commitRename = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== thread.name) {
      renameThread(thread.id, trimmed);
    }
    setEditing(false);
    if (sidebarOpenedForRename) {
      useAppStore.setState({ sidebarOpenedForRename: false, showLeftPanel: false });
    }
  }, [editValue, thread.id, thread.name, renameThread, sidebarOpenedForRename]);

  const handleClose = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (info?.status === "working") {
      const confirmed = await ask("This thread has a running process. Close it?", {
        title: "Close Thread",
        kind: "warning",
        okLabel: "Close",
        cancelLabel: "Cancel",
      });
      if (!confirmed) return;
    }
    removeThread(thread.id);
  }, [thread.id, removeThread]);

  return (
    <div
      style={{
        ...styles.item,
        backgroundColor: isActive ? "var(--accent-selection)" : hovered ? "var(--bg-hover)" : "transparent",
        opacity: thread.state !== "running" ? 0.5 : 1,
      }}
      onClick={onSelect}
      onDoubleClick={() => {
        setEditValue(thread.name);
        setEditing(true);
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {editing ? (
        <input
          ref={inputRef}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") {
              setEditing(false);
              if (sidebarOpenedForRename) {
                useAppStore.setState({ sidebarOpenedForRename: false, showLeftPanel: false });
              }
            }
          }}
          onBlur={commitRename}
          style={styles.input}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <div style={styles.contentWrapper}>
          {/* Top row: icon + name + age/trash */}
          <div style={styles.nameRow}>
            <ThreadIcon type={thread.type} />
            <span style={styles.name}>{thread.name}</span>
            {hovered ? (
              <button
                onClick={handleClose}
                className="icon-btn"
                style={styles.trashButton}
                title="Delete thread"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 4h12M5.333 4V2.667a1.333 1.333 0 011.334-1.334h2.666a1.333 1.333 0 011.334 1.334V4M13 4v9.333a1.333 1.333 0 01-1.333 1.334H4.333A1.333 1.333 0 013 13.333V4h10z" />
                </svg>
              </button>
            ) : (
              age && <span style={styles.age}>{age}</span>
            )}
          </div>
          {/* Bottom row: subtitle + badge dot (right-aligned) */}
          <div style={styles.subtitleRow}>
            <span style={styles.subtitle}>{subtitle}</span>
            <BadgeDot badge={badge} />
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  item: {
    display: "flex",
    alignItems: "stretch",
    padding: "4px 6px",
    cursor: "pointer",
    borderRadius: "3px",
    marginBottom: "1px",
    transition: "background-color 0.1s ease",
  } as React.CSSProperties,
  contentWrapper: {
    display: "flex",
    flexDirection: "column" as const,
    flex: 1,
    minWidth: 0,
  } as React.CSSProperties,
  nameRow: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    minWidth: 0,
  } as React.CSSProperties,
  name: {
    color: "var(--text-primary)",
    fontSize: "var(--font-size)",
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  } as React.CSSProperties,
  subtitleRow: {
    display: "flex",
    alignItems: "center",
    height: "16px",
  } as React.CSSProperties,
  subtitle: {
    color: "var(--text-primary)",
    fontSize: "var(--font-size-sm)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    flex: 1,
  } as React.CSSProperties,
  age: {
    color: "var(--text-primary)",
    fontSize: "var(--font-size-sm)",
    fontFamily: "var(--font-mono, monospace)",
    flexShrink: 0,
    userSelect: "none" as const,
  } as React.CSSProperties,
  trashButton: {
    background: "none",
    border: "none",
    color: "var(--text-secondary)",
    cursor: "pointer",
    padding: "0 2px",
    flexShrink: 0,
    lineHeight: 1,
    display: "flex",
    alignItems: "center",
  } as React.CSSProperties,
  input: {
    background: "var(--bg-input)",
    border: "1px solid var(--accent)",
    color: "var(--text-primary)",
    fontSize: "var(--font-size)",
    padding: "2px 4px",
    borderRadius: "2px",
    outline: "none",
    width: "100%",
  },
};
