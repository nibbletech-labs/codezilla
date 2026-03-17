import { useState } from "react";
import type { Installation } from "../../store/skillsPluginsTypes";
import { styles } from "./styles";
import { TypeBadge } from "./TypeBadge";
import { ScopeIcon } from "./ScopeIcon";
import { open } from "@tauri-apps/plugin-shell";

export function InstalledPluginRow({
  plugin,
  subItems,
  sourceLabel,
  sourceUrl,
  hasUpdate,
  onRemove,
  onUpdate,
}: {
  plugin: Installation;
  subItems: Installation[];
  sourceLabel: string;
  sourceUrl?: string;
  hasUpdate?: boolean;
  onRemove: () => void;
  onUpdate: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [hoverRemove, setHoverRemove] = useState(false);

  return (
    <>
      <div style={styles.itemRow}>
        {subItems.length > 0 ? (
          <span
            onClick={() => setExpanded(!expanded)}
            style={{
              cursor: "pointer",
              marginRight: "4px",
              fontSize: "11px",
              userSelect: "none",
            }}
          >
            {expanded ? "▼" : "▶"}
          </span>
        ) : (
          <span style={{ marginRight: "4px", width: "11px", display: "inline-block" }} />
        )}
        <span style={{ flex: 1 }}>
          <ScopeIcon scope={plugin.target} />
          {plugin.itemName}
          <TypeBadge type="Plugin" />
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
        </span>
        <span style={{ color: "var(--text-secondary)", fontSize: "var(--font-size-sm)" }}>
          {sourceUrl ? (
            <span
              style={{ cursor: "pointer", textDecoration: "none" }}
              onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")}
              onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}
              onClick={() => open(sourceUrl)}
            >
              {sourceLabel}
            </span>
          ) : (
            sourceLabel
          )}
        </span>
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
      {expanded &&
        subItems.map((child) => (
          <div key={child.id} style={{ ...styles.itemRow, paddingLeft: "24px" }}>
            <span style={{ color: "var(--text-secondary)", marginRight: "4px" }}>├</span>
            <span style={{ flex: 1 }}>
              {child.itemName}
              <TypeBadge type={child.itemType} />
            </span>
          </div>
        ))}
    </>
  );
}
