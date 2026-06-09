/**
 * Derived activity state used by the UI — the three discrete states the user
 * sees, sourced from Heed's `~/.heed/state.json` (see `heed_client`):
 * - working: the agent is actively processing
 * - awaiting_input: the agent has stopped and needs the user (a question or a
 *   tool-permission prompt); user attention is required
 * - idle: the turn ended cleanly, nothing pending
 */
export type ThreadActivityState = "working" | "awaiting_input" | "idle";
