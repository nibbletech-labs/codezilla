import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "../../store/appStore";
import type { Project } from "../../store/types";
import { havenListProjects, havenSuggestProjectKey, type HavenProject } from "../../lib/haven";
import { backlogRowMode, orderProjectsForPicker, pickerLabel } from "../../lib/havenBinding";

/**
 * The Backlog line under a project name. Three states, all decided by
 * `backlogRowMode`: nothing at all when Haven isn't installed, a
 * `Link to Haven` button when the project has no binding, and the row itself
 * once it does.
 */
export default function ProjectBacklogRow({
  project,
  liveCount,
}: {
  project: Project;
  /** Live item count, once CZ-46 can supply one. `—` until then. */
  liveCount?: number | null;
}) {
  const havenInstalled = useAppStore((s) => s.havenInstalled);
  const isActive = useAppStore((s) => s.activeBacklogProjectId === project.id);
  const selectBacklog = useAppStore((s) => s.selectBacklog);
  const [hovered, setHovered] = useState(false);
  const [pickerAnchor, setPickerAnchor] = useState<{ x: number; y: number } | null>(null);

  const mode = backlogRowMode(havenInstalled, project.havenProjectKey);
  if (mode === "none") return null;

  const rowStyle: React.CSSProperties = {
    ...styles.row,
    backgroundColor: isActive
      ? "var(--accent-selection)"
      : hovered && mode === "backlog"
        ? "var(--bg-hover)"
        : "transparent",
  };

  return (
    <div style={styles.body}>
      {mode === "backlog" ? (
        <div
          style={rowStyle}
          onClick={() => selectBacklog(project.id)}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          title="Haven backlog"
        >
          <span style={styles.name}>Backlog</span>
          <span style={styles.count}>{liveCount == null ? "—" : `${liveCount} live`}</span>
        </div>
      ) : (
        <div style={styles.row}>
          <button
            style={styles.linkButton}
            className="icon-btn"
            onClick={(e) => {
              // The project row is a dnd-kit drag handle; keep the click here.
              e.stopPropagation();
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setPickerAnchor({ x: rect.left, y: rect.bottom + 4 });
            }}
          >
            Link to Haven
          </button>
        </div>
      )}
      {pickerAnchor && (
        <HavenLinkPicker
          project={project}
          anchor={pickerAnchor}
          onClose={() => setPickerAnchor(null)}
        />
      )}
    </div>
  );
}

/**
 * Project picker for `Link to Haven`, populated from `haven project list`. If
 * the repo already carries a `_haven/items` symlink, that project leads the
 * list and is the one Enter picks.
 */
