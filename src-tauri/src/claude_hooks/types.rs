use serde::{Deserialize, Serialize};

/// Payload emitted to the frontend for each hook event parsed from
/// `~/.codezilla/events.jsonl`. Mirrored on the TS side in
/// `src/store/claudeHooksTypes.ts`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HookEventPayload {
    /// `"turn_start" | "tool_use" | "turn_end"`
    pub event: String,
    pub thread_id: String,
    pub ts: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
}
