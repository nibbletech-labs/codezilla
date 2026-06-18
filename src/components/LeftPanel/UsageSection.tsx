import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "../../store/appStore";
import type { UsageAgent } from "../../store/usageTypes";
import UsageRow from "./UsageRow";
import UsageDetailPopup from "./UsageDetailPopup";

const AGENTS: UsageAgent[] = ["claude", "codex"];

/**
 * The "Usage" sidebar section above Projects: a header plus one row per agent
 * that has subscription usage to show. Agents reporting `na` (no subscription —
 * API-key billing, not signed in, no Codex sessions) are hidden; if neither has
 * anything to show, the whole section disappears. Clicking a row opens an
 * anchored detail popup.
 */
export default function UsageSection() {
  const usage = useAppStore((s) => s.usage);
  const usageChartVisibility = useAppStore((s) => s.usageChartVisibility);

  const [openAgent, setOpenAgent] = useState<UsageAgent | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  // Re-render periodically so reset countdowns stay current.
  const [, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) setTick((t) => t + 1);
    }, 30_000);
    return () => clearInterval(id);
  }, []);

  // Hide agents the user has toggled off, or with nothing to track; hide the
  // whole section if none remain.
  const visibleAgents = AGENTS.filter(
    (a) => usageChartVisibility[a] && usage?.[a]?.status !== "na",
  );
  if (visibleAgents.length === 0) return null;

  const handleRowClick = (agent: UsageAgent) => (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setAnchor({ x: rect.right + 6, y: rect.top });
    setOpenAgent(agent);
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.headerText}>Usage</span>
      </div>
      {visibleAgents.map((agent) => (
        <UsageRow
          key={agent}
          agent={agent}
          usage={usage?.[agent]}
          onClick={handleRowClick(agent)}
        />
      ))}

      {openAgent && anchor && createPortal(
        <UsageDetailPopup
          agent={openAgent}
          usage={usage?.[openAgent]}
          anchor={anchor}
          onClose={() => setOpenAgent(null)}
        />,
        document.body,
      )}
    </div>
  );
}

const styles = {
  container: {
    flexShrink: 0,
    borderBottom: "1px solid var(--border-subtle)",
    paddingBottom: 6,
  } as React.CSSProperties,
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 12px",
  },
  headerText: {
    color: "var(--text-secondary)",
    fontSize: "var(--font-size-sm)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.5px",
  } as React.CSSProperties,
};
