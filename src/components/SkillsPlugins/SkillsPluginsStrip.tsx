import { useAppStore } from "../../store/appStore";
import { useSkillsPluginsStore } from "../../store/skillsPluginsStore";
import { useState } from "react";

export default function SkillsPluginsStrip() {
  const activeProject = useAppStore((s) => s.getActiveProject());
  const openManager = useAppStore((s) => s.openSkillsManager);
  const installations = useSkillsPluginsStore((s) => s.installations);
  const scanResults = useSkillsPluginsStore((s) => s.scanResults);
  const sources = useSkillsPluginsStore((s) => s.sources);
  const [hovered, setHovered] = useState(false);

  // Managed installations
  const all = Object.values(installations);
  const managedRelevant = all.filter(
    (i) =>
      i.target === "Global" ||
      (i.target === "Project" && i.projectPath === activeProject?.path),
  );

  // Unmanaged items found on disk
  const unmanagedRelevant = scanResults.filter((s) => !s.managed);

  const totalCount = managedRelevant.length + unmanagedRelevant.length;

  // Count by type (combine managed + unmanaged)
  const counts: Record<string, number> = {};
  for (const item of managedRelevant) {
    const key = item.itemType.toLowerCase() + "s";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  for (const item of unmanagedRelevant) {
    const key = item.item_type.toLowerCase() + "s";
    counts[key] = (counts[key] ?? 0) + 1;
  }

  const countParts = Object.entries(counts)
    .map(([type, count]) => `${count} ${type}`)
    .join(" · ");

  const relevantSourceIds = new Set(managedRelevant.map((i) => i.sourceId));
  const updateCount = Object.values(sources).filter(
    (s) => s.updateAvailable && relevantSourceIds.has(s.id),
  ).length;

  return (
    <div
      onClick={openManager}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: "6px 12px",
        borderBottom: "1px solid var(--border-subtle)",
        fontSize: "var(--font-size-sm)",
        color: "var(--text-secondary)",
        cursor: "pointer",
        background: hovered ? "var(--bg-hover)" : "transparent",
        transition: "background 0.15s",
        userSelect: "none",
      }}
    >
      {totalCount > 0 ? (
        <>
          <span>{countParts}</span>
          {updateCount > 0 && (
            <span style={{ color: "var(--accent)", marginLeft: "8px" }}>
              {updateCount} update{updateCount > 1 ? "s" : ""}
            </span>
          )}
        </>
      ) : (
        <span>No skills or plugins</span>
      )}
    </div>
  );
}
