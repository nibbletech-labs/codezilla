// Parsed transcript events from Claude Code and Codex JSONL lines.
// This parser intentionally keeps signal matchers explicit so manual debugging
// can map behavior back to concrete transcript patterns.

import type { IdleReason, SemanticPhase, SemanticSignalGroup, SignalConfidence } from "../store/transcriptTypes.ts";
import { getTranscriptSignalDefinition } from "./transcriptSignals.ts";

export type TranscriptEvent =
  // Claude Code events
  | { type: "turn_started" }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string }
  | { type: "assistant_text" }
  | { type: "result"; cost: number | null; duration: number | null }
  | { type: "compaction"; newTranscriptPath: string }
  // Codex events
  | { type: "command_started"; id: string; command: string; target?: string }
  | { type: "item_completed"; id: string }
  | { type: "turn_completed"; cost: number | null }
  // Error / lifecycle events (shared)
  | { type: "system_error"; message: string }
  | { type: "api_error"; message: string }
  | { type: "turn_failed"; error: string | null }
  | { type: "context_compacted" }
  | { type: "ignored" };

export interface ParsedTranscriptSignal {
  event: TranscriptEvent;
  signalKey: string;
  signalGroup: SemanticSignalGroup;
  semanticPhase: SemanticPhase;
  idleReasonHint: IdleReason;
  confidence: SignalConfidence;
}

function makeParsed(
  signalKey: string,
  event: TranscriptEvent,
  idleReasonHint: IdleReason = "none",
): ParsedTranscriptSignal {
  const signal = getTranscriptSignalDefinition(signalKey);
  return {
    event,
    signalKey,
    signalGroup: signal?.group ?? "unknown",
    semanticPhase: signal?.phase ?? "unknown",
    idleReasonHint,
    confidence: signal?.confidence ?? "low",
  };
}

const IGNORED_SIGNAL: ParsedTranscriptSignal = {
  event: { type: "ignored" },
  signalKey: "ignored",
  signalGroup: "unknown",
  semanticPhase: "unknown",
  idleReasonHint: "none",
  confidence: "high",
};

function makeIgnored(): ParsedTranscriptSignal {
  return IGNORED_SIGNAL;
}

function safeParseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function isNonEmptyTextBlock(block: unknown): block is { type: "text"; text: string } {
  return Boolean(
    block
    && typeof block === "object"
    && (block as { type?: string }).type === "text"
    && typeof (block as { text?: unknown }).text === "string"
    && (block as { text: string }).text.trim().length > 0,
  );
}

/** Extract the last paragraph from assistant text — all heuristics operate on this only. */
function lastParagraph(text: string): string {
  return text.trim().split(/\n\s*\n/).pop()?.trim() ?? "";
}

function isQuestionLikeText(tail: string): boolean {
  if (!tail) return false;
  if (tail.length > 200) return false;
  if (/\?\s*$/.test(tail)) return true;
  return /\b(can you|could you|would you|do you want|what should|how should|shall I|want me to)\b/i.test(tail);
}

