import { useState } from "react";
import type { AgentUsage, UsageAgent } from "../../store/usageTypes";
import UsageGauge from "./UsageGauge";
import { windowElapsedPct } from "./usageFormat";
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
 * One agent's plan-usage summary: name and a gauge per account-wide window the
 * provider currently reports — however many that is, and whatever their
 * lengths. A window the provider stops sending simply disappears. Dimmed with
 * "unavailable" when there's no data. Clicking opens the detail popup.
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
  // Only account-wide limits with a known period belong in the compact row.
  // Per-model caps, and entries whose key we could not read as a time window,
  // ride along in the payload and are listed in the detail popup instead —
  // one unrecognised name must not reshape the sidebar.
  const windows = (usage?.windows ?? []).filter(
    (w) => !w.scope && w.duration_secs != null,
  );
  const expired = windows.some(
    (w) => w.resets_at != null && w.resets_at <= Date.now() / 1000,
  );
  const isStale = isOk && (Boolean(usage?.error) || expired || ageSecs > STALE_AFTER_SECS);

  // Compact right-hand text for non-ok states, and for a reading that carries
  // no windows at all (a provider that has stopped publishing limits).
  const statusLabel =
    status === "loading"
      ? "…"
      : status === "error"
        ? "unavailable"
        : isOk && windows.length === 0
          ? "no limits reported"
          : "";

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
        {statusLabel && !(isOk && isStale && updatedAt) && (
          <span style={styles.reset}>{statusLabel}</span>
        )}
      </div>
      {windows.length > 0 && (
        <div style={styles.gauges}>
          {windows.map((w) => (
            <UsageGauge
              key={w.id}
              label={w.label}
              pct={w.used_pct}
              elapsedPct={windowElapsedPct(w.resets_at, w.duration_secs)}
            />
          ))}
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
