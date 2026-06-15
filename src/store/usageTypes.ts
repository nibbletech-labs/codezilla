// Mirrors the Rust `usage::AgentUsage` / `usage::UsageSnapshot` structs
// (src-tauri/src/usage/mod.rs). Percentages are 0–100; `*ResetsAt` and
// `updatedAt` are Unix epoch seconds. All limit fields are optional so a
// partial/failed fetch still renders.

/**
 * - `ok` — data present and current
 * - `na` — nothing to track (API-key billing, not signed in, no Codex sessions)
 * - `error` — transient/unexpected failure (429, HTTP, Keychain denied, …)
 * - `loading` — not fetched yet
 */
export type UsageStatus = "ok" | "na" | "error" | "loading";

export interface AgentUsage {
  status: UsageStatus;
  five_hour_pct: number | null;
  five_hour_resets_at: number | null;
  weekly_pct: number | null;
  weekly_resets_at: number | null;
  weekly_sonnet_pct: number | null;
  weekly_opus_pct: number | null;
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
