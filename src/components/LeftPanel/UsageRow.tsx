import { useState } from "react";
import type { AgentUsage, UsageAgent } from "../../store/usageTypes";
import UsageGauge from "./UsageGauge";
import { formatResetCountdown } from "./usageFormat";

const AGENT_LABELS: Record<UsageAgent, string> = {
  claude: "Claude",
  codex: "Codex",
};

interface UsageRowProps {
  agent: UsageAgent;
  usage: AgentUsage | undefined;
  onClick: (e: React.MouseEvent) => void;
}

/**
 * One agent's plan-usage summary: name, a 5-hour and weekly gauge, and the
 * soonest reset countdown. Dimmed with "unavailable" when there's no data.
 * Clicking opens the detail popup.
 */
export default function UsageRow({ agent, usage, onClick }: UsageRowProps) {
  const [hovered, setHovered] = useState(false);
  const status = usage?.status ?? "loading";
  const isOk = status === "ok";
  const reset = isOk ? formatResetCountdown(usage?.five_hour_resets_at ?? null) : "";

  // Compact right-hand text for non-ok states.
  const statusLabel =
    status === "loading" ? "…" : status === "error" ? "unavailable" : "";

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        ...styles.row,
        backgroundColor: hovered ? "var(--bg-hover)" : "transparent",
        opacity: isOk ? 1 : 0.55,
      }}
      title={isOk ? "View usage detail" : usage?.error ?? "Usage unavailable"}
    >
      <div style={styles.topline}>
        <span style={styles.name}>{AGENT_LABELS[agent]}</span>
        {isOk
          ? reset && <span style={styles.reset}>5h resets {reset}</span>
          : statusLabel && <span style={styles.reset}>{statusLabel}</span>}
      </div>
      {isOk && (
        <div style={styles.gauges}>
          <UsageGauge label="5h" pct={usage?.five_hour_pct ?? null} />
          <UsageGauge label="7d" pct={usage?.weekly_pct ?? null} />
        </div>
      )}
    </div>
  );
}

const styles = {
  row: {
    padding: "6px 12px",
    cursor: "pointer",
    transition: "background-color 0.1s ease",
    display: "flex",
    flexDirection: "column" as const,
    gap: 4,
  } as React.CSSProperties,
  topline: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 6,
  },
  name: {
    color: "var(--text-primary)",
    fontSize: "var(--font-size)",
    fontWeight: 500,
  } as React.CSSProperties,
  reset: {
    color: "var(--text-secondary)",
    fontSize: "var(--font-size-sm)",
    flexShrink: 0,
  } as React.CSSProperties,
  gauges: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 3,
  },
};
