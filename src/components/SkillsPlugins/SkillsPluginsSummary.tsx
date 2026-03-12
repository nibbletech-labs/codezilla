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

  // Show global items + items scoped to this specific project
  // Exclude sub-items that belong to a plugin — only show the plugin itself
  const all = Object.values(installations);
  const managedRelevant = all.filter(
    (i) =>
      !i.parentPluginName &&
      (i.target === "Global" ||
        (i.target === "Project" && i.projectPath === activeProject?.path)),
  );

  // Unmanaged items: global + scoped to this project, excluding plugin children
  const unmanagedRelevant = scanResults.filter(
    (s) =>
      !s.managed &&
      !s.parent_plugin_name &&
      (s.scope === "Global" ||
        (s.scope === "Project" && s.project_path === activeProject?.path)),
  );

  // Combine and split by type
  const displayItems: { name: string; type: string; key: string }[] = [
    ...managedRelevant.map((i) => ({ name: i.itemName, type: i.itemType, key: `m-${i.id}` })),
    ...unmanagedRelevant.map((s) => ({ name: s.name, type: s.item_type, key: `u-${s.path}` })),
  ];

  const skills = displayItems.filter((i) => i.type === "Skill");
  const plugins = displayItems.filter((i) => i.type === "Plugin");
  const other = displayItems.filter((i) => i.type !== "Skill" && i.type !== "Plugin");

  const displayedSkills = skills.slice(0, MAX_DISPLAY);
  const displayedPlugins = plugins.slice(0, MAX_DISPLAY);
  const displayedOther = other.slice(0, MAX_DISPLAY);

  const renderRow = (label: string, items: typeof displayItems, displayed: typeof displayItems) => {
    if (items.length === 0) return null;
    const overflow = items.length - displayed.length;
    return (
      <div style={{ marginBottom: "4px" }}>
        <span style={{ fontSize: "var(--font-size-sm)", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.5px" }}>
          {label}:
        </span>{" "}
        <span style={{ fontSize: "var(--font-size-sm)", color: "var(--text-secondary)" }}>
          {displayed.map((item, i) => (
            <span key={item.key}>
              <span style={{ color: "var(--text-primary)" }}>{item.name}</span>
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
        </span>
      </div>
    );
  };

  return (
    <div style={{ marginTop: "16px", textAlign: "center" }}>
      <div
        style={{
          fontSize: "var(--font-size-sm)",
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
        <div style={{ lineHeight: 1.6 }}>
          {renderRow("Skills", skills, displayedSkills)}
          {renderRow("Plugins", plugins, displayedPlugins)}
          {renderRow("Other", other, displayedOther)}
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
