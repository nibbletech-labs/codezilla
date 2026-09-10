import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "../../store/appStore";
import type { Project } from "../../store/types";
import type { HavenProject } from "../../lib/haven";
import { chooserSections, folderNameOf } from "../../lib/havenBinding";
import { refreshHavenProjects } from "../../hooks/useHavenBindings";
import "../../styles/havenChooser.css";

/** Roughly the popup's full height, so a short window never clips the footer. */
const CHOOSER_HEIGHT = 380;

/** One shared empty list, so "not read yet" is a stable reference too. */
const NO_PROJECTS: HavenProject[] = [];

/**
 * The Haven project chooser behind the project page's `Link to Haven` button,
 * populated from `haven project list`.
 *
 * Free projects come first, alphabetically; the ones another Codezilla project
 * already holds follow under a divider, dimmed but still selectable. The row
 * matching the repo's folder name starts highlighted — that is what Enter
 * takes — without being reordered to the top.
 *
 * It writes nothing itself: `onChoose` hands the key back and the caller runs
 * `haven link`.
 */
export default function HavenProjectChooser({
  project,
  takenBy,
  anchor,
  onChoose,
  onClose,
}: {
  project: Project;
  /** Haven key → the name of the other Codezilla project already bound to it. */
  takenBy: Record<string, string>;
  anchor: { x: number; y: number };
  onChoose: (key: string) => void;
  onClose: () => void;
}) {
  // The store's copy is the list — `refreshHavenProjects` is its single owner,
  // so the rows here and the linked line's title can never disagree.
  const projects = useAppStore((s) => s.havenProjects) ?? NO_PROJECTS;
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  // Only a cold open waits: with a cached list the rows are there immediately
  // and the fresh read swaps in behind them.
  const [loading, setLoading] = useState(() => useAppStore.getState().havenProjects === null);
  const [error, setError] = useState<string | null>(null);
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    refreshHavenProjects()
      .then(() => {
        if (!cancelled) setLoading(false);
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
  }, []);

  // Worth keeping now that both inputs are stable references: `projects` is the
  // store's own array and `takenBy` is memoised by the caller, so this only
  // re-sorts when the list or the bindings actually change — not on every
  // keystroke that moves the highlight.
  const sections = useMemo(
    () => chooserSections(projects, takenBy, folderNameOf(project.path)),
    [projects, takenBy, project.path],
  );
  const { free, taken, ordered } = sections;

  // The initial highlight follows the list: it lands on the folder match as
  // soon as the projects arrive, and never fights a later hover or arrow key.
  const initialHighlight = sections.highlightKey;
  useEffect(() => {
    setHighlightedKey(initialHighlight);
  }, [initialHighlight]);

  const choose = useCallback(
    (key: string) => {
      onChoose(key);
    },
    [onChoose],
  );

  // Outside click closes, matching the thread-type menu.
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

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
    // Traversal follows `ordered` — free rows, then the taken ones — which is
    // exactly the order they are rendered in.
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

  const option = (p: HavenProject, boundBy: string | null) => (
    <div
      key={p.key}
      id={optionId(p.key)}
      role="option"
      aria-selected={p.key === highlightedKey}
      style={{
        ...styles.option,
        ...(boundBy ? styles.optionDim : null),
        backgroundColor: p.key === highlightedKey ? "var(--accent-selection)" : "transparent",
      }}
      onMouseEnter={() => setHighlightedKey(p.key)}
      onClick={() => choose(p.key)}
    >
      <span style={{ ...styles.optionTitle, ...(boundBy ? styles.optionTitleDim : null) }}>
        {p.title || p.key}
      </span>
      <span style={styles.optionKey}>{p.key}</span>
      {boundBy && <span style={styles.optionWhere}>{boundBy}</span>}
    </div>
  );

  // A `listbox` may only own `option` (and `group`) children, so the loading,
  // error and empty lines are children of the outer dialog and the listbox
  // holds nothing but options plus a presentational divider. Focus and
  // `aria-activedescendant` stay together on the listbox — a screen reader only
  // announces the active option when reading from the focused element.
  return createPortal(
    <div
      ref={containerRef}
      tabIndex={-1}
      role="dialog"
      aria-label="Link to Haven"
      onKeyDown={onKeyDown}
      style={{
        ...styles.menu,
        left: anchor.x,
        top: Math.max(8, Math.min(anchor.y, window.innerHeight - CHOOSER_HEIGHT)),
      }}
    >
      <div style={styles.header}>
        <span style={styles.headerTitle}>Link {project.name} to a Haven project</span>
        <span style={styles.headerCount}>
          {projects.length} {projects.length === 1 ? "project" : "projects"}
        </span>
      </div>
      {loading && <div style={styles.note}>Loading projects…</div>}
      {!loading && error && <div style={styles.errorNote}>{error}</div>}
      {!loading && !error && ordered.length === 0 && (
        <div style={styles.note}>No Haven projects yet</div>
      )}
      {hasOptions && (
        <div
          ref={listboxRef}
          tabIndex={-1}
          role="listbox"
          aria-label="Haven projects"
          aria-activedescendant={highlightedKey ? optionId(highlightedKey) : undefined}
          className="cz-chooser-list"
          style={styles.list}
        >
          {free.map((p) => option(p, null))}
          {taken.length > 0 && (
            <div role="presentation" aria-hidden="true" style={styles.sectionHeader}>
              Already linked in Codezilla
            </div>
          )}
          {taken.map((t) => option(t.project, t.boundBy))}
        </div>
      )}
      <div style={styles.footer}>
        haven link -p {highlightedKey ?? "<key>"} · {project.path}
      </div>
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
    padding: "6px 0",
    boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
    minWidth: "300px",
    maxWidth: "380px",
    textAlign: "left" as const,
    outline: "none",
  } as React.CSSProperties,
  header: {
    display: "flex",
    alignItems: "baseline",
    gap: "10px",
    padding: "6px 12px",
    fontSize: "var(--font-size-sm)",
    color: "var(--text-secondary)",
  } as React.CSSProperties,
  headerTitle: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  } as React.CSSProperties,
  headerCount: {
    flexShrink: 0,
    color: "var(--text-hint)",
    fontVariantNumeric: "tabular-nums" as const,
  } as React.CSSProperties,
  list: {
    maxHeight: "240px",
    overflowY: "auto" as const,
    overscrollBehavior: "contain" as const,
    scrollbarGutter: "stable" as const,
    outline: "none",
  } as React.CSSProperties,
  sectionHeader: {
    padding: "8px 12px 6px",
    marginTop: "4px",
    borderTop: "1px solid var(--border-subtle)",
    fontSize: "11px",
    color: "var(--text-secondary)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.5px",
  } as React.CSSProperties,
  option: {
    display: "flex",
    alignItems: "baseline",
    gap: "8px",
    padding: "5px 12px",
    cursor: "pointer",
    fontSize: "var(--font-size)",
    color: "var(--text-primary)",
  } as React.CSSProperties,
  optionDim: {
    color: "var(--text-secondary)",
  } as React.CSSProperties,
  optionTitle: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  } as React.CSSProperties,
  optionTitleDim: {
    opacity: 0.7,
  } as React.CSSProperties,
  optionKey: {
    fontSize: "var(--font-size-sm)",
    color: "var(--text-secondary)",
    flexShrink: 0,
  } as React.CSSProperties,
  optionWhere: {
    fontSize: "11px",
    color: "var(--text-hint)",
    flexShrink: 0,
  } as React.CSSProperties,
  note: {
    padding: "6px 12px",
    color: "var(--text-secondary)",
    fontSize: "var(--font-size-sm)",
  } as React.CSSProperties,
  errorNote: {
    padding: "6px 12px",
    color: "var(--text-secondary)",
    fontSize: "var(--font-size-sm)",
    fontFamily: "var(--font-mono, monospace)",
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
  } as React.CSSProperties,
  footer: {
    padding: "6px 12px 2px",
    marginTop: "4px",
    borderTop: "1px solid var(--border-subtle)",
    fontSize: "11px",
    color: "var(--text-hint)",
    fontFamily: "var(--font-mono, monospace)",
    userSelect: "text" as const,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  } as React.CSSProperties,
};
