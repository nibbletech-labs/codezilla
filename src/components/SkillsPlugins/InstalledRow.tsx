import { useState } from "react";
import type { Installation } from "../../store/skillsPluginsTypes";
import { styles } from "./styles";
import { TypeBadge } from "./TypeBadge";

export function InstalledRow({
  inst,
  sourceLabel,
  hasUpdate,
  isDuplicate,
  hasProject,
  onRemove,
  onUpdate,
  onMove,
  onRemoveDuplicate,
}: {
  inst: Installation;
  sourceLabel: string;
  hasUpdate?: boolean;
  isDuplicate: boolean;
  hasProject: boolean;
  onRemove: () => void;
  onUpdate: () => void;
  onMove: () => void;
  onRemoveDuplicate?: () => void;
}) {
  const [hoverRemove, setHoverRemove] = useState(false);
  const canMove = inst.itemType !== "Plugin";
  const moveLabel = inst.target === "Global" ? "Move to Project" : "Move to Global";
  const showMoveToProject = inst.target === "Global" && hasProject;
  const showMoveToGlobal = inst.target === "Project";

  return (
    <div style={styles.itemRow}>
      <span style={{ flex: 1 }}>
        {inst.itemName}
        <TypeBadge type={inst.itemType} />
        {hasUpdate && (
          <span
            style={{
              color: "var(--accent)",
              marginLeft: "6px",
              fontSize: "11px",
              cursor: "pointer",
            }}
            onClick={onUpdate}
          >
            ● update available
          </span>
        )}
        {isDuplicate && (
          <span style={{ marginLeft: "6px" }}>
            <span
              style={{
                color: "#e9a019",
                fontSize: "10px",
                padding: "1px 6px",
                borderRadius: "3px",
                border: "1px solid #e9a01966",
              }}
              title="Also installed globally — project copy is redundant"
            >
              duplicate
            </span>
            {onRemoveDuplicate && (
              <button
                style={{
                  ...styles.smallBtn,
                  marginLeft: "4px",
                  fontSize: "10px",
                  padding: "1px 6px",
                  color: "#e9a019",
                  borderColor: "#e9a01966",
                }}
                onClick={onRemoveDuplicate}
              >
                Remove duplicate
              </button>
            )}
          </span>
        )}
      </span>
      <span style={{ color: "var(--text-secondary)", fontSize: "var(--font-size-sm)" }}>
        {sourceLabel}
      </span>
      {canMove && (showMoveToProject || showMoveToGlobal) && (
        <button style={styles.smallBtn} onClick={onMove}>
          {moveLabel}
        </button>
      )}
      <button
        style={{
          ...styles.removeBtn,
          color: hoverRemove ? "#f44" : "var(--text-secondary)",
          borderColor: hoverRemove ? "#f44" : "var(--border-medium)",
        }}
        onMouseEnter={() => setHoverRemove(true)}
        onMouseLeave={() => setHoverRemove(false)}
        onClick={onRemove}
      >
        Remove
      </button>
    </div>
  );
}
