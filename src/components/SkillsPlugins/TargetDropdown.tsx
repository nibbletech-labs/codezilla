import { useRef, useEffect } from "react";
import type { InstallTarget } from "../../store/skillsPluginsTypes";
import { styles } from "./styles";

export function TargetDropdown({
  hasProject,
  onSelect,
  onClose,
}: {
  hasProject: boolean;
  onSelect: (target: InstallTarget) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{
        position: "absolute",
        right: 0,
        top: "100%",
        marginTop: "4px",
        background: "var(--bg-panel)",
        border: "1px solid var(--border-default)",
        borderRadius: "4px",
        zIndex: 10,
        minWidth: "140px",
        boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {hasProject && (
        <div
          style={{ ...styles.dropdownItem, borderBottom: "1px solid var(--border-subtle)" }}
          onClick={() => onSelect("Project")}
        >
          To this project
        </div>
      )}
      <div style={styles.dropdownItem} onClick={() => onSelect("Global")}>
        Global
      </div>
    </div>
  );
}