export function HavenLinkPicker({
  project,
  anchor,
  onClose,
}: {
  project: Project;
  anchor: { x: number; y: number };
  onClose: () => void;
}) {
  const setProjectHavenKey = useAppStore((s) => s.setProjectHavenKey);
  const menuRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<HavenProject[]>([]);
  const [suggestedKey, setSuggestedKey] = useState<string | null>(null);
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      havenListProjects(),
      havenSuggestProjectKey(project.path).catch(() => null),
    ])
      .then(([listed, suggestion]) => {
        if (cancelled) return;
        setProjects(listed);
        setSuggestedKey(suggestion);
        setHighlightedKey(
          listed.some((p) => p.key === suggestion) ? suggestion : (listed[0]?.key ?? null),
        );
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        // Haven's own words — that is how store-skew errors reach the user.
        setError(typeof e === "string" ? e : String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project.path]);

  const ordered = useMemo(
    () => orderProjectsForPicker(projects, suggestedKey),
    [projects, suggestedKey],
  );

  const choose = useCallback(
    (key: string) => {
      setProjectHavenKey(project.id, key);
      onClose();
    },
    [project.id, setProjectHavenKey, onClose],
  );

  // Outside click closes, matching the thread-type menu.
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (ordered.length === 0) return;
      const idx = ordered.findIndex((p) => p.key === highlightedKey);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightedKey(ordered[Math.min(idx + 1, ordered.length - 1)]?.key ?? null);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightedKey(ordered[Math.max(idx - 1, 0)]?.key ?? null);
      } else if (e.key === "Enter" && highlightedKey) {
        e.preventDefault();
        choose(highlightedKey);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [ordered, highlightedKey, choose, onClose]);

  const suggestionListed = suggestedKey !== null && projects.some((p) => p.key === suggestedKey);

  return createPortal(
    <div ref={menuRef} style={{ ...styles.menu, left: anchor.x, top: anchor.y }}>
      {loading && <div style={styles.menuNote}>Loading projects…</div>}
      {!loading && error && <div style={styles.menuError}>{error}</div>}
      {!loading && !error && ordered.length === 0 && (
        <div style={styles.menuNote}>No Haven projects yet</div>
      )}
      {!loading && !error && suggestionListed && (
        <div style={styles.menuNote}>
          This looks like Haven project <code style={styles.code}>{suggestedKey}</code> — link?
        </div>
      )}
      {!loading &&
        !error &&
        ordered.map((p) => (
          <div
            key={p.key}
            role="option"
            aria-selected={p.key === highlightedKey}
            style={{
              ...styles.menuItem,
              backgroundColor:
                p.key === highlightedKey ? "var(--accent-selection)" : "transparent",
            }}
            onMouseEnter={() => setHighlightedKey(p.key ?? null)}
            onClick={() => p.key && choose(p.key)}
          >
            <span style={styles.menuItemLabel}>{pickerLabel(p)}</span>
            <span style={styles.menuItemKey}>{p.key}</span>
          </div>
        ))}
    </div>,
    document.body,
  );
}

const styles = {
  body: {
    paddingLeft: "8px",
    paddingBottom: "4px",
  } as React.CSSProperties,
  row: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "4px 6px",
    borderRadius: "3px",
    marginBottom: "1px",
    cursor: "pointer",
    fontSize: "var(--font-size)",
    transition: "background-color 0.1s ease",
  } as React.CSSProperties,
  name: {
    flex: 1,
    minWidth: 0,
    color: "var(--text-primary)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  } as React.CSSProperties,
  count: {
    color: "var(--text-secondary)",
    fontSize: "var(--font-size-sm)",
    flexShrink: 0,
  } as React.CSSProperties,
  linkButton: {
    color: "var(--accent)",
    background: "none",
    border: "1px solid var(--accent)",
    fontSize: "var(--font-size-sm)",
    borderRadius: "3px",
    padding: "2px 8px",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "background-color 0.1s ease, color 0.1s ease",
  } as React.CSSProperties,
  menu: {
    position: "fixed" as const,
    zIndex: 1000,
    backgroundColor: "var(--bg-panel)",
    border: "1px solid var(--border-default)",
    borderRadius: "6px",
    padding: "4px 0",
    boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
    minWidth: "220px",
    maxWidth: "320px",
    maxHeight: "320px",
    overflowY: "auto" as const,
  } as React.CSSProperties,
  menuNote: {
    padding: "6px 10px",
    color: "var(--text-secondary)",
    fontSize: "var(--font-size-sm)",
  } as React.CSSProperties,
  menuError: {
    padding: "6px 10px",
    color: "var(--text-secondary)",
    fontSize: "var(--font-size-sm)",
    fontFamily: "var(--font-mono, monospace)",
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
  } as React.CSSProperties,
  code: {
    fontFamily: "var(--font-mono, monospace)",
    color: "var(--text-primary)",
  } as React.CSSProperties,
  menuItem: {
    display: "flex",
    alignItems: "baseline",
    gap: "6px",
    padding: "5px 10px",
    cursor: "pointer",
    fontSize: "var(--font-size)",
    color: "var(--text-primary)",
  } as React.CSSProperties,
  menuItemLabel: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  } as React.CSSProperties,
  menuItemKey: {
    color: "var(--text-secondary)",
    fontSize: "var(--font-size-sm)",
    flexShrink: 0,
  } as React.CSSProperties,
};
