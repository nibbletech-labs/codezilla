import { useState } from "react";
import { open } from "@tauri-apps/plugin-shell";
import type { ScannedItem } from "../../store/skillsPluginsTypes";
import { styles } from "./styles";
import { TypeBadge } from "./TypeBadge";

export function PluginRow({
  plugin,
  subItems,
  onRemove,
  repoUrl,
}: {
  plugin: ScannedItem;
  subItems: ScannedItem[];
  onRemove: () => void;
  repoUrl?: string;
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
          {plugin.name}
          <TypeBadge type="Plugin" />
        </span>
        <span style={{ color: "var(--text-secondary)", fontSize: "var(--font-size-sm)" }}>
          {plugin.scope === "Global" ? "global" : "project"}
          {plugin.marketplace && (
            <>
              {" · "}
              {repoUrl ? (
                <span
                  style={{ cursor: "pointer", textDecoration: "none" }}
                  onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")}
                  onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}
                  onClick={(e) => {
                    e.stopPropagation();
                    open(repoUrl);
                  }}
                >
                  {plugin.marketplace}
                </span>
              ) : (
                plugin.marketplace
              )}
            </>
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
        subItems.map((sub, j) => (
          <div key={j} style={{ ...styles.itemRow, paddingLeft: "24px" }}>
            <span style={{ color: "var(--text-secondary)", marginRight: "4px" }}>├</span>
            <span style={{ flex: 1 }}>
              {sub.name}
              <TypeBadge type={sub.item_type} />
            </span>
          </div>
        ))}
    </>
  );
}
