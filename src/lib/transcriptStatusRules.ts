import type { TranscriptInfo } from "../store/transcriptTypes";
import type { ThreadType } from "../store/types";
import type { TranscriptEvent } from "./transcriptParser.ts";

export function isTurnCompletionEvent(event: TranscriptEvent): boolean {
  return event.type === "result" || event.type === "turn_completed";
}

export function shouldAssignDoneBadgeOnCompletion(
  info: TranscriptInfo,
  threadType: ThreadType,
): boolean {
  if (threadType === "shell") return false;
  if (info.status !== "idle" || info.ptyActive) return false;
  if (info.idleReason !== "none" || info.lastError) return false;
  if (info.pendingToolUseIds.size > 0) return false;
  return true;
}

export function shouldPromoteToWaitingFallback(
  info: TranscriptInfo,
  _threadType: ThreadType | null,
  now: number,
  doneConfirmMs: number,
): boolean {
  if (info.semanticPhase === "waiting") return false;
  // Only promote known mid-turn phases that can get stuck.
  if (
    info.semanticPhase !== "responding"
    && info.semanticPhase !== "tooling"
    && info.semanticPhase !== "thinking"
  ) return false;
  if (info.status !== "idle" || info.ptyActive) return false;
  if (info.idleReason !== "none" || info.lastError) return false;
  if (info.pendingToolUseIds.size > 0) return false;
  if (info.parserHealth !== "healthy") return false;

  // Include PTY transition time: don't promote if the PTY was recently active.
  // During extended thinking Claude may output timer ticks but write no transcript
  // events, causing a brief PTY idle gap that would otherwise trigger a false promotion.
  const lastActivity = Math.max(
    info.lastEventTime,
    info.lastLineTime ?? 0,
    info.ptyLastTransitionAt ?? 0,
  );
  const elapsed = now - lastActivity;

  // "thinking" can legitimately run for many minutes (extended thinking / Musing),
  // so use a much longer threshold before treating it as stuck.
  const threshold = info.semanticPhase === "thinking" ? doneConfirmMs * 8 : doneConfirmMs;
  return elapsed >= threshold;
}
