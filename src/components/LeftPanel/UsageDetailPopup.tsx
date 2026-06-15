import { useEffect } from "react";
import type { AgentUsage, UsageAgent } from "../../store/usageTypes";
import UsageGauge from "./UsageGauge";
import {
  formatResetAbsolute,
  formatResetCountdown,
  formatTokens,
  formatUpdatedAgo,
} from "./usageFormat";

const AGENT_LABELS: Record<UsageAgent, string> = {
  claude: "Claude",
  codex: "Codex",
};

const POPUP_W = 280;

interface UsageDetailPopupProps {
  agent: UsageAgent;
  usage: AgentUsage | undefined;
  anchor: { x: number; y: number };
  onClose: () => void;
}

/**
 * Detail popup for one agent's usage, anchored to its row. Shows both windows
 * with exact %, absolute + relative reset times, Claude per-model weekly caps,
 * plan tier, today's tokens, and last-updated — or the error when unavailable.
 */
export default function UsageDetailPopup({ agent, usage, anchor, onClose }: UsageDetailPopupProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const left = Math.min(anchor.x, window.innerWidth - POPUP_W - 8);
  const top = Math.min(anchor.y, window.innerHeight - 320);

  const isOk = usage?.status === "ok";

  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 9998 }} onClick={onClose} />
      <div style={{ ...styles.popup, left, top, width: POPUP_W }}>
        <div style={styles.header}>
          <span style={styles.title}>{AGENT_LABELS[agent]} usage</span>
          {usage?.plan_type && <span style={styles.plan}>{usage.plan_type}</span>}
        </div>

        {isOk ? (
          <>
            <Section label="5-hour window">
              <UsageGauge label="5h" pct={usage?.five_hour_pct ?? null} />
              <ResetLine resetsAt={usage?.five_hour_resets_at ?? null} />
            </Section>

            <Section label="Weekly window">
              <UsageGauge label="7d" pct={usage?.weekly_pct ?? null} />
              <ResetLine resetsAt={usage?.weekly_resets_at ?? null} />
            </Section>

            {usage?.extra_usage_pct != null && (
              <Section label="Extra usage (beyond plan)">
                <UsageGauge label="" pct={usage.extra_usage_pct} />
                {usage?.extra_usage_used_credits != null && (
                  <div style={styles.resetLine}>
                    {usage.extra_usage_used_credits} credits used
                  </div>
                )}
              </Section>
            )}

            <div style={styles.footRow}>
              <span style={styles.footLabel}>Tokens today</span>
              <span style={styles.footValue}>
                {usage?.tokens_today != null ? formatTokens(usage.tokens_today) : "—"}
              </span>
            </div>
            <div style={styles.footRow}>
              <span style={styles.footLabel}>Updated</span>
              <span style={styles.footValue}>{formatUpdatedAgo(usage?.updated_at ?? null)}</span>
            </div>
          </>
        ) : (
          <div style={styles.error}>
            {usage?.status === "loading" ? "Loading…" : usage?.error ?? "Usage data unavailable."}
          </div>
        )}

        {agent === "claude" && (
          <div style={styles.note}>
            Figures come from an unofficial Claude endpoint and may occasionally be unavailable.
          </div>
        )}
      </div>
    </>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={styles.section}>
      <div style={styles.sectionLabel}>{label}</div>
      <div style={styles.sectionBody}>{children}</div>
    </div>
  );
}

function ResetLine({ resetsAt }: { resetsAt: number | null }) {
  if (!resetsAt) return null;
  return (
    <div style={styles.resetLine}>
      resets in {formatResetCountdown(resetsAt)} · {formatResetAbsolute(resetsAt)}
    </div>
  );
}

const styles = {
  popup: {
    position: "fixed" as const,
    zIndex: 9999,
    backgroundColor: "var(--bg-panel)",
    border: "1px solid var(--border-default)",
    borderRadius: 6,
    boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
    padding: 12,
    display: "flex",
    flexDirection: "column" as const,
    gap: 10,
  },
  header: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 8,
  },
  title: {
    color: "var(--text-heading)",
    fontSize: "var(--font-size)",
    fontWeight: 600,
  } as React.CSSProperties,
  plan: {
    color: "var(--text-secondary)",
    fontSize: "var(--font-size-sm)",
    textTransform: "capitalize" as const,
  } as React.CSSProperties,
  section: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 4,
  },
  sectionLabel: {
    color: "var(--text-secondary)",
    fontSize: "var(--font-size-sm)",
    textTransform: "uppercase" as const,
    letterSpacing: "0.4px",
  } as React.CSSProperties,
  sectionBody: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 3,
  },
  resetLine: {
    color: "var(--text-secondary)",
    fontSize: "var(--font-size-sm)",
    paddingLeft: 24,
  } as React.CSSProperties,
  footRow: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
  },
  footLabel: {
    color: "var(--text-secondary)",
    fontSize: "var(--font-size-sm)",
  } as React.CSSProperties,
  footValue: {
    color: "var(--text-primary)",
    fontSize: "var(--font-size-sm)",
    fontVariantNumeric: "tabular-nums" as const,
  } as React.CSSProperties,
  error: {
    color: "var(--text-secondary)",
    fontSize: "var(--font-size-sm)",
    lineHeight: 1.4,
  } as React.CSSProperties,
  note: {
    color: "var(--text-secondary)",
    fontSize: "var(--font-size-sm)",
    lineHeight: 1.4,
    borderTop: "1px solid var(--border-subtle)",
    paddingTop: 8,
    opacity: 0.8,
  } as React.CSSProperties,
};
