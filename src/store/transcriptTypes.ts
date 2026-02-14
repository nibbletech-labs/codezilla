export type TranscriptStatus =
  | "working"  // PTY reports active
  | "idle"     // PTY reports inactive for a running thread
  | "exited";  // process/session ended

export type ThreadBadge = "done" | "needs_input" | "needs_approval" | "error" | null;
export type RuntimeStateSource = "unknown" | "transcript" | "pty" | "mixed";
export type ParserHealth = "unknown" | "healthy" | "degraded";
export type PtyLifecycleSource = "unknown" | "output" | "marker";
export type SignalConfidence = "high" | "medium" | "low";
export type SemanticPhase = "unknown" | "initial" | "thinking" | "tooling" | "responding" | "waiting";
export type SemanticSignalGroup = "unknown" | "turn" | "thinking" | "tooling" | "response" | "lifecycle";
export type IdleReason = "none" | "waiting_for_input" | "waiting_for_approval";

export interface ParserDiagnostics {
  parsedLineCount: number;
  unparsedLineCount: number;
  lastLineTime: number | null;
  lastParsedTime: number | null;
  parserHealth: ParserHealth;
  ignoredLineCount: number;
}

export interface TranscriptInfo extends ParserDiagnostics {
  status: TranscriptStatus;
  previousStatus: TranscriptStatus | null;
  badge: ThreadBadge;
  badgeSince: number | null;
  subtitle: string;
  costUsd: number | null;
  transcriptPath: string | null;
  // Internal state machine tracking
  pendingToolUseIds: Set<string>;
  lastToolName: string | null;
  lastToolTarget: string | null;
  lastEventTime: number;
  source: RuntimeStateSource;
  semanticPhase: SemanticPhase;
  semanticSignalGroup: SemanticSignalGroup;
  semanticSignalKey: string | null;
  semanticSignalPattern: string | null;
  semanticSignalDescription: string | null;
  lastError: { message: string; time: number } | null;
  planProgress: { total: number; done: number } | null;
  idleReason: IdleReason;
  signalConfidence: SignalConfidence | null;
  ptyActive: boolean;
  ptyLifecycleSource: PtyLifecycleSource;
  ptyLastTransitionReason: string | null;
  ptyLastTransitionAt: number | null;
  codexBindingState: "pending" | "bound" | "failed" | null;
  codexBindingAttempts: number;
  codexBindingError: string | null;
}

export function createInitialTranscriptInfo(): TranscriptInfo {
  return {
    status: "idle",
    previousStatus: null,
    badge: null,
    badgeSince: null,
    subtitle: "Idle",
    costUsd: null,
    transcriptPath: null,
    pendingToolUseIds: new Set(),
    lastToolName: null,
    lastToolTarget: null,
    lastEventTime: Date.now(),
    parsedLineCount: 0,
    unparsedLineCount: 0,
    lastLineTime: null,
    lastParsedTime: null,
    parserHealth: "unknown",
    source: "unknown",
    semanticPhase: "initial",
    semanticSignalGroup: "unknown",
    semanticSignalKey: null,
    semanticSignalPattern: null,
    semanticSignalDescription: null,
    lastError: null,
    planProgress: null,
    idleReason: "none",
    signalConfidence: null,
    ignoredLineCount: 0,
    ptyActive: false,
    ptyLifecycleSource: "unknown",
    ptyLastTransitionReason: null,
    ptyLastTransitionAt: null,
    codexBindingState: null,
    codexBindingAttempts: 0,
    codexBindingError: null,
  };
}