function isClaudeApprovalLikeText(tail: string): boolean {
  if (/\b(I've approved|has been approved|was approved|already approved)\b/i.test(tail)) return false;
  return /\b(do you want to allow|allow this action|approve this|waiting for approval)\b/i.test(tail);
}

function isCodexApprovalLikeText(tail: string): boolean {
  return /\b(allow this action|approve|approval|escalated|require_escalated|elevated permissions)\b/i.test(tail);
}

function isCodexInputLikeText(tail: string): boolean {
  if (isQuestionLikeText(tail)) return true;
  return /\b(choose|select|pick)\b.+\b(option|action|plan)\b/i.test(tail)
    || /\b(reply with|respond with)\b/i.test(tail);
}

function detectClaudeIdleReasonFromAssistantText(text: string): IdleReason {
  const tail = lastParagraph(text);
  if (isClaudeApprovalLikeText(tail)) return "waiting_for_approval";
  if (isQuestionLikeText(tail)) return "waiting_for_input";
  return "none";
}

function detectCodexIdleReasonFromAssistantText(text: string): IdleReason {
  const tail = lastParagraph(text);
  if (isCodexApprovalLikeText(tail)) return "waiting_for_approval";
  if (isCodexInputLikeText(tail)) return "waiting_for_input";
  return "none";
}

// Tools that may trigger a permission prompt in Claude Code's CLI.
// When PTY goes idle after one of these, the user is likely being asked to approve.
const APPROVAL_LIKELY_TOOLS = new Set([
  "Write", "Edit", "Bash", "NotebookEdit", "WebFetch", "WebSearch",
]);

function detectClaudeIdleReasonFromToolRequest(
  toolName: string | null | undefined,
  toolInput: Record<string, unknown> | null | undefined,
): IdleReason {
  if (!toolName) return "none";
  if (toolName === "AskUserQuestion" || toolName === "ExitPlanMode" || toolName === "EnterPlanMode") {
    return "waiting_for_input";
  }
  if (toolInput?.sandbox_permissions === "require_escalated") {
    return "waiting_for_approval";
  }
  if (APPROVAL_LIKELY_TOOLS.has(toolName)) {
    return "waiting_for_approval";
  }
  return "none";
}

function detectCodexIdleReasonFromToolRequest(
  toolName: string | null | undefined,
  toolInput: Record<string, unknown> | null | undefined,
): IdleReason {
  if (!toolName) return "none";
  if (toolName === "request_user_input" || toolName === "RequestUserInput") {
    return "waiting_for_input";
  }
  if (toolInput?.sandbox_permissions === "require_escalated") {
    return "waiting_for_approval";
  }
  return "none";
}

function deriveCodexToolTarget(toolName: string, input: Record<string, unknown>): string | undefined {
  switch (toolName) {
    case "exec_command":
      return typeof input.cmd === "string" ? input.cmd : undefined;
    case "read_file":
    case "write_file":
      return typeof input.path === "string" ? input.path
        : typeof input.file_path === "string" ? input.file_path
        : undefined;
    case "list_dir":
      return typeof input.path === "string" ? input.path
        : typeof input.dir === "string" ? input.dir
        : undefined;
    default:
      return undefined;
  }
}

/**
 * Parse a single JSONL line from a Claude Code transcript and include
 * explicit signal metadata for diagnostics.
 */
export function parseClaudeLineDetailed(line: string): ParsedTranscriptSignal | null {
  const parsed = safeParseJson(line);
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  // 1) Turn/dequeue signal.
  if (obj.type === "queue-operation" && obj.operation === "dequeue") {
    return makeParsed("claude.turn.dequeue", { type: "turn_started" });
  }

  // 2) User message: check for tool_result content before treating as new turn.
  if (obj.type === "user") {
    const userContent = ((obj.message as { content?: unknown[] } | undefined)?.content)
      ?? (obj.content as unknown[] | undefined);
    if (Array.isArray(userContent)) {
      for (const block of userContent) {
        if (
          block
          && typeof block === "object"
          && (block as { type?: string }).type === "tool_result"
        ) {
          const toolUseId = (block as { tool_use_id?: string }).tool_use_id;
          if (toolUseId) {
            return makeParsed("claude.user.tool_result", { type: "tool_result", tool_use_id: toolUseId });
          }
        }
      }
    }
    return makeParsed("claude.turn.user_message", { type: "turn_started" });
  }

  // 3) Compaction boundary signal.
  if (obj.type === "CompactBoundaryMessage" || obj.subtype === "CompactBoundaryMessage") {
    const newPath = (obj.newTranscriptPath as string | undefined)
      ?? ((obj.summary as { newTranscriptPath?: string } | undefined)?.newTranscriptPath ?? null);
    if (newPath) {
      return makeParsed(
        "claude.lifecycle.compaction",
        { type: "compaction", newTranscriptPath: newPath },
      );
    }
    return null;
  }

  // 4) Result/lifecycle signal.
  if (obj.type === "result") {
    const cost = (obj.cost_usd as number | null | undefined)
      ?? ((obj.cost as { total_cost_usd?: number } | undefined)?.total_cost_usd ?? null);
    const duration = (obj.duration_ms as number | null | undefined)
      ?? (obj.duration as number | null | undefined ?? null);
    return makeParsed("claude.lifecycle.result", { type: "result", cost, duration });
  }

  // 5) Claude progress signal family.
  //    bash_progress and hook_progress are PTY-level activity — already handled by the PTY watchdog.
  //    agent_progress reflects subagent work, not a main turn event.
  if (obj.type === "progress") {
    return makeIgnored();
  }

  // 6) System error events.
  if (obj.type === "system") {
    const errorMsg = (obj.error as string | undefined)
      ?? (obj.warning as string | undefined)
      ?? null;
    if (errorMsg) {
      return makeParsed("claude.lifecycle.system_error", { type: "system_error", message: errorMsg });
    }
    // Non-error system messages (hook results, info) — intentionally ignored
    return makeIgnored();
  }

  // 7) API error events.
  if (obj.type === "api_error" || (obj.error && typeof obj.error === "object")) {
    const errorMsg = typeof obj.error === "string"
      ? obj.error
      : (obj.error as { message?: string } | undefined)?.message ?? "Unknown API error";
    return makeParsed("claude.lifecycle.api_error", { type: "api_error", message: errorMsg });
  }

  // 8) Summary compaction (newer format).
  if (obj.type === "summary") {
    const newPath = (obj.newTranscriptPath as string | undefined)
      ?? ((obj.summary as { newTranscriptPath?: string } | undefined)?.newTranscriptPath ?? null);
    if (newPath) {
      return makeParsed("claude.lifecycle.summary", { type: "compaction", newTranscriptPath: newPath });
    }
    return makeIgnored();
  }

  // 9) Intentionally ignored Claude types (streaming deltas, config, ping).
  if (
    obj.type === "config"
    || obj.type === "content_block_delta"
    || obj.type === "message_start"
    || obj.type === "message_delta"
    || obj.type === "content_block_start"
    || obj.type === "content_block_stop"
    || obj.type === "message_stop"
    || obj.type === "ping"
    || obj.type === "stream_event"
    || obj.type === "file-history-snapshot"
    || obj.type === "queue-operation"
  ) {
    return makeIgnored();
  }

  // 10) Message-based signals.
  const role = (obj.role as string | undefined) ?? ((obj.message as { role?: string } | undefined)?.role);
  const content = (obj.content as unknown[] | undefined)
    ?? ((obj.message as { content?: unknown[] } | undefined)?.content);

  if (!role || !Array.isArray(content)) return null;

  if (role === "assistant") {
    // Claude explicit thinking blocks.
    for (const block of content) {
      if (
        block
        && typeof block === "object"
        && (block as { type?: string }).type === "thinking"
        && typeof (block as { thinking?: unknown }).thinking === "string"
      ) {
        return makeParsed("claude.assistant.thinking_block", { type: "turn_started" });
      }
    }

    // Redacted thinking blocks (safety-flagged reasoning).
    for (const block of content) {
      if (
        block
        && typeof block === "object"
        && (block as { type?: string }).type === "redacted_thinking"
      ) {
        return makeParsed("claude.assistant.redacted_thinking", { type: "turn_started" });
      }
    }

    // Server tool use blocks (MCP remote tool calls).
    for (const block of content) {
      if (
        block
        && typeof block === "object"
        && (block as { type?: string }).type === "server_tool_use"
      ) {
        const tool = block as { id?: string; name?: string; input?: Record<string, unknown> };
        const toolId = typeof tool.id === "string" && tool.id.trim().length > 0 ? tool.id : null;
        if (!toolId) return null;
        return makeParsed(
          "claude.assistant.server_tool_use",
          {
            type: "tool_use",
            id: toolId,
            name: tool.name ?? "mcp_tool",
            input: tool.input ?? {},
          },
        );
      }
    }

    // Tool request blocks.
    for (const block of content) {
      if (
        block
        && typeof block === "object"
        && (block as { type?: string }).type === "tool_use"
      ) {
        const tool = block as { id?: string; name?: string; input?: Record<string, unknown> };
        const toolId = typeof tool.id === "string" && tool.id.trim().length > 0 ? tool.id : null;
        if (!toolId) return null;
        const idleReasonHint = detectClaudeIdleReasonFromToolRequest(tool.name, tool.input ?? {});
        return makeParsed(
          "claude.assistant.tool_use",
          {
            type: "tool_use",
            id: toolId,
            name: tool.name ?? "tool",
            input: tool.input ?? {},
          },
          idleReasonHint,
        );
      }
    }

    // Response text blocks.
    for (const block of content) {
      if (isNonEmptyTextBlock(block)) {
        const idleReasonHint = detectClaudeIdleReasonFromAssistantText(block.text);
        return makeParsed("claude.assistant.text", { type: "assistant_text" }, idleReasonHint);
      }
    }

    // Assistant message with no meaningful content (e.g. whitespace-only text blocks).
    return makeIgnored();
  }

  if (role === "user") {
    for (const block of content) {
      if (
        block
        && typeof block === "object"
        && (block as { type?: string }).type === "tool_result"
      ) {
        const toolUseId = (block as { tool_use_id?: string }).tool_use_id;
        if (!toolUseId) return null;
        return makeParsed("claude.user.tool_result", { type: "tool_result", tool_use_id: toolUseId });
      }
    }
  }

  // Conversation metadata lines (parentUuid, sessionId without a recognized type).
  if (!obj.type && ("parentUuid" in obj || "sessionId" in obj)) {
    return makeIgnored();
  }

  return null;
}

/**
 * Parse a single JSONL line from a Codex rollout transcript and include
 * explicit signal metadata for diagnostics.
 */
export function parseCodexLineDetailed(line: string): ParsedTranscriptSignal | null {
  const parsed = safeParseJson(line);
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const type = obj.type;

  if (type === "turn.started") {
    return makeParsed("codex.turn.started", { type: "turn_started" });
  }

  if (type === "response_item") {
    const payload = (obj.payload as Record<string, unknown> | undefined) ?? {};
    const payloadType = payload.type;

    if (payloadType === "reasoning") {
      return makeParsed("codex.response.reasoning", { type: "turn_started" });
    }

    if (payloadType === "function_call") {
      const id = (payload.call_id as string | undefined) ?? (payload.id as string | undefined) ?? null;
      if (!id) return null;
      const toolName = (payload.name as string | undefined) ?? "tool";
      const rawArgs = payload.arguments as string | undefined;
      const parsedArgs = rawArgs && typeof rawArgs === "string" ? safeParseJson(rawArgs) : null;
      const toolInput = (parsedArgs && typeof parsedArgs === "object")
        ? parsedArgs as Record<string, unknown>
        : {};
      const idleReasonHint = detectCodexIdleReasonFromToolRequest(toolName, toolInput);
      const target = deriveCodexToolTarget(toolName, toolInput);
      return makeParsed(
        "codex.response.function_call",
        { type: "command_started", id, command: toolName, target },
        idleReasonHint,
      );
    }

    if (payloadType === "function_call_output") {
      const id = (payload.call_id as string | undefined) ?? (payload.id as string | undefined) ?? null;
      if (!id) return null;
      return makeParsed("codex.response.function_call_output", { type: "item_completed", id });
    }

    if (payloadType === "message" && payload.role === "assistant") {
      const content = payload.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block
            && typeof block === "object"
            && (
              ((block as { type?: string }).type === "output_text" && typeof (block as { text?: unknown }).text === "string")
              || isNonEmptyTextBlock(block)
            )
          ) {
            const text = String((block as { text?: string }).text ?? "");
            const idleReasonHint = detectCodexIdleReasonFromAssistantText(text);
            return makeParsed("codex.response.assistant_message", { type: "turn_completed", cost: null }, idleReasonHint);
          }
        }
      }
    }

    if (payloadType === "web_search_call") {
      const id = (payload.id as string | undefined) ?? `ws-${Date.now()}`;
      return makeParsed("codex.response.web_search", { type: "command_started", id, command: "web_search" });
    }

    if (payloadType === "file_search_call") {
      const id = (payload.id as string | undefined) ?? `fs-${Date.now()}`;
      return makeParsed("codex.response.file_search", { type: "command_started", id, command: "file_search" });
    }
  }

  if (type === "event_msg") {
    const payload = (obj.payload as Record<string, unknown> | undefined) ?? {};
    if (payload.type === "agent_message") {
      const message = payload.message as string | undefined;
      const idleReasonHint = message ? detectCodexIdleReasonFromAssistantText(message) : "none";
      return makeParsed("codex.event.agent_message", { type: "turn_completed", cost: null }, idleReasonHint);
    }
    if (payload.type === "request_user_input" || payload.type === "elicitation_request") {
      return makeParsed(
        "codex.event.user_input_request",
        { type: "turn_completed", cost: null },
        "waiting_for_input",
      );
    }
  }

  // Turn failed.
  if (type === "turn.failed") {
    const error = (obj.error as string | undefined)
      ?? ((obj.error as { message?: string } | undefined)?.message ?? null);
    return makeParsed("codex.lifecycle.turn_failed", { type: "turn_failed", error: typeof error === "string" ? error : null });
  }

  // Context compacted.
  if (type === "context.compacted") {
    return makeParsed("codex.lifecycle.context_compacted", { type: "context_compacted" });
  }

  // Legacy schema compatibility.
  if (type === "item.started") {
    const item = (obj.item as Record<string, unknown> | undefined) ?? {};
    if (item.type === "command_execution" || item.type === "function_call") {
      const id = (item.id as string | undefined) ?? null;
      if (!id) return null;
      return makeParsed("codex.legacy.item_started", {
        type: "command_started",
        id,
        command: (item.command as string | undefined) ?? (item.name as string | undefined) ?? "",
      });
    }
  }

  if (type === "item.completed") {
    const item = (obj.item as Record<string, unknown> | undefined) ?? {};
    const id = (item.id as string | undefined) ?? null;
    if (!id) return null;
    return makeParsed("codex.legacy.item_completed", { type: "item_completed", id });
  }

  if (type === "turn.completed") {
    const usage = (obj.usage as { total_cost_usd?: number } | undefined) ?? {};
    return makeParsed("codex.turn.completed", { type: "turn_completed", cost: usage.total_cost_usd ?? null });
  }

  // Intentionally ignored Codex types.
  if (
    type === "session.started"
    || type === "session.ended"
    || type === "session_meta"
    || type === "turn_context"
    || type === "thread.started"
    || type === "thread.ended"
    || type === "config"
    || type === "message.delta"
    || type === "event_msg"
  ) {
    return makeIgnored();
  }

  // response_item with non-assistant roles (user, developer, system) are input context, not events
  if (type === "response_item") {
    const payload = (obj.payload as Record<string, unknown> | undefined) ?? {};
    if (payload.role === "user" || payload.role === "developer" || payload.role === "system") {
      return makeIgnored();
    }
  }

  return null;
}

/**
 * Backward-compatible parser APIs used by tests and existing call sites.
 */
export function parseClaudeLine(line: string): TranscriptEvent | null {
  const parsed = parseClaudeLineDetailed(line);
  if (!parsed || parsed.event.type === "ignored") return null;
  return parsed.event;
}

export function parseCodexLine(line: string): TranscriptEvent | null {
  const parsed = parseCodexLineDetailed(line);
  if (!parsed || parsed.event.type === "ignored") return null;
  return parsed.event;
}
