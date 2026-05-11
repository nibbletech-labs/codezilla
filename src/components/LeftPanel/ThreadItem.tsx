import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { useAppStore } from "../../store/appStore";
import type { ThreadBadge } from "../../store/transcriptTypes";
import { getThreadSubtitle, isThreadLikelyWorking } from "../../lib/threadRuntime";
import { timeAgo } from "../../lib/timeAgo";
import ThreadIcon from "./ThreadIcons";

interface ThreadItemProps {
  threadId: string;
  isActive: boolean;
  ageTick: number;
  onSelect: () => void;
}

const BADGE_COLORS: Record<string, string> = {
  done: "#73c991",
  needs_input: "#e5a63c",
  needs_approval: "#e5a63c",
  error: "#f14c4c",
};
const INDICATOR_SIZE = "calc(var(--font-size, 12px) * 2)";
const BADGE_DOT_SIZE = "calc(var(--font-size, 12px) * 1)";

function WorkingSpinner() {
  return (
    <svg
      viewBox="0 0 12 12"
      aria-label="Working"
      style={{
        width: INDICATOR_SIZE,
        height: INDICATOR_SIZE,
        flexShrink: 0,
        display: "inline-block",
      }}
    >
      <circle cx="6" cy="6" r="4.5" fill="none" stroke="var(--text-secondary)" strokeOpacity="0.35" strokeWidth="1.2" />
      <g>
        <ellipse cx="6" cy="1.7" rx="1.8" ry="1" fill="var(--text-secondary)" />
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 6 6"
          to="360 6 6"
          dur="0.9s"
          repeatCount="indefinite"
        />
      </g>
    </svg>
  );
}

function BadgeDot({ badge, isWorking }: { badge: ThreadBadge; isWorking: boolean }) {
  // Badge dots take priority over the working spinner — a badge is a more
  // specific signal (e.g. "done", "needs input") than generic "working".
  if (badge && BADGE_COLORS[badge]) {
    return (
      <span
        style={{
          width: BADGE_DOT_SIZE,
          height: BADGE_DOT_SIZE,
          borderRadius: "50%",
          backgroundColor: BADGE_COLORS[badge],
          flexShrink: 0,
          display: "inline-block",
        }}
      />
    );
  }

  if (isWorking) {
    return <WorkingSpinner />;
  }

  // Invisible placeholder to prevent jitter
  return (
    <span
      style={{
        width: INDICATOR_SIZE,
        height: INDICATOR_SIZE,
        flexShrink: 0,
        display: "inline-block",
      }}
    />
  );
}

export default function ThreadItem({ threadId, isActive, ageTick, onSelect }: ThreadItemProps) {
  const thread = useAppStore((s) => s.threads.find((t) => t.id === threadId));
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(thread?.name ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const renameThread = useAppStore((s) => s.renameThread);
  const removeThread = useAppStore((s) => s.removeThread);
  const renamingThreadId = useAppStore((s) => s.renamingThreadId);
  const clearRenamingThread = useAppStore((s) => s.clearRenamingThread);
  const sidebarOpenedForRename = useAppStore((s) => s.sidebarOpenedForRename);
  const [hovered, setHovered] = useState(false);

  const age = useMemo(
    () => thread ? timeAgo(thread.lastActivityAt) : "",
    [thread?.lastActivityAt, ageTick],
  );

  // Subscribe to transcript info for this thread
  const info = useAppStore((s) => s.transcriptInfo[threadId]);
  const rawSubtitle = thread
    ? getThreadSubtitle(thread, info)
    : { body: "", progress: null as string | null };
  const badge: ThreadBadge = info?.badge ?? null;
  // Derive the effective badge, but respect dismissal: if the user already
  // clicked this thread (badgeDismissedAt is set), don't surface a fresh badge
  // until the next state change.
  const badgeDismissed = info?.badgeDismissedAt != null;
  const effectiveBadge: ThreadBadge = (
    badge
    ?? (badgeDismissed
      ? null
      : (info?.activityState === "awaiting_input" ? "needs_input" : null))
  );
  const isWorking = thread ? isThreadLikelyWorking(thread, info) : false;
  // If we have a badge to show, prefer it over the working spinner or age
  const showActivityAge = !effectiveBadge && !isWorking;

  if (!thread) return null;

  // Defensive fallback: never render a blank subtitle when a thread is active.
  const displaySubtitle = {
    body: rawSubtitle.body.trim().length > 0
      ? rawSubtitle.body
      : (isWorking ? "Working" : "Idle"),
    progress: rawSubtitle.progress,
  };

  // Enter edit mode when triggered from title bar dropdown
  useEffect(() => {
    if (renamingThreadId === threadId) {
      setEditValue(thread.name);
      setEditing(true);
      clearRenamingThread();
    }
  }, [renamingThreadId, threadId, thread.name, clearRenamingThread]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commitRename = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== thread.name) {
      renameThread(threadId, trimmed);
    }
    setEditing(false);
    if (sidebarOpenedForRename) {
      useAppStore.setState({ sidebarOpenedForRename: false, showLeftPanel: false });
    }
  }, [editValue, threadId, thread.name, renameThread, sidebarOpenedForRename]);

  const handleClose = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isWorking) {
      const confirmed = await ask("This thread has a running process. Close it?", {
        title: "Close Thread",
        kind: "warning",
        okLabel: "Close",
        cancelLabel: "Cancel",
      });
      if (!confirmed) return;
    }
    removeThread(threadId);
  }, [threadId, removeThread, isWorking]);

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
          <div style={styles.textContent}>
            {/* Top row: icon + name + age/trash */}
            <div style={styles.nameRow}>
              <ThreadIcon type={thread.type} />
              <span style={styles.name}>{thread.name}</span>
            </div>
            {/* Bottom row: subtitle (body ellipsifies, plan-progress stays visible) */}
            <div style={styles.subtitleRow}>
              <span style={styles.subtitleBody}>{displaySubtitle.body}</span>
              {displaySubtitle.progress && (
                <span style={styles.subtitleProgress}>{displaySubtitle.progress}</span>
              )}
            </div>
          </div>
          <div style={styles.statusColumn}>
            {hovered
              ? (
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
              )
              : showActivityAge && age
              ? <span style={styles.age}>{age}</span>
              : <BadgeDot badge={effectiveBadge} isWorking={isWorking} />}
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
    alignItems: "center",
    gap: "6px",
    flex: 1,
    minWidth: 0,
  } as React.CSSProperties,
  textContent: {
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
    minWidth: 0,
  } as React.CSSProperties,
  statusColumn: {
    width: INDICATOR_SIZE,
    minWidth: INDICATOR_SIZE,
    alignSelf: "stretch",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  } as React.CSSProperties,
  subtitleBody: {
    color: "var(--text-primary)",
    fontSize: "var(--font-size-sm)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    flex: 1,
    minWidth: 0,
  } as React.CSSProperties,
  subtitleProgress: {
    color: "var(--text-primary)",
    fontSize: "var(--font-size-sm)",
    flexShrink: 0,
    marginLeft: 4,
    whiteSpace: "nowrap" as const,
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
    padding: 0,
    width: INDICATOR_SIZE,
    height: INDICATOR_SIZE,
    flexShrink: 0,
    lineHeight: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
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
