import { useAppStore } from "../../store/appStore";
import { useSkillsPluginsStore } from "../../store/skillsPluginsStore";
import { useState } from "react";

const MAX_DISPLAY = 8;

export default function SkillsPluginsSummary() {
  const activeProject = useAppStore((s) => s.getActiveProject());
  const openManager = useAppStore((s) => s.openSkillsManager);
  const installations = useSkillsPluginsStore((s) => s.installations);
  const [hoverManage, setHoverManage] = useState(false);

  const all = Object.values(installations);
  const relevant = all.filter(
    (i) =>
      i.target === "Global" ||
      (i.target === "Project" && i.projectPath === activeProject?.path),
  );

  const displayed = relevant.slice(0, MAX_DISPLAY);
  const overflow = relevant.length - MAX_DISPLAY;

  return (
    <div style={{ marginTop: "16px", textAlign: "center" }}>
      <div
        style={{
          fontSize: "11px",
          fontWeight: 600,
          textTransform: "uppercase",
          color: "var(--text-secondary)",
          letterSpacing: "0.5px",
          marginBottom: "6px",
        }}
      >
        Skills & Plugins
      </div>
      {relevant.length > 0 ? (
        <div
          style={{
            fontSize: "var(--font-size-sm)",
            color: "var(--text-secondary)",
            lineHeight: 1.6,
          }}
        >
          {displayed.map((inst, i) => (
            <span key={inst.id}>
              <span style={{ color: "var(--text-primary)" }}>{inst.itemName}</span>
              {inst.itemType === "Plugin" && (
                <span style={{ fontSize: "10px", color: "var(--text-secondary)", marginLeft: "2px" }}>
                  (plugin)
                </span>
              )}
              {i < displayed.length - 1 && " · "}
            </span>
          ))}
          {overflow > 0 && (
            <span
              style={{ color: "var(--accent)", cursor: "pointer", marginLeft: "4px" }}
              onClick={openManager}
            >
              + {overflow} more
            </span>
          )}
        </div>
      ) : (
        <div style={{ fontSize: "var(--font-size-sm)", color: "var(--text-secondary)" }}>
          No skills or plugins installed
        </div>
      )}
      <button
        onClick={openManager}
        onMouseEnter={() => setHoverManage(true)}
        onMouseLeave={() => setHoverManage(false)}
        style={{
          marginTop: "8px",
          background: hoverManage ? "var(--accent-selection)" : "transparent",
          border: "1px solid var(--border-medium)",
          color: "var(--text-secondary)",
          fontSize: "var(--font-size-sm)",
          padding: "4px 14px",
          borderRadius: "4px",
          cursor: "pointer",
        }}
      >
        Manage
      </button>
    </div>
  );
}
