import type { Thread } from "../store/types";
import type { TranscriptInfo } from "../store/transcriptTypes";

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

  const lifecycle = deriveLifecycleSubtitle(thread, info.ptyActive);
  const subtitle = info.subtitle?.trim() ?? "";

  if (!isKnownRuntimeStatus(info.status) || looksLikeStarting(subtitle)) {
    return lifecycle;
  }

  if (info.status === "working") {
    if (subtitle && subtitle !== "Idle") {
      return subtitle;
    }
    return "Working";
  }

  if (info.status === "idle") {
    if (subtitle && subtitle !== "Idle") {
      return subtitle;
    }
    return "Idle";
  }

  if (info.parserHealth === "degraded" && !info.ptyActive) {
    return "Idle";
  }

  return subtitle || lifecycle;
}
