import { useState } from "react";
import type { AgentUsage, UsageAgent } from "../../store/usageTypes";
import UsageGauge from "./UsageGauge";
import {
  windowElapsedPct,
  FIVE_HOUR_SECONDS,
  WEEKLY_SECONDS,
} from "./usageFormat";
import { timeAgo } from "../../lib/timeAgo";

const AGENT_LABELS: Record<UsageAgent, string> = {
  claude: "Claude",
  codex: "Codex",
};

/** Show the age once a reading is older than the ordinary active cadence.
 * Errors and passed reset deadlines also mark cached readings as stale. */
const STALE_AFTER_SECS = 10 * 60;

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

  // Numbers older than the stale window get an "as of Xm" cue and a slight dim
  // instead of silently posing as current (parent ticks every 30s, so the label
  // stays fresh). Errors serving a cached value surface here too.
  const updatedAt = usage?.updated_at ?? null;
  const ageSecs = updatedAt ? Date.now() / 1000 - updatedAt : 0;
  const expired = [usage?.five_hour_resets_at, usage?.weekly_resets_at]
    .some((reset) => reset != null && reset <= Date.now() / 1000);
  const isStale = isOk && (Boolean(usage?.error) || expired || ageSecs > STALE_AFTER_SECS);

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
        opacity: isOk ? (isStale ? 0.75 : 1) : 0.55,
      }}
      title={usage?.error ?? (isOk ? "View usage detail" : "Usage unavailable")}
    >
      <div style={styles.topline}>
        <span style={styles.name}>{AGENT_LABELS[agent]}</span>
        {isOk && isStale && updatedAt && (
          <span style={styles.reset}>as of {timeAgo(updatedAt * 1000)}</span>
        )}
        {!isOk && statusLabel && <span style={styles.reset}>{statusLabel}</span>}
      </div>
      {isOk && (
        <div style={styles.gauges}>
          <UsageGauge
            label="5h"
            pct={usage?.five_hour_pct ?? null}
            elapsedPct={windowElapsedPct(
              usage?.five_hour_resets_at ?? null,
              FIVE_HOUR_SECONDS,
            )}
          />
          <UsageGauge
            label="7d"
            pct={usage?.weekly_pct ?? null}
            elapsedPct={windowElapsedPct(
              usage?.weekly_resets_at ?? null,
              WEEKLY_SECONDS,
            )}
          />
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
