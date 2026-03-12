import { useState } from "react";
import type { ScannedItem } from "../../store/skillsPluginsTypes";
import { styles } from "./styles";
import { TypeBadge } from "./TypeBadge";
import { ScopeIcon } from "./ScopeIcon";

export function ScannedRow({
  item,
  label,
  onRemove,
  onLink,
}: {
  item: ScannedItem;
  label: string;
  onRemove: () => void;
  onLink?: () => void;
}) {
  const [hoverRemove, setHoverRemove] = useState(false);
  return (
    <div style={styles.itemRow}>
      <span style={{ flex: 1 }}>
        <ScopeIcon scope={item.scope} />
        {item.name}
        <TypeBadge type={item.item_type} />
      </span>
      <span style={{ color: "var(--text-secondary)", fontSize: "var(--font-size-sm)" }}>
        {label}
      </span>
      {onLink && (
        <button style={styles.smallBtn} onClick={onLink}>
          Link source
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
