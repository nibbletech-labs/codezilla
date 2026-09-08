import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "../../store/appStore";
import type { Project } from "../../store/types";
import { havenListProjects, havenSuggestProjectKey, type HavenProject } from "../../lib/haven";
import { orderProjectsForPicker, pickerLabel } from "../../lib/havenBinding";

/**
 * Project picker for `Link to Haven`, populated from `haven project list`. If
 * the repo already carries a `_haven/items` symlink, that project leads the
 * list and is the one Enter picks.
 *
 * Shared by the sidebar's Backlog row and the workbench's unlinked state, so it
 * lives here rather than inside either of them.
 */
export default function HavenLinkPicker({
  project,
  anchor,
  onClose,
}: {
  project: Project;
  anchor: { x: number; y: number };
  onClose: () => void;
}) {
  const setProjectHavenKey = useAppStore((s) => s.setProjectHavenKey);
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
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
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  const suggestionListed = suggestedKey !== null && projects.some((p) => p.key === suggestedKey);
  const optionId = (key: string) => `haven-project-${project.id}-${key}`;
  const hasOptions = !loading && !error && ordered.length > 0;

  // The menu takes focus so its keys are its own: a listener on `document`
  // would swallow the arrow keys of everything else on screen while it is open.
  // Exactly one element is focused per state: the listbox once there are
  // options to point `aria-activedescendant` at, and the outer container while
  // loading, on an error, or when the list is empty — so Escape still works
  // before any option exists. The single `onKeyDown` lives on the container and
  // sees the listbox's keys by bubbling, so it never runs twice.
  useEffect(() => {
    (hasOptions ? listboxRef.current : containerRef.current)?.focus();
  }, [hasOptions]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
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

  // A `listbox` may only own `option`/`group` children, so the loading, error,
  // empty and suggestion lines are children of the outer container and the
  // listbox holds nothing but options. Focus and `aria-activedescendant` stay
  // together on the listbox — a screen reader only announces the active option
  // when it is reading from the focused element.
  return createPortal(
    <div
      ref={containerRef}
      tabIndex={-1}
      role="dialog"
      aria-label="Link to Haven"
      onKeyDown={onKeyDown}
      style={{ ...styles.menu, left: anchor.x, top: anchor.y }}
    >
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
      {hasOptions && (
        <div
          ref={listboxRef}
          tabIndex={-1}
          role="listbox"
          aria-label="Haven projects"
          aria-activedescendant={highlightedKey ? optionId(highlightedKey) : undefined}
          style={styles.listbox}
        >
          {ordered.map((p) => (
            <div
              key={p.key}
              id={optionId(p.key)}
              role="option"
              aria-selected={p.key === highlightedKey}
              style={{
                ...styles.menuItem,
                backgroundColor:
                  p.key === highlightedKey ? "var(--accent-selection)" : "transparent",
              }}
              onMouseEnter={() => setHighlightedKey(p.key)}
              onClick={() => choose(p.key)}
            >
              <span style={styles.menuItemLabel}>{pickerLabel(p)}</span>
              <span style={styles.menuItemKey}>{p.key}</span>
            </div>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}

const styles = {
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
    outline: "none",
  } as React.CSSProperties,
  listbox: {
    outline: "none",
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
