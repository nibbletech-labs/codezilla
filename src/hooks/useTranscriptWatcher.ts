import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../store/appStore";
import { createInitialTranscriptInfo } from "../store/transcriptTypes";
import type { TranscriptInfo } from "../store/transcriptTypes";
import type { RuntimeStateSource } from "../store/transcriptTypes";
import { parseClaudeLineDetailed, parseCodexLineDetailed } from "../lib/transcriptParser";
import { transcriptReducer, deriveSubtitle } from "../lib/transcriptStateMachine";
import { deriveCoreRuntimeStatus } from "../lib/threadActivityCore";
import {
  isTurnCompletionEvent,
  shouldAssignDoneBadgeOnCompletion,
  shouldPromoteToWaitingFallback,
} from "../lib/transcriptStatusRules";
import {
  watchTranscript,
  unwatchTranscript,
  switchTranscript,
  discoverTranscript,
  registerCodexThread,
  unregisterCodexThread,
} from "../lib/tauri";
import type { Thread } from "../store/types";

interface TranscriptLinePayload {
  thread_id: string;
  line: string;
}

interface CodexBindingPayload {
  thread_id: string;
  state: "pending" | "bound" | "failed";
  path: string | null;
  codex_session_id: string | null;
  attempts: number;
  error: string | null;
}

const discoveryInFlight = new Set<string>();
const discoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const parseMetrics = new Map<string, ParseMetrics>();
const codexReregistrationTimes = new Map<string, number>();

const CODEX_REREG_COOLDOWN_MS = 300_000; // 5 minutes between re-registration attempts

const DISCOVERY_INITIAL_DELAY_MS = 1500;
const DISCOVERY_RETRY_MS = 2000;
const DISCOVERY_MAX_ATTEMPTS = 30;
const PARSER_DEGRADED_MIN_UNPARSED = 20;
const IGNORED_UPDATE_MIN_INTERVAL_MS = 250;

function parseBooleanFlag(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw == null || raw.trim() === "") return defaultValue;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return defaultValue;
}

const ENABLE_TRANSCRIPT_WATCHER = parseBooleanFlag(
  import.meta.env.VITE_ENABLE_TRANSCRIPT_WATCHER,
  true,
);
const DEBUG_TRANSCRIPT_SIGNALS = parseBooleanFlag(
  import.meta.env.VITE_DEBUG_TRANSCRIPT_SIGNALS,
  false,
);

interface ParseMetrics {
  parsed: number;
  unparsed: number;
  ignored: number;
  lastLineTime: number | null;
  lastParsedTime: number | null;
}

function getParseMetrics(threadId: string): ParseMetrics {
  let metrics = parseMetrics.get(threadId);
  if (!metrics) {
    metrics = {
      parsed: 0,
      unparsed: 0,
      ignored: 0,
      lastLineTime: null,
      lastParsedTime: null,
    };
    parseMetrics.set(threadId, metrics);
  }
  return metrics;
}

function getParserHealth(parsed: number, unparsed: number): "unknown" | "healthy" | "degraded" {
  if (parsed > 0) return "healthy";
  if (unparsed >= PARSER_DEGRADED_MIN_UNPARSED) return "degraded";
  return "unknown";
}

function withDiagnostics(
  info: TranscriptInfo,
  metrics: ParseMetrics,
  source?: RuntimeStateSource,
): TranscriptInfo {
  return {
    ...info,
    parsedLineCount: metrics.parsed,
    unparsedLineCount: metrics.unparsed,
    ignoredLineCount: metrics.ignored,
    lastLineTime: metrics.lastLineTime,
    lastParsedTime: metrics.lastParsedTime,
    parserHealth: getParserHealth(metrics.parsed, metrics.unparsed),
    ...(source ? { source } : {}),
  };
}

function shouldEmitUnparsedUpdate(unparsedCount: number): boolean {
  return unparsedCount <= 3 || unparsedCount % 50 === 0;
}

const ignoredUpdateTimestamps = new Map<string, number>();

