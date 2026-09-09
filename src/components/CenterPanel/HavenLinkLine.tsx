import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../../store/appStore";
import type { Project } from "../../store/types";
import { havenLink } from "../../lib/haven";
import { linkedLineSegments, takenByOthers } from "../../lib/havenBinding";
import { refreshHavenBindings } from "../../hooks/useHavenBindings";
import { useHavenView } from "../../hooks/useHavenView";
import HavenProjectChooser from "./HavenProjectChooser";

const LINE_CSS = `
@keyframes cz-hv-spin { to { transform: rotate(360deg); } }
.cz-hv-busy::before { content: "↻ "; display: inline-block; animation: cz-hv-spin 0.6s linear infinite; }
`;

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
  // The user can switch projects mid-link; nothing may be written after that.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  if (havenInstalled !== true) return null;

  const onChoose = async (key: string) => {
    setChooserAnchor(null);
    setLinkError(null);
    setLinking(true);
    try {
      await havenLink(project.path, key);
      await refreshHavenBindings(project.id);
      if (!mounted.current) return;
      if (!useAppStore.getState().havenBindings[project.id]) {
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
      const segments = linkedLineSegments(
        listed?.title || binding,
        listed?.ref_prefix ?? null,
        view?.buckets?.live ?? null,
        view?.buckets?.ready.length ?? null,
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
                if (e.key === "Enter" || e.key === " ") selectBacklog(project.id);
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
      <style>{LINE_CSS}</style>
      <div style={styles.line}>{body()}</div>
      {linkError && <div style={styles.errorText}>{linkError}</div>}
      {chooserAnchor && (
        <HavenProjectChooser
          project={project}
          takenBy={takenByOthers(projects, bindings, project.id)}
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
