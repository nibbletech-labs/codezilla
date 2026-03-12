import { useState, type Dispatch, type SetStateAction } from "react";
import type { FetchGroup } from "./helpers";
import { styles } from "./styles";
import { TypeBadge } from "./TypeBadge";

export function FetchGroupRow({
  group,
  selectedItems,
  setSelectedItems,
}: {
  group: FetchGroup;
  selectedItems: Set<number>;
  setSelectedItems: Dispatch<SetStateAction<Set<number>>>;
}) {
  const [expanded, setExpanded] = useState(true); // default expanded in fetch results

  const toggleItem = (idx: number) => {
    setSelectedItems((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  // No plugin parent — flat sub-items
  if (!group.plugin) {
    return (
      <>
        {group.subItems.map(({ idx, item }) => (
          <div key={idx} style={styles.itemRow}>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                flex: 1,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={selectedItems.has(idx)}
                onChange={() => toggleItem(idx)}
              />
              <span>{item.name}</span>
              <TypeBadge type={item.item_type} />
            </label>
            {item.description && (
              <span style={{ color: "var(--text-secondary)", fontSize: "var(--font-size-sm)" }}>
                {item.description}
              </span>
            )}
          </div>
        ))}
      </>
    );
  }

  // Plugin with sub-items
  return (
    <>
      <div style={styles.itemRow}>
        {group.subItems.length > 0 ? (
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
        {group.pluginIdx !== undefined && (
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              flex: 1,
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={selectedItems.has(group.pluginIdx)}
              onChange={() => toggleItem(group.pluginIdx!)}
            />
            <span>{group.plugin.name}</span>
            <TypeBadge type="Plugin" />
          </label>
        )}
        {group.plugin.description && (
          <span style={{ color: "var(--text-secondary)", fontSize: "var(--font-size-sm)" }}>
            {group.plugin.description}
          </span>
        )}
      </div>
      {expanded &&
        group.subItems.map(({ idx, item }) => (
          <div key={idx} style={{ ...styles.itemRow, paddingLeft: "24px" }}>
            <span style={{ color: "var(--text-secondary)", marginRight: "4px" }}>├</span>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                flex: 1,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={selectedItems.has(idx)}
                onChange={() => toggleItem(idx)}
              />
              <span>{item.name}</span>
              <TypeBadge type={item.item_type} />
            </label>
            {item.description && (
              <span style={{ color: "var(--text-secondary)", fontSize: "var(--font-size-sm)" }}>
                {item.description}
              </span>
            )}
          </div>
        ))}
    </>
  );
}
