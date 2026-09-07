// Mirrors the Rust `usage::AgentUsage` / `usage::UsageWindow` / `usage::UsageSnapshot`
// structs (src-tauri/src/usage/mod.rs). Percentages are 0–100; `resets_at` and
// `updated_at` are Unix epoch seconds. All limit fields are optional so a
// partial/failed fetch still renders.

/**
 * - `ok` — last successful reading available; error may describe a failed refresh
 * - `na` — nothing to track (API-key billing or not signed in)
 * - `error` — transient/unexpected failure (429, HTTP, Keychain denied, …)
 * - `loading` — not fetched yet
 */
export type UsageStatus = "ok" | "na" | "error" | "loading";

/**
 * One rate-limit window exactly as the provider reported it. The set of
 * windows is not fixed — providers add, resize and retire them — so the UI
 * renders whatever arrives instead of assuming a 5-hour and a weekly one.
 */
export interface UsageWindow {
  /** Identifier for React keys, e.g. "5h" or "opus:7d". */
  id: string;
  /** Short gauge label, e.g. "5h", "7d", "30d". */
  label: string;
  /** Utilization 0–100. */
  used_pct: number;
  /** Epoch seconds of the next reset, when the provider states one. */
  resets_at: number | null;
  /** Window length in seconds, when known — drives the elapsed "pace" tick. */
  duration_secs: number | null;
  /** Model or sub-limit this window applies to; null is the account limit. */
  scope: string | null;
}

export interface AgentUsage {
  status: UsageStatus;
  /** Account windows first, shortest first; empty when there is nothing to show. */
  windows: UsageWindow[];
  plan_type: string | null;
  tokens_today: number | null;
  /** Extra-usage (spend beyond plan limits); Claude-only, when enabled. */
  extra_usage_pct: number | null;
  extra_usage_used_credits: number | null;
  updated_at: number | null;
  error: string | null;
}

export interface UsageSnapshot {
  claude: AgentUsage;
  codex: AgentUsage;
}

/** The two agents we track, in display order. */
export type UsageAgent = "claude" | "codex";
