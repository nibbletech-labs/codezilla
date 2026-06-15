import { gaugeColor } from "./usageFormat";

interface UsageGaugeProps {
  /** Window label, e.g. "5h" or "7d". */
  label: string;
  /** Utilization 0–100, or null when unknown. */
  pct: number | null;
}

/**
 * One compact labelled usage bar: `5h [▓▓▓░░░] 35%`. Renders a muted dash when
 * `pct` is null (window not reported on this plan / no data yet).
 */
export default function UsageGauge({ label, pct }: UsageGaugeProps) {
  const known = pct !== null && pct !== undefined;
  const clamped = known ? Math.max(0, Math.min(100, pct)) : 0;
  return (
    <div style={styles.row}>
      <span style={styles.label}>{label}</span>
      <div style={styles.track}>
        {known && (
          <div
            style={{
              ...styles.fill,
              width: `${clamped}%`,
              backgroundColor: gaugeColor(clamped),
            }}
          />
        )}
      </div>
      <span style={styles.pct}>{known ? `${Math.round(clamped)}%` : "—"}</span>
    </div>
  );
}

const styles = {
  row: {
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  label: {
    color: "var(--text-secondary)",
    fontSize: "var(--font-size-sm)",
    width: 18,
    flexShrink: 0,
  } as React.CSSProperties,
  track: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    backgroundColor: "var(--bg-input)",
    overflow: "hidden",
  } as React.CSSProperties,
  fill: {
    height: "100%",
    borderRadius: 3,
    transition: "width 0.3s ease, background-color 0.3s ease",
  } as React.CSSProperties,
  pct: {
    color: "var(--text-primary)",
    fontSize: "var(--font-size-sm)",
    width: 34,
    textAlign: "right" as const,
    flexShrink: 0,
    fontVariantNumeric: "tabular-nums" as const,
  } as React.CSSProperties,
};
