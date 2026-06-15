// Formatting helpers for the plan-usage UI. Kept dependency-free (no date libs).

/** Compact token count: 12_014_493 → "12.0M", 4500 → "4.5K", 320 → "320". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

/**
 * Human countdown to a reset, from epoch seconds. "2h 13m", "5d 3h", "<1m",
 * or "now" once elapsed. Returns "" when the timestamp is missing.
 */
export function formatResetCountdown(resetsAtEpoch: number | null): string {
  if (!resetsAtEpoch) return "";
  const secs = resetsAtEpoch - Math.floor(Date.now() / 1000);
  if (secs <= 0) return "now";
  const d = Math.floor(secs / 86_400);
  const h = Math.floor((secs % 86_400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return "<1m";
}

/** Absolute reset time, e.g. "resets 14:57 Sat". */
export function formatResetAbsolute(resetsAtEpoch: number | null): string {
  if (!resetsAtEpoch) return "";
  const d = new Date(resetsAtEpoch * 1000);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const day = d.toLocaleDateString(undefined, { weekday: "short" });
  return `${time} ${day}`;
}

/** "updated 2m ago" style staleness label from epoch seconds. */
export function formatUpdatedAgo(updatedAtEpoch: number | null): string {
  if (!updatedAtEpoch) return "";
  const secs = Math.floor(Date.now() / 1000) - updatedAtEpoch;
  if (secs < 60) return "just now";
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Gauge fill color by utilization: green → amber → red as it approaches 100%. */
export function gaugeColor(pct: number): string {
  if (pct >= 90) return "#e5484d"; // red — at/near the cap
  if (pct >= 70) return "#e0a32e"; // amber — getting close
  return "var(--accent)";
}
