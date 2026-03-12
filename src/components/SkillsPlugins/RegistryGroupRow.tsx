import { useState } from "react";
import type { DetectedItem, InstallTarget } from "../../store/skillsPluginsTypes";
import type { RegistryGroup } from "./helpers";
import { styles } from "./styles";
import { TypeBadge } from "./TypeBadge";
import { TargetDropdown } from "./TargetDropdown";

export function RegistryGroupRow({
  group,
  installTargetIdx,
  setInstallTargetIdx,
  hasProject,
  onInstall,
}: {
  group: RegistryGroup;
  installTargetIdx: string | null;
  setInstallTargetIdx: (key: string | null) => void;
  hasProject: boolean;
  onInstall: (sourceId: string, item: DetectedItem, target: InstallTarget) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  // No plugin parent — flat list of sub-items
  if (!group.plugin) {
    return (
      <>
        {group.subItems.map((item) => {
          const itemKey = `${group.sourceId}:${item.repo_path}`;
          return (
            <div key={itemKey} style={styles.itemRow}>
              <span style={{ flex: 1 }}>
                {item.parent_plugin_name && (
                  <span style={{ color: "var(--text-secondary)", marginRight: "4px" }}>
                    {item.parent_plugin_name} ›
                  </span>
                )}
                {item.name}
                <TypeBadge type={item.item_type} />
              </span>
              <div style={{ position: "relative" }}>
                <button
                  style={styles.smallBtn}
                  onClick={() =>
                    setInstallTargetIdx(installTargetIdx === itemKey ? null : itemKey)
                  }
                >
                  Install ▾
                </button>
                {installTargetIdx === itemKey && (
                  <TargetDropdown
                    hasProject={hasProject}
                    onSelect={(t) => {
                      onInstall(group.sourceId, item, t);
                      setInstallTargetIdx(null);
                    }}
                    onClose={() => setInstallTargetIdx(null)}
                  />
                )}
              </div>
            </div>
          );
        })}
      </>
    );
  }

  // Plugin with optional sub-items
  const pluginKey = `${group.sourceId}:${group.plugin.repo_path}`;
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
        <span style={{ flex: 1 }}>
          {group.plugin.name}
          <TypeBadge type="Plugin" />
        </span>
        <div style={{ position: "relative" }}>
          <button
            style={styles.smallBtn}
            onClick={() =>
              setInstallTargetIdx(installTargetIdx === pluginKey ? null : pluginKey)
            }
          >
            Install ▾
          </button>
          {installTargetIdx === pluginKey && (
            <TargetDropdown
              hasProject={hasProject}
              onSelect={(t) => {
                onInstall(group.sourceId, group.plugin!, t);
                setInstallTargetIdx(null);
              }}
              onClose={() => setInstallTargetIdx(null)}
            />
          )}
        </div>
      </div>
      {expanded &&
        group.subItems.map((item) => {
          const itemKey = `${group.sourceId}:${item.repo_path}`;
          return (
            <div key={itemKey} style={{ ...styles.itemRow, paddingLeft: "24px" }}>
              <span style={{ color: "var(--text-secondary)", marginRight: "4px" }}>├</span>
              <span style={{ flex: 1 }}>
                {item.name}
                <TypeBadge type={item.item_type} />
              </span>
              <div style={{ position: "relative" }}>
                <button
                  style={styles.smallBtn}
                  onClick={() =>
                    setInstallTargetIdx(installTargetIdx === itemKey ? null : itemKey)
                  }
                >
                  Install ▾
                </button>
                {installTargetIdx === itemKey && (
                  <TargetDropdown
                    hasProject={hasProject}
                    onSelect={(t) => {
                      onInstall(group.sourceId, item, t);
                      setInstallTargetIdx(null);
                    }}
                    onClose={() => setInstallTargetIdx(null)}
                  />
                )}
              </div>
            </div>
          );
        })}
    </>
  );
}
