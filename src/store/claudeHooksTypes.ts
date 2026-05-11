/**
 * Hook event payload emitted from the Rust side via the `claude-hook-event`
 * Tauri event. Mirrored on the Rust side in `src-tauri/src/claude_hooks/types.rs`.
 */
export interface HookEventPayload {
  /** One of: "turn_start" | "tool_use" | "turn_end" */
  event: HookEventName;
  /** Codezilla thread UUID (from CODEZILLA_THREAD_ID env var) */
  thread_id: string;
  /** Unix epoch seconds with fractional precision */
  ts: number;
  /** Tool name for PostToolUse events; absent for other events */
  tool_name?: string;
  /** Short user-facing target string for the tool (file path, command, pattern, subject). */
  tool_target?: string;
  /** TaskUpdate's `tool_input.status` value (e.g. "completed", "in_progress", "deleted"). */
  task_status?: string;
  /** TodoWrite's `tool_input.todos.length`. */
  todos_total?: number;
  /** TodoWrite's count of `todos[*].status === "completed"`. */
  todos_done?: number;
}

export type HookEventName = "turn_start" | "pre_tool_use" | "tool_use" | "turn_end";

/**
 * Derived activity state used by the UI. Three discrete states the user sees:
 * - working: Claude is actively processing
 * - awaiting_input: Claude has stopped and is waiting on the user (question or
 *   tool-permission); user attention is required
 * - idle: turn ended cleanly, no pending question
 */
export type ThreadActivityState = "working" | "awaiting_input" | "idle";

/**
 * Persisted user preference for the activity-detection feature. Stored under
 * the `claudeHooks` key in codezilla-config.json.
 */
export interface ClaudeHooksConfig {
  userDisabled?: boolean;
}
