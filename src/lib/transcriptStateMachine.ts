import type { TranscriptInfo } from "../store/transcriptTypes";
import type { ParsedTranscriptSignal, TranscriptEvent } from "./transcriptParser.ts";
import { getTranscriptSignalDefinition } from "./transcriptSignals.ts";

const TOOL_VERBS: Record<string, string> = {
  // Claude tools
  Edit: "Editing",
  Write: "Writing",
  Read: "Reading",
  Bash: "Running",
  Grep: "Searching",
  Glob: "Searching",
  WebSearch: "Searching",
  WebFetch: "Fetching",
  Task: "Delegating",
  TodoWrite: "Updating plan",
  TaskCreate: "Planning",
  TaskUpdate: "Executing plan",
  TaskList: "Checking plan",
  TaskGet: "Checking task",
  // Codex tools
  exec_command: "Running",
  read_file: "Reading",
  write_file: "Writing",
  list_dir: "Listing",
  apply_diff: "Editing",
  web_search: "Searching",
  file_search: "Searching",
};

function deriveToolTarget(name: string, input: Record<string, unknown>): string | null {
  switch (name) {
    case "Edit":
    case "Write":
    case "Read":
      return (input.file_path as string) ?? (input.path as string) ?? null;
    case "Bash":
      return truncate((input.command as string) ?? null, 40);
    case "Grep":
    case "Glob":
      return (input.pattern as string) ?? null;
    default:
      return null;
  }
}

function truncate(s: string | null, max: number): string | null {
  if (!s) return null;
  return s.length > max ? s.slice(0, max) + "..." : s;
}

function shortPath(p: string | null): string | null {
  if (!p) return null;
  const parts = p.split("/");
  return parts[parts.length - 1] ?? p;
}

function formatToolSubtitle(info: TranscriptInfo): string {
  const name = info.lastToolName!;
  const verb = TOOL_VERBS[name] ?? "Using " + name;
  const useFullTarget = name === "Bash" || name === "exec_command";
  const target = useFullTarget
    ? info.lastToolTarget
    : shortPath(info.lastToolTarget);
  return target ? `${verb} ${target}` : verb;
}

function appendPlanProgress(base: string, info: TranscriptInfo): string {
  if (info.planProgress && info.planProgress.total > 0) {
    // Show which item is being worked on (1-indexed) rather than how many
    // are finished: "Working (1/5)" means "on item 1", not "0 done".
    const display = Math.min(info.planProgress.done + 1, info.planProgress.total);
    return `${base} (${display}/${info.planProgress.total})`;
  }
  return base;
}

function isCompacting(info: TranscriptInfo): boolean {
  const k = info.semanticSignalKey;
  return k === "claude.lifecycle.compaction"
    || k === "claude.lifecycle.summary"
    || k === "codex.lifecycle.context_compacted";
}

export function deriveSubtitle(info: TranscriptInfo): string {
  if (info.status === "exited") {
    return "Session ended";
  }

  // Compaction takes priority — always show it regardless of idle/working status.
  if (isCompacting(info)) return appendPlanProgress("Compacting conversation", info);

  if (info.status === "idle") {
    if (info.idleReason === "waiting_for_approval") return appendPlanProgress("Waiting for approval", info);
    if (info.idleReason === "waiting_for_input") return appendPlanProgress("Waiting for input", info);
    if (info.semanticPhase === "thinking") return appendPlanProgress("Thinking", info);
    // Show tool context only while a tool is still in-flight (pending > 0).
    // tool_result clears all pending IDs so stale verbs won't linger.
    if (info.semanticPhase === "tooling" && info.lastToolName && info.pendingToolUseIds.size > 0) {
      return appendPlanProgress(formatToolSubtitle(info), info);
    }
    // Mid-turn phases: Claude is still working even though the PTY is momentarily quiet.
    // Without this, the subtitle flickers to "Idle" between tool calls / during responses.
    if (info.semanticPhase === "tooling" || info.semanticPhase === "responding") {
      return appendPlanProgress("Working", info);
    }
    if (info.semanticPhase === "waiting" && info.lastError) return appendPlanProgress("Error", info);
    if (info.semanticPhase === "waiting") return appendPlanProgress("Idle · Done", info);
    return appendPlanProgress("Idle", info);
  }

  if (info.semanticPhase === "thinking") return appendPlanProgress("Thinking", info);

  if (info.lastToolName && info.pendingToolUseIds.size > 0) {
    return appendPlanProgress(formatToolSubtitle(info), info);
  }

  return appendPlanProgress("Working", info);
}

/**
 * Pure state machine: (currentInfo, event) -> newInfo
 */
