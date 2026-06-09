import type { Thread } from "../store/types";
import type { TranscriptInfo } from "../store/transcriptTypes";
import type { ThreadActivityState } from "../store/activityTypes";
import { formatToolSubtitle } from "./toolDisplay.ts";

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

/**
 * Dumb PTY-only "is working" check, used when no hook events have fired yet
 * (e.g. the thread's PTY pre-dates Phase 2's env-var injection, or Codex's
 * hook bundle hasn't shipped yet). Once a hook fires for the thread, the
 * hook-authoritative path in `threadActivityState` takes over.
 */
function ptyBasedIsWorking(
  thread: Thread,
  info: TranscriptInfo | null | undefined,
): boolean {
  if (thread.state !== "running") return false;
  if (!info) return false;
  return info.ptyActive === true;
}

/**
 * Three-state activity derivation. When hook-based detection is engaged for a
 * thread (`info.hookAuthoritative === true`), the reducer-maintained
 * `info.activityState` is the source of truth. Otherwise we fall back to the
 * dumb PTY-only check, mapping it onto the three-state model.
 */
export function threadActivityState(
  thread: Thread,
  info: TranscriptInfo | null | undefined,
): ThreadActivityState {
  if (thread.state !== "running") return "idle";
  if (!info) return "idle";

  if (info.hookAuthoritative && info.activityState) {
    return info.activityState;
  }

  return ptyBasedIsWorking(thread, info) ? "working" : "idle";
}

/**
 * Backwards-compatible boolean wrapper. Most existing callers only need a
 * working/not-working answer.
 */
export function isThreadLikelyWorking(
  thread: Thread,
  info: TranscriptInfo | null | undefined,
): boolean {
  return threadActivityState(thread, info) === "working";
}

export interface ThreadSubtitle {
  body: string;
  progress: string | null;
}

const plain = (body: string): ThreadSubtitle => ({ body, progress: null });

export function getThreadSubtitle(
  thread: Thread,
  info: TranscriptInfo | null | undefined,
): ThreadSubtitle {
  // Shell threads are PTY-only; transcript semantics never applied.
  if (thread.type === "shell") {
    return plain(deriveLifecycleSubtitle(thread, info?.ptyActive ?? false));
  }

  if (!info) {
    return plain(deriveLifecycleSubtitle(thread));
  }

  if (thread.state !== "running") {
    return plain(deriveLifecycleSubtitle(thread, info.ptyActive));
  }

  // Hook-based activity detection takes precedence once a hook event has been
  // observed. Map the three-state model to a subtitle, swap in per-tool detail
  // when working on a known tool, then decorate with plan-mode prefix and
  // surface plan-progress as a separate field so the sidebar can keep it
  // visible while ellipsifying the body.
  if (info.hookAuthoritative && info.activityState) {
    let base = "";
    if (info.activityState === "working") {
      base = info.lastToolName
        ? formatToolSubtitle(info.lastToolName, info.lastToolTarget)
        : "Working";
    } else if (info.activityState === "awaiting_input") {
      base = "Awaiting input";
    } else {
      base = "Idle";
    }

    let progress: string | null = null;
    if (info.planProgress && info.planProgress.total > 0) {
      // Show the in-progress item (1-indexed), not the done count.
      const display = Math.min(info.planProgress.done + 1, info.planProgress.total);
      progress = `(${display}/${info.planProgress.total})`;
    }
    if (info.inPlanMode) base = `Plan mode · ${base}`;
    return { body: base, progress };
  }

  // Hook-less thread (pre-hook PTY, or before the first hook event for this
  // thread). Dumb fallback from PTY activity. Once hooks fire, the hook-
  // authoritative path above takes over.
  return plain(deriveLifecycleSubtitle(thread, info.ptyActive));
}
