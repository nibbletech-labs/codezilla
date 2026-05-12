use serde::{Deserialize, Serialize};

/// Payload emitted to the frontend for each hook event parsed from
/// `~/.codezilla/events.jsonl`. Mirrored on the TS side in
/// `src/store/claudeHooksTypes.ts`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HookEventPayload {
    /// `"turn_start" | "pre_tool_use" | "tool_use" | "turn_end"`
    pub event: String,
    pub thread_id: String,
    pub ts: f64,
    /// `"claude" | "codex"` — which CLI's hook bundle emitted this event.
    /// The frontend reducer is largely producer-agnostic but uses this to
    /// branch on Codex-specific tool names (e.g. PermissionRequest).
    pub producer: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    /// Short user-facing target for the tool (file path, command, pattern,
    /// subject) — drives the "Reading package.json" / "Running npm test"
    /// subtitles. Absent for meta tools (AskUserQuestion, *PlanMode, etc.)
    /// and for tools where we haven't defined an extraction yet.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_target: Option<String>,
    /// `tool_input.status` for TaskUpdate (e.g. "completed", "in_progress",
    /// "deleted"). Drives planProgress transitions in the frontend reducer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_status: Option<String>,
    /// Count of items in TodoWrite's `tool_input.todos` array.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub todos_total: Option<u32>,
    /// Count of TodoWrite items with `status === "completed"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub todos_done: Option<u32>,
}
