import { useState } from "react";
import { useAppStore } from "../../store/appStore";
import { HavenLinkPicker } from "../LeftPanel/BacklogRow";

const TABS = ["In flight", "Blocked", "Backlog", "Done"] as const;

/**
 * The centre-area Haven workbench. CZ-45 builds the shell only — header, tab
 * strip and an empty body. CZ-46 feeds it a graph and CZ-47 fills the body.
 */
export default function BacklogWorkbench({ projectId }: { projectId: string }) {
  const project = useAppStore((s) => s.projects.find((p) => p.id === projectId));
  const havenInstalled = useAppStore((s) => s.havenInstalled);
  const [activeTab, setActiveTab] = useState<string>(TABS[0]);
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

  // State 3 — linked. The shell: header, tabs, and a body CZ-47 fills.
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
      <div style={styles.tabs} role="tablist">
        {TABS.map((tab) => {
          const selected = tab === activeTab;
          return (
            <button
              key={tab}
              role="tab"
              aria-selected={selected}
              style={{
                ...styles.tab,
                color: selected ? "var(--text-heading)" : "var(--text-secondary)",
                borderBottomColor: selected ? "var(--accent)" : "transparent",
              }}
              onClick={() => setActiveTab(tab)}
            >
              {tab}
              <span
                style={{
                  ...styles.tabCount,
                  color: selected ? "var(--text-primary)" : "var(--text-secondary)",
                }}
              >
                —
              </span>
            </button>
          );
        })}
      </div>
      <div style={styles.body} />
    </div>
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
  tabs: {
    display: "flex",
    gap: "2px",
    padding: "10px 16px 0",
    flex: "0 0 auto",
    borderBottom: "1px solid var(--border-default)",
  } as React.CSSProperties,
  tab: {
    font: "inherit",
    fontSize: "var(--font-size)",
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: "6px 12px 8px",
    borderBottom: "2px solid transparent",
    display: "flex",
    alignItems: "center",
    gap: "7px",
  } as React.CSSProperties,
  tabCount: {
    fontSize: "11px",
    minWidth: "19px",
    textAlign: "center" as const,
    padding: "1px 5px",
    borderRadius: "9px",
    background: "var(--bg-elevated)",
    fontVariantNumeric: "tabular-nums",
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
