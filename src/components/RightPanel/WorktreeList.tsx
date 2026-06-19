import { useMemo, useState } from "react";
import { useAppStore } from "../../store/appStore";

/**
 * The WORKTREES section: one row per environment — main always first (selects
 * null), then every non-main git worktree. Each row shows the env's uncommitted
 * +/- totals from store.envDiffStats. Clicking re-roots the file panel to that
 * env via setSelectedEnvPath. Rows are built outside any Zustand selector so a
 * selector never returns a fresh array (the known infinite-re-render trap).
 */
export default function WorktreeList() {
  const worktrees = useAppStore((s) => s.worktrees);
  const selectedEnvPath = useAppStore((s) => s.selectedEnvPath);
  const envDiffStats = useAppStore((s) => s.envDiffStats);
  const setSelectedEnvPath = useAppStore((s) => s.setSelectedEnvPath);
  const projectPath = useAppStore(
    (s) => s.projects.find((p) => p.id === s.activeProjectId)?.path ?? null,
  );

  const rows = useMemo(() => {
    const list: { key: string; label: string; envPath: string | null }[] = [
      { key: projectPath ?? "main", label: "main", envPath: null },
    ];
    for (const wt of worktrees) {
      if (wt.source === "main") continue;
      const label = wt.branch ?? (wt.detached ? "detached" : (wt.path.split("/").pop() || wt.path));
      list.push({ key: wt.path, label, envPath: wt.path });
    }
    return list;
  }, [worktrees, projectPath]);

  return (
    <div style={styles.list}>
      {rows.map((row) => {
        const diff = envDiffStats[row.envPath ?? (projectPath ?? "main")];
        return (
          <WorktreeRow
            key={row.key}
            label={row.label}
            selected={selectedEnvPath === row.envPath}
            added={diff?.added ?? 0}
            removed={diff?.removed ?? 0}
            onClick={() => setSelectedEnvPath(row.envPath)}
          />
        );
      })}
    </div>
  );
}

function WorktreeRow({
  label,
  selected,
  added,
  removed,
  onClick,
}: {
  label: string;
  selected: boolean;
  added: number;
  removed: number;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      style={{
        ...styles.row,
        backgroundColor: selected
          ? "var(--accent-selection)"
          : hovered
            ? "var(--bg-hover)"
            : "transparent",
      }}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={label}
    >
      <span style={styles.label}>{label}</span>
      {(added > 0 || removed > 0) && (
        <span style={styles.diff}>
          <span style={{ color: "#73c991" }}>+{added}</span>
          <span style={{ color: "#c74e39" }}>-{removed}</span>
        </span>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  list: {
    maxHeight: "30%",
    overflowY: "auto",
    flexShrink: 0,
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "4px 6px",
    borderRadius: "3px",
    marginBottom: "1px",
    cursor: "pointer",
    transition: "background-color 0.1s ease",
    minWidth: 0,
  },
  label: {
    color: "var(--text-primary)",
    fontSize: "var(--font-size)",
    flex: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontFamily: "var(--font-mono, monospace)",
  },
  diff: {
    display: "inline-flex",
    gap: "4px",
    fontFamily: "var(--font-mono, monospace)",
    fontSize: "var(--font-size-sm)",
    flexShrink: 0,
  },
};