export function transcriptReducer(
  current: TranscriptInfo,
  event: TranscriptEvent,
  signal?: ParsedTranscriptSignal,
): TranscriptInfo {
  const now = Date.now();
  // Clone sets to avoid mutation
  const pendingToolUseIds = new Set(current.pendingToolUseIds);

  let status = current.status;
  let lastToolName = current.lastToolName;
  let lastToolTarget = current.lastToolTarget;
  let costUsd = current.costUsd;
  let lastError = current.lastError;
  let planProgress = current.planProgress;
  let idleReason = current.idleReason;
  let semanticPhase = current.semanticPhase;
  let semanticSignalGroup = current.semanticSignalGroup;
  let semanticSignalKey = current.semanticSignalKey;
  let semanticSignalPattern = current.semanticSignalPattern;
  let semanticSignalDescription = current.semanticSignalDescription;

  if (signal) {
    semanticPhase = signal.semanticPhase;
    semanticSignalGroup = signal.signalGroup;
    semanticSignalKey = signal.signalKey;
    const def = getTranscriptSignalDefinition(signal.signalKey);
    semanticSignalPattern = def?.pattern ?? null;
    semanticSignalDescription = def?.description ?? null;

    if (signal.idleReasonHint !== "none") {
      idleReason = signal.idleReasonHint;
    } else if (signal.semanticPhase !== "waiting") {
      // Non-waiting phases clear stale idle reasons.
      // Waiting-phase events (result, turn.completed) preserve the idle reason
      // set by preceding events in the same turn — it's still relevant to the user.
      // turn_started explicitly clears idle reason in the switch below.
      idleReason = "none";
    }
  }

  switch (event.type) {
    case "turn_started": {
      idleReason = "none";
      lastError = null;
      break;
    }

    case "tool_use": {
      pendingToolUseIds.add(event.id);
      lastToolName = event.name;
      lastToolTarget = deriveToolTarget(event.name, event.input);
      if (idleReason !== "waiting_for_approval" && idleReason !== "waiting_for_input") {
        idleReason = "none";
      }
      if (event.name === "TodoWrite") {
        const todos = event.input.todos;
        if (Array.isArray(todos)) {
          const total = todos.length;
          const done = todos.filter(
            (t: unknown) =>
              typeof t === "object" && t !== null && (t as Record<string, unknown>).status === "completed",
          ).length;
          planProgress = { total, done };
        }
      }
      if (event.name === "TaskCreate") {
        const prev = current.planProgress ?? { total: 0, done: 0 };
        planProgress = { total: prev.total + 1, done: prev.done };
      }
      if (event.name === "TaskUpdate") {
        const taskStatus = event.input.status;
        if (taskStatus === "completed") {
          const prev = current.planProgress ?? { total: 0, done: 0 };
          planProgress = { total: prev.total, done: prev.done + 1 };
        } else if (taskStatus === "deleted") {
          const prev = current.planProgress ?? { total: 0, done: 0 };
          planProgress = { total: Math.max(0, prev.total - 1), done: prev.done };
        }
      }
      break;
    }

    case "tool_result": {
      pendingToolUseIds.delete(event.tool_use_id);
      break;
    }

    case "assistant_text": {
      break;
    }

    case "result": {
      costUsd = event.cost ?? costUsd;
      pendingToolUseIds.clear();
      break;
    }

    case "compaction": {
      // Status carries over — no state reset
      break;
    }

    // Codex events
    case "command_started": {
      pendingToolUseIds.add(event.id);
      lastToolName = event.command || "Bash";
      lastToolTarget = event.target ? truncate(event.target, 40) : null;
      if (idleReason !== "waiting_for_approval" && idleReason !== "waiting_for_input") {
        idleReason = "none";
      }
      break;
    }

    case "item_completed": {
      pendingToolUseIds.delete(event.id);
      break;
    }

    case "turn_completed": {
      if (event.cost != null) {
        costUsd = (costUsd ?? 0) + event.cost;
      }
      break;
    }

    case "system_error":
    case "api_error": {
      pendingToolUseIds.clear();
      lastToolName = null;
      lastToolTarget = null;
      lastError = { message: event.message, time: now };
      break;
    }

    case "turn_failed": {
      pendingToolUseIds.clear();
      lastToolName = null;
      lastToolTarget = null;
      lastError = { message: event.error ?? "Turn failed", time: now };
      break;
    }

    case "context_compacted":
    case "ignored": {
      // No-op — agent continues
      break;
    }
  }

  const previousStatus = status !== current.status ? current.status : current.previousStatus;

  const next: TranscriptInfo = {
    ...current,
    status,
    previousStatus,
    lastToolName,
    lastToolTarget,
    costUsd,
    lastError,
    planProgress,
    idleReason,
    semanticPhase,
    semanticSignalGroup,
    semanticSignalKey,
    semanticSignalPattern,
    semanticSignalDescription,
    signalConfidence: signal?.confidence ?? current.signalConfidence,
    pendingToolUseIds,
    lastEventTime: now,
    source: "transcript",
    subtitle: "", // will be derived below
  };

  next.subtitle = deriveSubtitle(next);

  return next;
}
