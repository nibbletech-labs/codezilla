import { useState } from "react";
import { useAppStore } from "../../store/appStore";
import type { Project } from "../../store/types";
import { backlogRowMode } from "../../lib/havenBinding";
import HavenLinkPicker from "../Backlog/HavenLinkPicker";

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

const styles = {
  // No bottom padding: the project body already pads, and the Backlog line sits
  // in the same rhythm as the thread rows under it.
  body: {
    paddingLeft: "8px",
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
};