function shouldEmitIgnoredUpdate(
  threadId: string,
  ignoredCount: number,
  now: number,
): boolean {
  const last = ignoredUpdateTimestamps.get(threadId) ?? 0;
  if (
    ignoredCount <= 3
    || ignoredCount % 25 === 0
    || now - last >= IGNORED_UPDATE_MIN_INTERVAL_MS
  ) {
    ignoredUpdateTimestamps.set(threadId, now);
    return true;
  }
  return false;
}

export function useTranscriptWatcher() {
  const prevThreadsRef = useRef<Thread[]>([]);
  const threadLookupRef = useRef<Map<string, Thread>>(new Map());
  if (!ENABLE_TRANSCRIPT_WATCHER) return;

  useEffect(() => {
    const initialThreads = useAppStore.getState().threads;
    prevThreadsRef.current = initialThreads;
    threadLookupRef.current = new Map(initialThreads.map((thread) => [thread.id, thread]));
  }, []);

  // Listen for deterministic Codex binding updates from Rust
  useEffect(() => {
    const unlisten = listen<CodexBindingPayload>("codex-binding-update", (event) => {
      const payload = event.payload;
      const state = useAppStore.getState();
      const thread = threadLookupRef.current.get(payload.thread_id);
      if (!thread || thread.type !== "codex") return;

      if (payload.codex_session_id) {
        state.setCodexThreadId(payload.thread_id, payload.codex_session_id);
      }

      const metrics = getParseMetrics(payload.thread_id);
      const current = state.transcriptInfo[payload.thread_id] ?? createInitialTranscriptInfo();
      const next = withDiagnostics(
        {
          ...current,
          codexBindingState: payload.state,
          codexBindingAttempts: payload.attempts,
          codexBindingError: payload.error ?? null,
          ...(payload.path ? { transcriptPath: payload.path } : {}),
        },
        metrics,
        current.source,
      );
      state.updateTranscriptInfo(payload.thread_id, next);

      if (payload.state === "bound" && payload.path) {
        const alreadyWatching = current.transcriptPath === payload.path;
        if (!alreadyWatching) {
          watchTranscript(payload.thread_id, payload.path, thread.resuming).catch(console.error);
        }
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Listen for transcript-line events from Rust
  useEffect(() => {
    const unlisten = listen<TranscriptLinePayload>("transcript-line", (event) => {
      const { thread_id, line } = event.payload;
      const state = useAppStore.getState();
      const thread = threadLookupRef.current.get(thread_id);
      if (!thread) return;

      const now = Date.now();
      const metrics = getParseMetrics(thread_id);
      metrics.lastLineTime = now;

      // Parse with appropriate parser
      const parser = thread.type === "codex" ? parseCodexLineDetailed : parseClaudeLineDetailed;
      const parsed = parser(line);
      if (!parsed) {
        metrics.unparsed += 1;
        if (shouldEmitUnparsedUpdate(metrics.unparsed)) {
          const current = state.transcriptInfo[thread_id] ?? createInitialTranscriptInfo();
          const next = withDiagnostics(current, metrics);
          state.updateTranscriptInfo(thread_id, next);
          if (next.parserHealth === "degraded" && metrics.unparsed === PARSER_DEGRADED_MIN_UNPARSED) {
            console.warn(`[transcript] parser degraded for thread ${thread_id}; no recognized events yet`);
          }
        }
        return;
      }

      // Ignored lines are intentionally recognized but not state-relevant.
      // We still update lastLineTime so the done-confirmation timer knows
      // transcript data is still flowing (e.g. progress heartbeats during thinking).
      if (parsed.event.type === "ignored") {
        metrics.ignored += 1;
        if (shouldEmitIgnoredUpdate(thread_id, metrics.ignored, now)) {
          const current = state.transcriptInfo[thread_id] ?? createInitialTranscriptInfo();
          state.updateTranscriptInfo(thread_id, withDiagnostics(current, metrics));
        }
        return;
      }

      metrics.parsed += 1;
      metrics.lastParsedTime = now;

      // Run state machine
      const current = state.transcriptInfo[thread_id] ?? createInitialTranscriptInfo();
      const currentWithDiagnostics = withDiagnostics(current, metrics);
      const next = transcriptReducer(currentWithDiagnostics, parsed.event, parsed);
      const nextSource: RuntimeStateSource =
        current.source === "pty" || current.source === "mixed"
          ? "mixed"
          : "transcript";
      const nextWithDiagnostics = withDiagnostics(next, metrics, nextSource);

      // Most transcript turn-completion events are authoritative. If PTY activity
      // got stuck active, force the runtime status back to idle.
      //
      // Exception: Codex `event_msg.task_complete` can appear before all visible
      // terminal activity has settled, so don't force-idle on that signal alone.
      const shouldForceIdleOnCompletion =
        isTurnCompletionEvent(parsed.event)
        && parsed.signalKey !== "codex.event.task_complete";
      if (shouldForceIdleOnCompletion && nextWithDiagnostics.ptyActive) {
        nextWithDiagnostics.ptyActive = false;
        nextWithDiagnostics.status = deriveCoreRuntimeStatus(
          nextWithDiagnostics.status,
          false,
        );
        nextWithDiagnostics.subtitle = deriveSubtitle(nextWithDiagnostics);
      }

      if (DEBUG_TRANSCRIPT_SIGNALS) {
        console.debug(
          `[transcript-signal] ${thread.type}:${thread_id} signal=${parsed.signalKey} group=${parsed.signalGroup} phase=${parsed.semanticPhase} event=${parsed.event.type} idleHint=${parsed.idleReasonHint}`,
        );
      }

      // Handle compaction: switch transcript file
      if (parsed.event.type === "compaction") {
        switchTranscript(thread_id, parsed.event.newTranscriptPath).catch(console.error);
        nextWithDiagnostics.transcriptPath = parsed.event.newTranscriptPath;
      }

      // Update badge for non-active idle threads when idle reason changes.
      // This is the authoritative badge setter — PTY transitions only update
      // status, not badges, to avoid flash-on/flash-off from resize redraws.
      if (thread_id !== state.activeThreadId && nextWithDiagnostics.status === "idle") {
        if (nextWithDiagnostics.idleReason === "waiting_for_approval") {
          nextWithDiagnostics.badge = "needs_approval";
          nextWithDiagnostics.badgeSince = nextWithDiagnostics.badgeSince ?? Date.now();
          nextWithDiagnostics.badgeDismissedAt = null;
        } else if (nextWithDiagnostics.idleReason === "waiting_for_input") {
          nextWithDiagnostics.badge = "needs_input";
          nextWithDiagnostics.badgeSince = nextWithDiagnostics.badgeSince ?? Date.now();
          nextWithDiagnostics.badgeDismissedAt = null;
        } else if (nextWithDiagnostics.lastError && !nextWithDiagnostics.badge) {
          nextWithDiagnostics.badge = "error";
          nextWithDiagnostics.badgeSince = nextWithDiagnostics.badgeSince ?? Date.now();
          nextWithDiagnostics.badgeDismissedAt = null;
        }
      }
      // Once the transcript replay reaches a completion event, the historical
      // re-run is done. Clear the resuming flag so semantic signals are used again.
      if (thread.resuming && isTurnCompletionEvent(parsed.event)) {
        state.clearResuming(thread_id);
      }

      if (isTurnCompletionEvent(parsed.event)) {
        const completionTimestamp = Math.max(
          nextWithDiagnostics.lastEventTime,
          nextWithDiagnostics.lastParsedTime ?? 0,
        );
        const completionAlreadyDismissed = nextWithDiagnostics.badgeDismissedAt != null
          && nextWithDiagnostics.badgeDismissedAt >= completionTimestamp;

        if (
          thread_id === state.activeThreadId
          && shouldAssignDoneBadgeOnCompletion(nextWithDiagnostics, thread.type)
        ) {
          // Completion happened while visible, so suppress any delayed done badge
          // from fallback timers after the user switches away.
          nextWithDiagnostics.badgeDismissedAt = completionTimestamp;
        } else if (
          thread_id !== state.activeThreadId
          && !nextWithDiagnostics.badge
          && !completionAlreadyDismissed
          && shouldAssignDoneBadgeOnCompletion(nextWithDiagnostics, thread.type)
        ) {
          nextWithDiagnostics.badge = "done";
          nextWithDiagnostics.badgeSince = nextWithDiagnostics.badgeSince ?? Date.now();
          nextWithDiagnostics.badgeDismissedAt = null;
        }
      }

      state.updateTranscriptInfo(thread_id, nextWithDiagnostics);

      // Notifications are driven by PTY lifecycle transitions in Terminal.tsx.
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Watch for thread lifecycle changes — start/stop transcript watching
  useEffect(() => {
    const unsub = useAppStore.subscribe((state) => {
      const prevThreads = prevThreadsRef.current;
      const currentThreads = state.threads;

      // Skip entirely when the threads array reference hasn't changed.
      // This callback fires on every store mutation (including frequent
      // transcriptInfo updates), but we only care about thread lifecycle.
      if (currentThreads === prevThreads) return;

      // Advance immediately to avoid re-entrant subscribe loops when this
      // callback performs store writes (e.g. updateTranscriptInfo).
      prevThreadsRef.current = currentThreads;
      threadLookupRef.current = new Map(currentThreads.map((t) => [t.id, t]));

      // Build a lookup map for O(1) access instead of O(N) .find() per thread.
      const prevMap = new Map(prevThreads.map((t) => [t.id, t]));

      for (const thread of currentThreads) {
        const prev = prevMap.get(thread.id);
        const justStarted =
          thread.state === "running" && (!prev || prev.state !== "running");

        if (justStarted) {
          // Initialize transcript info
          parseMetrics.set(thread.id, {
            parsed: 0,
            unparsed: 0,
            ignored: 0,
            lastLineTime: null,
            lastParsedTime: null,
          });
          const metrics = getParseMetrics(thread.id);
          const initialInfo = withDiagnostics(createInitialTranscriptInfo(), metrics);
          state.updateTranscriptInfo(
            thread.id,
            {
              ...initialInfo,
              ...(thread.type === "codex"
                ? { codexBindingState: "pending" as const, codexBindingAttempts: 0, codexBindingError: null }
                : {}),
            },
          );

          if (thread.type === "claude") {
            setTimeout(() => {
              startDiscoveryWithRetry(thread.id, 0);
            }, DISCOVERY_INITIAL_DELAY_MS);
          } else if (thread.type === "codex") {
            const project = state.projects.find((p) => p.id === thread.projectId);
            // Always use CWD+time matching (null expectedCodexId) rather than session-id matching.
            // Session-id matching causes premature binding to the OLD rollout file before Codex
            // creates a fresh one for a new run (resume or otherwise). CWD+time naturally finds
            // the fresh file once Codex writes it, regardless of whether Codex appends to the
            // existing file or creates a new one. The codexThreadId is still used for the
            // `codex resume {id}` CLI command in Terminal.tsx.

            if (project?.path) {
              registerCodexThread(
                thread.id,
                project.path,
                Date.now(),
                null,
              ).catch((error) => {
                console.error(error);
                const current = useAppStore.getState().transcriptInfo[thread.id] ?? createInitialTranscriptInfo();
                const metrics = getParseMetrics(thread.id);
                useAppStore.getState().updateTranscriptInfo(
                  thread.id,
                  withDiagnostics(
                    {
                      ...current,
                      codexBindingState: "failed",
                      codexBindingError: "Failed to register Codex thread binding",
                    },
                    metrics,
                    current.source,
                  ),
                );
              });
            } else {
              const current = state.transcriptInfo[thread.id] ?? createInitialTranscriptInfo();
              state.updateTranscriptInfo(
                thread.id,
                withDiagnostics(
                  {
                    ...current,
                    codexBindingState: "failed",
                    codexBindingError: "Missing project path for Codex binding",
                  },
                  metrics,
                  current.source,
                ),
              );
            }
          }
        }

        // Thread exited or removed — stop watching and clean up all tracking maps
        if (prev?.state === "running" && thread.state !== "running") {
          unwatchTranscript(thread.id).catch(console.error);
          if (thread.type === "codex") {
            unregisterCodexThread(thread.id).catch(console.error);
          }
          discoveryInFlight.delete(thread.id);
          codexReregistrationTimes.delete(thread.id);
          parseMetrics.delete(thread.id);
          ignoredUpdateTimestamps.delete(thread.id);
          const discoveryTimer = discoveryTimers.get(thread.id);
          if (discoveryTimer != null) {
            clearTimeout(discoveryTimer);
            discoveryTimers.delete(thread.id);
          }

          const info = state.transcriptInfo[thread.id];
          if (info && info.status !== "exited") {
            state.updateTranscriptInfo(thread.id, {
              ...info,
              previousStatus: info.status,
              status: "exited",
              subtitle: "Session ended",
              badge: null,
              badgeSince: null,
              source:
                info.source === "unknown" ? "pty" : info.source,
            });
          }
        }
      }

      // Handle removed threads
      const currentMap = new Map(currentThreads.map((t) => [t.id, t]));
      for (const prev of prevThreads) {
        if (!currentMap.has(prev.id)) {
          unwatchTranscript(prev.id).catch(console.error);
          if (prev.type === "codex") {
            unregisterCodexThread(prev.id).catch(console.error);
          }
          state.clearTranscriptInfo(prev.id);
          discoveryInFlight.delete(prev.id);
          codexReregistrationTimes.delete(prev.id);
          const discoveryTimer = discoveryTimers.get(prev.id);
          if (discoveryTimer != null) {
            clearTimeout(discoveryTimer);
            discoveryTimers.delete(prev.id);
          }
          parseMetrics.delete(prev.id);
          ignoredUpdateTimestamps.delete(prev.id);
        }
      }

    });

    return unsub;
  }, []);

  // Badge cleanup + done-confirmation timer
  useEffect(() => {
    const DEFAULT_DONE_CONFIRM_MS = 6000;
    const CODEX_DONE_CONFIRM_MS = 12000;
    const STALE_PTY_ACTIVE_MS = 5000;

    const interval = setInterval(() => {
      const state = useAppStore.getState();
      const transcriptEntries = Object.entries(state.transcriptInfo);
      // Skip all work when there are no transcript entries (e.g. app just
      // launched and no threads have been started/resumed yet).
      if (transcriptEntries.length === 0) return;
      const now = Date.now();

      // Build lookup map once per tick instead of .find() per entry (O(N²) → O(N)).
      const threadMap = new Map(state.threads.map((t) => [t.id, t]));

      for (const [threadId, info] of transcriptEntries) {
        const thread = threadMap.get(threadId);
        const threadType = thread?.type ?? null;

        // Stale PTY recovery: the transcript says the turn finished
        // (semanticPhase == "waiting") but ptyActive is stuck true because
        // a progress marker never sent its idle counterpart.  Force-idle
        // after STALE_PTY_ACTIVE_MS so the thread doesn't stay "Working".
        if (
          info.ptyActive
          && info.semanticPhase === "waiting"
          && info.idleReason === "none"
          && !info.lastError
          && info.pendingToolUseIds.size === 0
          && info.ptyLastTransitionAt
          && now - info.ptyLastTransitionAt > STALE_PTY_ACTIVE_MS
        ) {
          const updated: TranscriptInfo = {
            ...info,
            ptyActive: false,
            status: deriveCoreRuntimeStatus(info.status, false),
            ptyLastTransitionReason: "stale_pty_recovery",
            ptyLastTransitionAt: now,
          };
          updated.subtitle = deriveSubtitle(updated);
          state.updateTranscriptInfo(threadId, updated);
          continue;
        }

        const doneConfirmMs = threadType === "codex"
          ? CODEX_DONE_CONFIRM_MS
          : DEFAULT_DONE_CONFIRM_MS;
        if (shouldPromoteToWaitingFallback(info, threadType, now, doneConfirmMs)) {
          const updated = {
            ...info,
            semanticPhase: "waiting" as const,
            subtitle: "",
          };
          updated.subtitle = deriveSubtitle(updated);
          // Also set badge if thread is not active and user hasn't already dismissed it
          const lastEvent = Math.max(info.lastEventTime, info.lastParsedTime ?? 0);
          if (
            threadId !== state.activeThreadId
            && !updated.badge
            && !(info.badgeDismissedAt && info.badgeDismissedAt >= lastEvent)
          ) {
            updated.badge = "done";
            updated.badgeSince = now;
          }
          state.updateTranscriptInfo(threadId, updated);
          continue;
        }

        // Clear stale/invalid done badges immediately (for example badges that
        // were assigned while the thread wasn't actually in completion state).
        if (
          info.badge === "done"
          && (
            info.semanticPhase !== "waiting"
            || info.idleReason !== "none"
            || info.lastError != null
            || info.pendingToolUseIds.size > 0
            || info.ptyActive
          )
        ) {
          state.updateTranscriptInfo(threadId, {
            ...info,
            badge: null,
            badgeSince: null,
          });
          continue;
        }

        // Auto-clear "done" and "error" badges after 30 seconds.
        // "needs_input" / "needs_approval" persist until the user selects the thread.
        if (
          (info.badge === "done" || info.badge === "error") &&
          info.badgeSince &&
          now - info.badgeSince > 30000
        ) {
          state.updateTranscriptInfo(threadId, {
            ...info,
            badge: null,
            badgeSince: null,
          });
        }

        // Re-register Codex binding when it failed but PTY is still active.
        // This recovers threads where binding timed out before the user sent
        // their first message (the rollout file doesn't exist yet at that point).
        if (
          info.codexBindingState === "failed"
          && info.ptyActive
          && thread?.type === "codex"
          && thread.state === "running"
        ) {
          const lastRereg = codexReregistrationTimes.get(threadId) ?? 0;
          if (now - lastRereg > CODEX_REREG_COOLDOWN_MS) {
            codexReregistrationTimes.set(threadId, now);
            const project = state.projects.find((p) => p.id === thread.projectId);
            if (project?.path) {
              registerCodexThread(thread.id, project.path, Date.now(), null).catch(console.error);
            }
          }
        }
      }
    }, 1000);

    return () => clearInterval(interval);
  }, []);
}

async function startDiscoveryWithRetry(
  threadId: string,
  attempt: number,
): Promise<void> {
  const state = useAppStore.getState();
  const thread = state.threads.find((t) => t.id === threadId);
  const info = state.transcriptInfo[threadId];

  if (!thread || thread.state !== "running" || thread.type !== "claude") {
    discoveryInFlight.delete(threadId);
    discoveryTimers.delete(threadId);
    return;
  }

  if (!thread.claudeSessionId) {
    discoveryInFlight.delete(threadId);
    discoveryTimers.delete(threadId);
    return;
  }

  if (info?.transcriptPath) {
    discoveryInFlight.delete(threadId);
    discoveryTimers.delete(threadId);
    return;
  }

  if (attempt === 0) {
    if (discoveryInFlight.has(threadId)) return;
    discoveryInFlight.add(threadId);
  }

  let path: string | null = null;

  try {
    path = await discoverTranscript(thread.claudeSessionId);
  } catch {
    // ignore and retry below
  }

  if (path) {
    try {
      await watchTranscript(threadId, path, thread.resuming);
      const current = useAppStore.getState().transcriptInfo[threadId] ?? createInitialTranscriptInfo();
      const metrics = getParseMetrics(threadId);
      useAppStore.getState().updateTranscriptInfo(
        threadId,
        withDiagnostics(
          {
            ...current,
            transcriptPath: path,
          },
          metrics,
          current.source === "pty" ? "mixed" : current.source,
        ),
      );
      console.info(`[transcript] watching ${thread.type} transcript for ${threadId}: ${path}`);
      discoveryInFlight.delete(threadId);
      return;
    } catch {
      // continue to retry
    }
  }

  if (attempt >= DISCOVERY_MAX_ATTEMPTS - 1) {
    discoveryInFlight.delete(threadId);
    console.warn(`[transcript] failed to discover transcript for thread ${threadId} after retries`);
    return;
  }

  const timerId = setTimeout(() => {
    startDiscoveryWithRetry(threadId, attempt + 1);
  }, DISCOVERY_RETRY_MS);
  discoveryTimers.set(threadId, timerId);
}
