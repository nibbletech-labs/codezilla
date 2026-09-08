import { useState } from "react";
import { useAppStore } from "../../store/appStore";
import { HavenLinkPicker } from "../LeftPanel/BacklogRow";
import { useHavenView } from "../../hooks/useHavenView";
import { refreshHavenGraph } from "../../hooks/useHavenLive";
import WorkbenchShell from "./WorkbenchShell";

/**
 * The centre-area Haven workbench. This file owns the four whole-view states
 * (§9); state 3 — the board itself — is `WorkbenchShell`.
 */
export default function BacklogWorkbench({ projectId }: { projectId: string }) {
  const project = useAppStore((s) => s.projects.find((p) => p.id === projectId));
  const havenInstalled = useAppStore((s) => s.havenInstalled);
  const result = useHavenView(project?.havenProjectKey);
  const [pickerAnchor, setPickerAnchor] = useState<{ x: number; y: number } | null>(null);

  if (!project) return null;

  // State 1 — Haven isn't installed.
  if (havenInstalled !== true) {
    return (
      <div style={styles.container}>
        <div style={styles.centred}>
          <div style={styles.stateTitle}>Haven isn't installed</div>
          <div style={styles.install}>brew install nibbletech-labs/tap/haven</div>
        </div>
      </div>
    );
  }

  // State 2 — installed, but this project has no binding yet.
  if (!project.havenProjectKey) {
    return (
      <div style={styles.container}>
        <div style={styles.centred}>
          <div style={styles.stateTitle}>This project isn't linked to Haven</div>
          <button
            style={styles.linkButton}
            onClick={(e) => {
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setPickerAnchor({ x: rect.left, y: rect.bottom + 4 });
            }}
          >
            Link to Haven
          </button>
        </div>
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

  // State 4 — the read failed with nothing to keep on screen: the stderr text
  // verbatim (that is how store-skew errors reach the user), and a retry.
  const error = result?.entry.error ?? null;
  const retry = () => refreshHavenGraph(project.havenProjectKey!);
  if (error && !result?.entry.graph) {
    return (
      <div style={styles.container}>
        <div style={styles.centred}>
          <div style={styles.stateTitle}>Haven could not read this project</div>
          <div style={styles.errorText}>{error}</div>
          <button style={styles.linkButton} onClick={retry} title="Read the graph again">
            Retry
          </button>
        </div>
      </div>
    );
  }

  // State 3 — linked: the board (§5–§9).
  const errorLine = error ? (
    // A failed re-read keeps the last good board; this line says so rather than
    // throwing the view away.
    <div style={styles.errorLine}>
      <span style={styles.errorText}>{error}</span>
      <button
        style={styles.retryInline}
        className="icon-btn"
        onClick={retry}
        title="Read the graph again"
      >
        Retry
      </button>
    </div>
  ) : null;

  if (!result?.view || !result.buckets) {
    // Linked, but the first read has not landed yet.
    return (
      <div style={styles.container}>
        <div style={styles.head}>
          <span style={styles.h1}>
            Backlog
            <span style={styles.key}>
              {project.name} · {project.havenProjectKey}
            </span>
          </span>
        </div>
        {errorLine}
        <div style={styles.body} />
      </div>
    );
  }

  return (
    <WorkbenchShell
      name={project.name}
      projectKey={project.havenProjectKey}
      result={result}
      onRefresh={retry}
      errorLine={errorLine}
    />
  );
}

const styles = {
  container: {
    position: "absolute" as const,
    inset: 0,
    zIndex: 15,
    background: "var(--bg-primary)",
    display: "flex",
    flexDirection: "column" as const,
    overflow: "hidden",
  } as React.CSSProperties,
  head: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "11px 16px 0",
    flex: "0 0 auto",
  } as React.CSSProperties,
  h1: {
    fontSize: "calc(var(--font-size) + 1px)",
    fontWeight: 600,
    color: "var(--text-heading)",
  } as React.CSSProperties,
  key: {
    color: "var(--text-secondary)",
    fontWeight: 400,
    marginLeft: "7px",
    fontSize: "var(--font-size-sm)",
  } as React.CSSProperties,
  body: {
    flex: 1,
    minHeight: 0,
  } as React.CSSProperties,
  centred: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    gap: "10px",
    flex: 1,
    color: "var(--text-secondary)",
    fontSize: "var(--font-size)",
  } as React.CSSProperties,
  stateTitle: {
    color: "var(--text-primary)",
    fontSize: "calc(var(--font-size) + 2px)",
  } as React.CSSProperties,
  errorLine: {
    display: "flex",
    alignItems: "flex-start",
    gap: "10px",
    padding: "6px 16px 0",
    flex: "0 0 auto",
  } as React.CSSProperties,
  errorText: {
    fontFamily: "var(--font-mono, monospace)",
    fontSize: "var(--font-size-sm)",
    color: "var(--text-secondary)",
    whiteSpace: "pre-wrap" as const,
    userSelect: "text" as const,
    maxWidth: "620px",
  } as React.CSSProperties,
  retryInline: {
    font: "inherit",
    fontSize: "var(--font-size-sm)",
    background: "none",
    border: "none",
    color: "var(--accent)",
    cursor: "pointer",
    padding: "0 4px",
  } as React.CSSProperties,
  install: {
    fontFamily: "var(--font-mono, monospace)",
    fontSize: "var(--font-size-sm)",
    color: "var(--text-secondary)",
    userSelect: "text" as const,
    padding: "4px 10px",
    borderRadius: "4px",
    background: "var(--bg-elevated)",
  } as React.CSSProperties,
  linkButton: {
    color: "var(--accent)",
    background: "none",
    border: "1px solid var(--accent)",
    fontSize: "var(--font-size-sm)",
    borderRadius: "3px",
    padding: "3px 10px",
    cursor: "pointer",
  } as React.CSSProperties,
};
