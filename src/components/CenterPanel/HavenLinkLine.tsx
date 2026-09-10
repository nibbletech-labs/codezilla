import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../../store/appStore";
import type { Project } from "../../store/types";
import { havenLink } from "../../lib/haven";
import { linkedCounts, linkedLineSegments, takenByOthers } from "../../lib/havenBinding";
import { refreshHavenBindings } from "../../hooks/useHavenBindings";
import { useHavenView } from "../../hooks/useHavenView";
import HavenProjectChooser from "./HavenProjectChooser";
import "../../styles/havenLinkLine.css";

/**
 * The project page's one line about Haven, under the session buttons.
 *
 * Four states: nothing at all without the CLI, a reserved blank line until the
 * binding read lands (so the buttons above never shift), the quiet
 * `Link to Haven` button when the repo carries no binding, and the linked line
 * — title, prefix, live and ready counts, `Open backlog` — when it does.
 *
 * Codezilla stores no binding of its own: linking runs `haven link -p <key>` in
 * the repo and then re-reads the repo's `.haven-project`, which is the only
 * source of truth.
 */
export default function HavenLinkLine({ project }: { project: Project }) {
  // Every hook runs unconditionally, before the "no Haven" early return.
  const havenInstalled = useAppStore((s) => s.havenInstalled);
  const binding = useAppStore((s) => s.havenBindings[project.id]);
  const havenProjects = useAppStore((s) => s.havenProjects);
  const projects = useAppStore((s) => s.projects);
  const bindings = useAppStore((s) => s.havenBindings);
  const selectBacklog = useAppStore((s) => s.selectBacklog);
  const view = useHavenView(binding ?? undefined);
  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [chooserAnchor, setChooserAnchor] = useState<{ x: number; y: number } | null>(null);
  // The user can leave the project page mid-link — start a session, open the
  // backlog — and nothing may be written after that. Switching to *another*
  // project is a different matter: the `key` on this component in Terminal.tsx
  // remounts it, so this ref never has to reason about whose link it was.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A binding that has landed is the answer, whatever the last attempt said —
  // including a link the user completed in a terminal after an in-app failure.
  useEffect(() => {
    if (binding) setLinkError(null);
  }, [binding]);

  // Stable across the chooser's own renders, so its `chooserSections` memo
  // actually holds.
  const takenBy = useMemo(
    () => takenByOthers(projects, bindings, project.id),
    [projects, bindings, project.id],
  );

  if (havenInstalled !== true) return null;

  const onChoose = async (key: string) => {
    setChooserAnchor(null);
    setLinkError(null);
    setLinking(true);
    try {
      await havenLink(project.path, key);
      const outcome = await refreshHavenBindings(project.id);
      if (!mounted.current) return;
      // Only a *successful* re-read that came back unbound proves the marker
      // file is missing. A read that failed or was superseded says nothing
      // about the repo, and must not be reported as a broken link.
      if (outcome.status === "read" && outcome.key === null) {
        setLinkError(`haven link succeeded but ${project.path}/.haven-project was not found`);
      }
    } catch (e) {
      // The CLI's stderr verbatim — that is how a bad key or a store-skew
      // error reaches the user.
      if (mounted.current) setLinkError(typeof e === "string" ? e : String(e));
    } finally {
      if (mounted.current) setLinking(false);
    }
  };

  const body = () => {
    if (linking) return <span className="cz-hv-busy" style={styles.busy}>Linking to Haven…</span>;
    // `undefined` is "not read yet" — hold the line's height and say nothing.
    if (binding === undefined) return null;
    if (binding) {
      const listed = havenProjects?.find((p) => p.key === binding);
      const { live, ready } = linkedCounts(view?.buckets);
      const segments = linkedLineSegments(
        listed?.title || binding,
        listed?.ref_prefix ?? null,
        live,
        ready,
      );
      return (
        <>
          {segments.map((segment, i) => (
            <span key={i} style={styles.segmentGroup}>
              {i > 0 && <span style={styles.dot}>·</span>}
              <span style={i === 0 ? styles.title : undefined}>{segment}</span>
            </span>
          ))}
          <span style={styles.segmentGroup}>
            <span style={styles.dot}>·</span>
            <span
              style={styles.open}
              role="button"
              tabIndex={0}
              onClick={() => selectBacklog(project.id)}
              onKeyDown={(e) => {
                // Space would scroll the page and Enter can submit an ancestor
                // form; the key press is ours either way.
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  selectBacklog(project.id);
                }
              }}
            >
              Open backlog
            </span>
          </span>
        </>
      );
    }
    return (
      <LinkButton
        onClick={(e) => {
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setChooserAnchor({ x: rect.left, y: rect.bottom + 4 });
        }}
      />
    );
  };

  return (
    <div style={styles.wrap}>
      <div style={styles.line}>{body()}</div>
      {linkError && <div style={styles.errorText}>{linkError}</div>}
      {chooserAnchor && (
        <HavenProjectChooser
          project={project}
          takenBy={takenBy}
          anchor={chooserAnchor}
          onChoose={onChoose}
          onClose={() => setChooserAnchor(null)}
        />
      )}
    </div>
  );
}

/** `RemoveProjectButton`'s neutral look, without the red. */
function LinkButton({ onClick }: { onClick: (e: React.MouseEvent) => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: "none",
        border: "1px solid var(--border-medium)",
        borderColor: hovered ? "var(--accent)" : "var(--border-medium)",
        color: hovered ? "var(--text-primary)" : "var(--text-secondary)",
        fontSize: "var(--font-size-sm)",
        padding: "4px 12px",
        borderRadius: "4px",
        cursor: "pointer",
        fontFamily: "inherit",
        transition: "color 0.15s, border-color 0.15s",
      }}
    >
      Link to Haven
    </button>
  );
}

const styles = {
  wrap: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    gap: "6px",
  } as React.CSSProperties,
  line: {
    marginTop: "14px",
    display: "flex",
    alignItems: "center",
    gap: "6px",
    fontSize: "var(--font-size-sm)",
    color: "var(--text-secondary)",
    // Reserved so the buttons above never shift when the read lands.
    minHeight: "26px",
  } as React.CSSProperties,
  segmentGroup: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
  } as React.CSSProperties,
  title: {
    color: "var(--text-primary)",
  } as React.CSSProperties,
  dot: {
    color: "var(--text-hint)",
  } as React.CSSProperties,
  open: {
    color: "var(--accent)",
    cursor: "pointer",
  } as React.CSSProperties,
  busy: {
    fontSize: "var(--font-size-sm)",
    color: "var(--text-secondary)",
  } as React.CSSProperties,
  errorText: {
    fontFamily: "var(--font-mono, monospace)",
    fontSize: "var(--font-size-sm)",
    color: "var(--text-secondary)",
    whiteSpace: "pre-wrap" as const,
    userSelect: "text" as const,
    maxWidth: "560px",
    textAlign: "left" as const,
  } as React.CSSProperties,
};
