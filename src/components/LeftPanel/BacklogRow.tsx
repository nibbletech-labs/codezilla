import { useState } from "react";
import { useAppStore } from "../../store/appStore";
import { showBacklogRow } from "../../lib/havenBinding";

/**
 * The Backlog line under a project name. Two states: nothing at all unless
 * Haven is installed *and* this project's repo is bound to a Haven project, and
 * the row itself when it is. Linking lives on the project page, so there is no
 * sidebar affordance for an unbound project.
 */
export default function ProjectBacklogRow({
  projectId,
  havenKey,
  liveCount,
}: {
  projectId: string;
  /**
   * The Haven key this project's repo is bound to, straight from
   * `store.havenBindings`: a key, `null` for checked-and-unbound, `undefined`
   * before the first read.
   */
  havenKey: string | null | undefined;
  /** Live item count, once the graph read lands. `—` until then. */
  liveCount?: number | null;
}) {
  const havenInstalled = useAppStore((s) => s.havenInstalled);
  const isActive = useAppStore((s) => s.activeBacklogProjectId === projectId);
  const selectBacklog = useAppStore((s) => s.selectBacklog);
  const [hovered, setHovered] = useState(false);

  if (!showBacklogRow(havenInstalled, havenKey)) return null;

  const rowStyle: React.CSSProperties = {
    ...styles.row,
    backgroundColor: isActive
      ? "var(--accent-selection)"
      : hovered
        ? "var(--bg-hover)"
        : "transparent",
  };

  return (
    <div style={styles.body}>
      <div
        style={rowStyle}
        onClick={() => selectBacklog(projectId)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        title="Haven backlog"
      >
        <span style={styles.name}>Backlog</span>
        <span style={styles.count}>{liveCount == null ? "—" : `${liveCount} live`}</span>
      </div>
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
};
