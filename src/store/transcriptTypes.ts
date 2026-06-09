import type { ThreadActivityState } from "./activityTypes";

export type TranscriptStatus =
  | "working"  // PTY reports active
  | "idle"     // PTY reports inactive for a running thread
  | "exited";  // process/session ended

export type ThreadBadge = "done" | "needs_input" | "needs_approval" | "error" | null;
export type RuntimeStateSource = "unknown" | "transcript" | "pty" | "mixed";
export type PtyLifecycleSource = "unknown" | "output" | "marker";

export interface TranscriptInfo {
  status: TranscriptStatus;
  badge: ThreadBadge;
  badgeSince: number | null;
  badgeDismissedAt: number | null;
  costUsd: number | null;
  lastEventTime: number;
  source: RuntimeStateSource;
  // Tool detail derived from the most recent hook tool event (pre or post).
  // Cleared on turn_start so the next turn starts with a clean subtitle.
  lastToolName: string | null;
  lastToolTarget: string | null;
  // PTY lifecycle — set by Terminal.tsx from Tauri PTY events.
  ptyActive: boolean;
  ptyLifecycleSource: PtyLifecycleSource;
  ptyLastTransitionReason: string | null;
  ptyLastTransitionAt: number | null;
  // Hook-based activity detection. Set lazily once the first hook event is
  // observed for this thread; never reset while the thread lives. When
  // `hookAuthoritative` is true, `activityState` is the source of truth and
  // the dumb PTY-only fallback is bypassed.
  hookAuthoritative: boolean;
  activityState: ThreadActivityState | null;
  // Plan-mode flag: true between EnterPlanMode (or ExitPlanMode picker showing)
  // and the PostToolUse for ExitPlanMode.
  inPlanMode: boolean;
  // Plan progress: maintained by applyHookEvent from TaskCreate / TaskUpdate /
  // TodoWrite events.
  planProgress: { total: number; done: number } | null;
}

export function createInitialTranscriptInfo(): TranscriptInfo {
  return {
    status: "idle",
    badge: null,
    badgeSince: null,
    badgeDismissedAt: null,
    costUsd: null,
    lastToolName: null,
    lastToolTarget: null,
    lastEventTime: Date.now(),
    source: "unknown",
    ptyActive: false,
    ptyLifecycleSource: "unknown",
    ptyLastTransitionReason: null,
    ptyLastTransitionAt: null,
    hookAuthoritative: false,
    activityState: null,
    inPlanMode: false,
    planProgress: null,
  };
}
