import type { Thread } from "../store/types";
import type { TranscriptInfo } from "../store/transcriptTypes";

const RECENT_TRANSCRIPT_ACTIVITY_MS = 8_000;

function deriveLifecycleSubtitle(thread: Thread, ptyActive = false): string {
  if (thread.state === "running") {
    return ptyActive ? "Working" : "Idle";
  }
  if (thread.state === "exited") {
    return thread.exitCode === 0 ? "Session ended" : "Session crashed";
  }
  if (thread.state === "dormant") return "Saved session";
  return "";
}

function isKnownRuntimeStatus(status: string): boolean {
  return status === "working" || status === "idle" || status === "exited";
}

function looksLikeStarting(subtitle: string): boolean {
  return subtitle.trim().toLowerCase().startsWith("starting");
}

function isSemanticActive(info: TranscriptInfo): boolean {
  return info.semanticPhase === "thinking"
    || info.semanticPhase === "tooling"
    || info.semanticPhase === "responding";
}

function hasRecentTranscriptHeartbeat(info: TranscriptInfo, now: number): boolean {
  const lastTranscriptActivity = Math.max(
    info.lastLineTime ?? 0,
    info.lastParsedTime ?? 0,
  );
  return lastTranscriptActivity > 0 && (now - lastTranscriptActivity) <= RECENT_TRANSCRIPT_ACTIVITY_MS;
}

function isDoneState(info: TranscriptInfo): boolean {
  return info.status === "idle"
    && info.semanticPhase === "waiting"
    && info.idleReason === "none"
    && !info.lastError
    && info.pendingToolUseIds.size === 0;
}

function isLikelyStaleDoneWhileStreaming(
  thread: Thread,
  info: TranscriptInfo,
  now: number,
): boolean {
  if (thread.type === "shell") return false;
  if (info.semanticPhase !== "waiting") return false;
  if (info.idleReason !== "none" || info.lastError || info.pendingToolUseIds.size > 0) return false;
  if (!hasRecentTranscriptHeartbeat(info, now)) return false;

  const lastLineTime = info.lastLineTime ?? 0;
  const lastParsedTime = info.lastParsedTime ?? 0;
  // If unparsed transcript lines are still arriving after the last parsed
  // completion signal, treat "Idle · Done" as stale until parsing catches up.
  return lastLineTime > lastParsedTime;
}

export function isThreadLikelyWorking(
  thread: Thread,
  info: TranscriptInfo | null | undefined,
  now = Date.now(),
): boolean {
  if (thread.state !== "running") return false;
  if (!info) return false;

  if (thread.type === "shell") {
    return info.ptyActive || info.status === "working";
  }

  const waitingForUser = info.idleReason === "waiting_for_input"
    || info.idleReason === "waiting_for_approval";
  if (waitingForUser || info.lastError || isDoneState(info)) {
    return isLikelyStaleDoneWhileStreaming(thread, info, now);
  }

  // While a thread is replaying its transcript history on resume, suppress
  // semantic-phase signals — the state machine re-runs old events and will
  // temporarily show "thinking"/"tooling" until the replay reaches the
  // completion event. Only PTY activity is authoritative at this point.
  const semanticSignalsReady = !thread.resuming;

  if (info.status === "working" || info.ptyActive
    || (semanticSignalsReady && (isSemanticActive(info) || info.pendingToolUseIds.size > 0))
  ) {
    return true;
  }

  return hasRecentTranscriptHeartbeat(info, now)
    && info.semanticPhase !== "waiting"
    && info.idleReason === "none";
}

export function getThreadSubtitle(
  thread: Thread,
  info: TranscriptInfo | null | undefined,
): string {
  // Shell threads are PTY-only; transcript semantics do not apply.
  if (thread.type === "shell") {
    return deriveLifecycleSubtitle(thread, info?.ptyActive ?? false);
  }

  if (!info) {
    return deriveLifecycleSubtitle(thread);
  }

  if (thread.state !== "running") {
    return deriveLifecycleSubtitle(thread, info.ptyActive);
  }

  const now = Date.now();
  const lifecycle = deriveLifecycleSubtitle(thread, info.ptyActive);
  const subtitle = info.subtitle?.trim() ?? "";

  if (info.ptyActive && info.status !== "working") {
    if (
      !subtitle
      || subtitle === "Idle"
      || subtitle.startsWith("Idle ·")
      || looksLikeStarting(subtitle)
    ) {
      return "Working";
    }
    return subtitle;
  }

  if (thread.type === "codex" && info.status === "idle" && (subtitle === "" || subtitle === "Idle")) {
    // Only surface binding status when the thread has been genuinely idle for a while.
    // Codex marker events (CommandEnd → CommandStart) create brief idle gaps between
    // tool calls, so we must not show these messages during active-but-between-commands gaps.
    const genuinelyIdle = !info.ptyLastTransitionAt || now - info.ptyLastTransitionAt > 8_000;
    if (genuinelyIdle) {
      if (info.codexBindingState === "pending" && (info.codexBindingAttempts ?? 0) > 45) {
        return "Connecting transcript";
      }
      if (info.codexBindingState === "failed") {
        return "Transcript unavailable";
      }
    }
  }

  if (!isKnownRuntimeStatus(info.status) || looksLikeStarting(subtitle)) {
    return lifecycle;
  }

  if (info.status === "working") {
    if (subtitle && subtitle !== "Idle" && !subtitle.startsWith("Idle ·")) {
      return subtitle;
    }
    return "Working";
  }

  if (info.status === "idle") {
    if (isThreadLikelyWorking(thread, info)) {
      if (
        !subtitle
        || subtitle === "Idle"
        || subtitle.startsWith("Idle ·")
        || looksLikeStarting(subtitle)
      ) {
        return "Working";
      }
    }

    if (subtitle && subtitle !== "Idle") {
      return subtitle;
    }
    return "Idle";
  }

  if (info.parserHealth === "degraded" && !info.ptyActive) {
    return "Idle";
  }

  if ((!subtitle || subtitle === "Idle") && isThreadLikelyWorking(thread, info)) {
    return "Working";
  }
  return subtitle || lifecycle;
}
