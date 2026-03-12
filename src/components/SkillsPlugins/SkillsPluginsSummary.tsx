import { useAppStore } from "../../store/appStore";
import { useSkillsPluginsStore } from "../../store/skillsPluginsStore";
import { useState } from "react";

const MAX_DISPLAY = 8;

export default function SkillsPluginsSummary() {
  const activeProject = useAppStore((s) => s.getActiveProject());
  const openManager = useAppStore((s) => s.openSkillsManager);
  const installations = useSkillsPluginsStore((s) => s.installations);
  const scanResults = useSkillsPluginsStore((s) => s.scanResults);
  const [hoverManage, setHoverManage] = useState(false);

  // Managed installations relevant to the current context
  const all = Object.values(installations);
  const managedRelevant = all.filter(
    (i) =>
      i.target === "Global" ||
      (i.target === "Project" && i.projectPath === activeProject?.path),
  );

  // Unmanaged items found on disk (not tracked by registry)
  const unmanagedRelevant = scanResults.filter(
    (s) =>
      !s.managed &&
      (s.scope === "Global" ||
        (s.scope === "Project")),
  );

  // Combine for display: managed first, then unmanaged
  const displayItems: { name: string; type: string; key: string }[] = [
    ...managedRelevant.map((i) => ({ name: i.itemName, type: i.itemType, key: `m-${i.id}` })),
    ...unmanagedRelevant.map((s) => ({ name: s.name, type: s.item_type, key: `u-${s.path}` })),
  ];

  const displayed = displayItems.slice(0, MAX_DISPLAY);
  const overflow = displayItems.length - MAX_DISPLAY;

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
      {displayItems.length > 0 ? (
        <div
          style={{
            fontSize: "var(--font-size-sm)",
            color: "var(--text-secondary)",
            lineHeight: 1.6,
          }}
        >
          {displayed.map((item, i) => (
            <span key={item.key}>
              <span style={{ color: "var(--text-primary)" }}>{item.name}</span>
              {item.type === "Plugin" && (
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
