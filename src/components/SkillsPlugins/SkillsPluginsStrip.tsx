import { useAppStore } from "../../store/appStore";
import { useSkillsPluginsStore } from "../../store/skillsPluginsStore";
import { useState } from "react";

export default function SkillsPluginsStrip() {
  const activeProject = useAppStore((s) => s.getActiveProject());
  const openManager = useAppStore((s) => s.openSkillsManager);
  const installations = useSkillsPluginsStore((s) => s.installations);
  const sources = useSkillsPluginsStore((s) => s.sources);
  const [hovered, setHovered] = useState(false);

  const all = Object.values(installations);
  const relevant = all.filter(
    (i) =>
      i.target === "Global" ||
      (i.target === "Project" && i.projectPath === activeProject?.path),
  );

  if (relevant.length === 0) return null;

  // Count by type
  const counts: Record<string, number> = {};
  for (const item of relevant) {
    const key = item.itemType.toLowerCase() + "s";
    counts[key] = (counts[key] ?? 0) + 1;
  }

  const countParts = Object.entries(counts)
    .map(([type, count]) => `${count} ${type}`)
    .join(" · ");

  const relevantSourceIds = new Set(relevant.map((i) => i.sourceId));
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
      <span>{countParts}</span>
      {updateCount > 0 && (
        <span style={{ color: "var(--accent)", marginLeft: "8px" }}>
          ● {updateCount} update{updateCount > 1 ? "s" : ""}
        </span>
      )}
    </div>
  );
}
