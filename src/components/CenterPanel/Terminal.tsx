import { useEffect, useRef, useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Channel } from "@tauri-apps/api/core";
import {
  spawnPty,
  registerHeedOwner,
  writePty,
  resizePty,
  killPty,
  type PtyEvent,
  type PtyActivityData,
  type PtyCommandEndData,
  type PtyOutputData,
  type PtyExitData,
  type HeedThreadPayload,
} from "../../lib/tauri";
import {
  TERMINAL_CONFIG,
  RESIZE_DEBOUNCE_MS,
} from "../../lib/constants";
import { getTerminalTheme, DARK_PALETTE, LIGHT_PALETTE } from "../../lib/themes";
import { useAppStore } from "../../store/appStore";
import { attributeEnv } from "../../lib/worktree";
import type { Thread, ThreadType, ScheduledJob } from "../../store/types";
import { THREAD_NEW_LABELS } from "../../store/types";
import ThreadIcon from "../LeftPanel/ThreadIcons";
import ProjectIcon from "../ProjectIcon";
import { IconPicker } from "../IconPicker";
import { JobDetailPanel, JobCreationForm } from "../ScheduledJobs";
import { SkillsPluginsSummary, SkillsPluginsManager } from "../SkillsPlugins";
import PresetsManager from "../LaunchPresets/PresetsManager";
import BetaFeaturesManager from "../BetaFeaturesManager";
import {
  clearActivity,
  isOutputActivitySuppressed,
  recordOutput,
  suppressOutputActivity,
} from "../../lib/activityTracker";

import { createFilePathLinkProviderForTerminal } from "../../lib/filePathLinkProvider";
import { createCommitHashLinkProviderForTerminal } from "../../lib/commitHashLinkProvider";
import { collapseProseWraps } from "../../lib/proseCopy";
import { openExternalUrl } from "../../lib/externalLinks";
import { createInitialTranscriptInfo } from "../../store/transcriptTypes";
import type { RuntimeStateSource } from "../../store/transcriptTypes";
import { deriveCoreRuntimeStatus } from "../../lib/threadActivityCore.ts";
import { listen } from "@tauri-apps/api/event";
import type { ThreadActivityState } from "../../store/activityTypes";
import "@xterm/xterm/css/xterm.css";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUUID(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Parse a raw extraArgs string into individual tokens (respecting quoted strings),
 * then shell-escape each token to prevent shell injection via metacharacters.
 * Each token is wrapped in single quotes with internal single quotes escaped as '\''
 */
function shellEscapeArgs(raw: string): string {
  const tokens: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\" && !inSingle) {
      escaped = true;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  // Shell-escape each token: wrap in single quotes, escaping embedded single quotes
  return tokens
    .map((t) => "'" + t.replace(/'/g, "'\\''") + "'")
    .join(" ");
}

// Track sessions that have received first PTY output (shared across instances)
const sessionsWithOutput = new Set<string>();

// Track WebGL addons so we can dispose when too many contexts are active.
// Browsers typically allow 8-16 WebGL contexts; exceeding this causes freezes.
// Map insertion order is used as the LRU ordering: the most-recently-used key
// is always re-inserted at the end (see below), so `keys().next()` is the
// genuine least-recently-used victim on overflow.
const MAX_WEBGL_CONTEXTS = 8;
const webglAddons = new Map<string, import("@xterm/addon-webgl").WebglAddon>();

// Context-loss recovery: under GPU pressure WebKit can drop a context, which
// silently demotes that terminal to the DOM renderer — unusably slow with a
// full scrollback. Re-attach if the terminal is still on screen, but cap
// retries so a flapping GPU degrades to the DOM renderer instead of looping.
const CONTEXT_LOSS_WINDOW_MS = 60_000;
const MAX_CONTEXT_LOSSES_PER_WINDOW = 3;
const CONTEXT_LOSS_REATTACH_DELAY_MS = 300;
const contextLossTimes = new Map<string, number[]>();

/** Lazily attach a WebGL addon to a terminal the first time it becomes visible. */
function ensureWebgl(sessionId: string, terminal: Terminal) {
  if (webglAddons.has(sessionId)) {
    // Already has a context — mark it most-recently-used so swapping back to it
    // doesn't make it the eviction victim. Without this, eviction is by
    // insertion order, so cycling among >MAX sessions thrashes contexts.
    const addon = webglAddons.get(sessionId);
    webglAddons.delete(sessionId);
    if (addon) {
      webglAddons.set(sessionId, addon);
      // GPU pressure can corrupt the glyph atlas (blank or mangled characters)
      // without ever firing context loss; rebuilding it on re-activation keeps
      // that damage from persisting for the rest of the app session.
      addon.clearTextureAtlas();
    }
    return;
  }
  try {
    if (webglAddons.size >= MAX_WEBGL_CONTEXTS) {
      const oldestKey = webglAddons.keys().next().value;
      if (oldestKey != null) {
        const oldAddon = webglAddons.get(oldestKey);
        oldAddon?.dispose();
        webglAddons.delete(oldestKey);
      }
    }
    const webglAddon = new WebglAddon();
    webglAddon.onContextLoss(() => {
      webglAddon.dispose();
      webglAddons.delete(sessionId);

      const now = Date.now();
      const losses = (contextLossTimes.get(sessionId) ?? []).filter(
        (t) => now - t < CONTEXT_LOSS_WINDOW_MS,
      );
      losses.push(now);
      contextLossTimes.set(sessionId, losses);
      if (losses.length > MAX_CONTEXT_LOSSES_PER_WINDOW) return;

      setTimeout(() => {
        const el = terminal.element;
        if (el?.isConnected && getComputedStyle(el).visibility === "visible") {
          ensureWebgl(sessionId, terminal);
        }
      }, CONTEXT_LOSS_REATTACH_DELAY_MS);
    });
    terminal.loadAddon(webglAddon);
    webglAddons.set(sessionId, webglAddon);
    // Force full repaint — the WebGL renderer takes over from canvas but
    // won't automatically redraw existing buffer content.
    terminal.refresh(0, terminal.rows - 1);
  } catch {
    // Canvas fallback
  }
}

interface TerminalInstance {
  terminal: Terminal;
  fitAddon: FitAddon;
  container: HTMLDivElement;
  isAtBottom: boolean;
  /** User intentionally scrolled up — suppresses auto-scroll until they return to the bottom. */
  userScrolledUp: boolean;
  visible: boolean;
  /** Drain any buffered output (call when making terminal visible). */
  flushPendingOutput: () => void;
  hasSelection: boolean;
}

const THREAD_TYPES: ThreadType[] = ["claude", "codex", "shell"];
const RESIZE_ACTIVITY_SUPPRESS_MS = 900;
const TOUCH_DEBOUNCE_MS = 30_000;
const touchTimestamps = new Map<string, number>();
const INPUT_ECHO_SUPPRESS_MS = 450;
const PROGRESS_IDLE_RECOVERY_MS = 4500;
const INTERRUPT_HINT_ACTIVE_MS = 12_000;
const INTERRUPT_HINT_LOOKBACK_LINES = 8;
type ActivityDetectionMode = "hybrid" | "marker";

function parseActivityDetectionMode(raw: string | undefined): ActivityDetectionMode {
  if (raw?.trim().toLowerCase() === "marker") return "marker";
  return "hybrid";
}

const ACTIVITY_DETECTION_MODE = parseActivityDetectionMode(
  import.meta.env.VITE_THREAD_ACTIVITY_MODE,
);
const STRICT_MARKER_MODE = ACTIVITY_DETECTION_MODE === "marker";
const BOTTOM_TOLERANCE_LINES = 1;

function nextPtySource(source: RuntimeStateSource): RuntimeStateSource {
  return source === "transcript" || source === "mixed" ? "mixed" : "pty";
}

function hasInterruptHint(text: string): boolean {
  return /\besc\s+to\s+interrupt\b/i.test(text);
}

function hasClaudeStarActivityHint(text: string): boolean {
  // Decorative star spinner (U+2720-U+274B) + ellipsis — Claude's rotating star animation.
  if (/[\u2720-\u274B].*\u2026/.test(text)) return true;
  // Progress timer on active spinner line: "… (Xs" or "… (Xm Ys".
  // Requires ellipsis before the timer — completed tool results like "● Read (2s)" have no "…".
  if (/\u2026[^\n]*\((?:\d+m\s+)?\d+s/.test(text)) return true;
  // Thinking indicator — "thinking)" appears in progress line during extended thinking.
  if (/\bthinking\)/.test(text)) return true;
  return false;
}

function hasThreadActivityFallbackHint(threadType: ThreadType, text: string): boolean {
  if (threadType === "codex") return hasInterruptHint(text);
  if (threadType === "claude") return hasClaudeStarActivityHint(text);
  return false;
}

function terminalTailHasActivityHint(
  terminal: Terminal,
  threadType: ThreadType,
  lookbackLines: number,
): boolean {
  const buffer = terminal.buffer.active;
  const endY = buffer.baseY + buffer.cursorY;
  for (let i = 0; i < lookbackLines; i += 1) {
    const line = buffer.getLine(endY - i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (hasThreadActivityFallbackHint(threadType, text)) return true;
  }
  return false;
}

/** Scan the tail of the raw output queue for activity hints.
 *  Used for hidden terminals whose xterm buffer is stale (not being written to). */
const QUEUE_HINT_TAIL_BYTES = 4096;
function outputQueueTailHasActivityHint(
  queue: Uint8Array[],
  threadType: ThreadType,
): boolean {
  if (queue.length === 0) return false;
  // Decode the last few KB of queued output — enough to cover the spinner line.
  let remaining = QUEUE_HINT_TAIL_BYTES;
  let tail = "";
  for (let i = queue.length - 1; i >= 0 && remaining > 0; i--) {
    const chunk = queue[i];
    const slice = remaining >= chunk.length ? chunk : chunk.subarray(chunk.length - remaining);
    tail = new TextDecoder("utf-8", { fatal: false }).decode(slice) + tail;
    remaining -= slice.length;
  }
  return hasThreadActivityFallbackHint(threadType, tail);
}

function isTerminalAtBottom(terminal: Terminal): boolean {
  const buf = terminal.buffer.normal;
  return buf.baseY === 0 || buf.viewportY >= buf.baseY - BOTTOM_TOLERANCE_LINES;
}

function getTerminalDistanceFromBottom(terminal: Terminal): number {
  const buf = terminal.buffer.normal;
  return Math.max(0, buf.baseY - buf.viewportY);
}

function restoreTerminalViewportAfterFit(
  terminal: Terminal,
  wasAtBottom: boolean,
  distanceFromBottom: number,
): void {
  if (wasAtBottom) {
    terminal.scrollToBottom();
    return;
  }
  const buf = terminal.buffer.normal;
  const targetViewportY = Math.max(0, Math.min(buf.baseY, buf.baseY - distanceFromBottom));
  terminal.scrollToLine(targetViewportY);
}

function applyResolvedCoreStatus(
  current: ReturnType<typeof createInitialTranscriptInfo>,
  next: ReturnType<typeof createInitialTranscriptInfo>,
  _thread: Thread,
  _activeThreadId: string | null,
  _now: number,
): ReturnType<typeof createInitialTranscriptInfo> {
  const nextStatus = deriveCoreRuntimeStatus(
    current.status,
    next.ptyActive,
  );

  if (nextStatus === current.status) {
    return next;
  }

  const resolved = {
    ...next,
    status: nextStatus,
  };

  if (nextStatus === "working") {
    // PTY went active — clear any "done" badge from the previous turn.
    return {
      ...resolved,
      badge: null,
      badgeSince: null,
    };
  }

  // Idle-side badging is driven by the Heed state handler (working → idle turn
  // boundary sets "done"; activityState=awaiting_input maps to "needs_input" in
  // ThreadItem). Nothing to set here.
  return resolved;
}

function applyPtyActivityUpdate(
  thread: Thread,
  active: boolean,
  lifecycleSource: "output" | "marker",
  transitionReason: string,
): void {
  const state = useAppStore.getState();
  const now = Date.now();
  const current = state.transcriptInfo[thread.id] ?? createInitialTranscriptInfo();

  if (
    lifecycleSource === "output"
    && STRICT_MARKER_MODE
    && current.ptyLifecycleSource === "marker"
  ) {
    return;
  }

  // Skip no-op output transitions: if the PTY state isn't actually changing
  // and the signal is output-based (not markers), don't reset timestamps.
  // This prevents system-level noise (display wake, shell prompt repaints)
  // from repeatedly resetting the done-confirmation timer.
  if (lifecycleSource === "output" && active === current.ptyActive) {
    return;
  }

  const baseNext = {
    ...current,
    ptyActive: active,
    source: nextPtySource(current.source),
    lastEventTime: now,
    ptyLifecycleSource: lifecycleSource,
    ptyLastTransitionReason: transitionReason,
    ptyLastTransitionAt: now,
  };

  const next = applyResolvedCoreStatus(
    current,
    baseNext,
    thread,
    state.activeThreadId,
    now,
  );

  state.updateTranscriptInfo(thread.id, next);
}

// Tools whose `lastToolTarget` is an actual file path (so a touch can be
// attributed to an env). Other tools report a command / pattern / URL instead.
const FILE_WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit", "MultiEdit"]);

/**
 * Apply a Heed state-file snapshot to per-thread transcript info. Heed runs the
 * activity reducer in its daemon, so this is a thin mapper: copy the
 * pre-computed fields onto `transcriptInfo` (matched to a Codezilla thread by
 * Heed's `owner_thread_id` overlay) and let the existing `threadActivityState`
 * / `getThreadSubtitle` derivations render them. The only synthesized field is
 * the "done" badge on a working -> idle turn boundary, preserving the prior
 * post-Stop behaviour now that the question scan lives inside Heed.
 */
function applyHeedThreadState(payloads: HeedThreadPayload[]): void {
  const state = useAppStore.getState();
  // The Heed daemon forwards the full owned-thread list on every state.json
  // write (de-dup is list-level, not per-thread). Diff each thread here and
  // collect only the ones that actually changed, then commit them in a single
  // store mutation — otherwise one thread's churn rebuilds + re-renders every
  // thread, which is what made the activity indicator stutter under load.
  const changed: Record<string, ReturnType<typeof createInitialTranscriptInfo>> = {};
  for (const p of payloads) {
    const thread = state.threads.find((t) => t.id === p.ownerThreadId);
    if (!thread) continue;

    // Capture Codex's native session id the moment Heed correlates the thread.
    // Codex mints its own id (unlike Claude, whose id we supply at spawn), so it
    // has to be captured back here — `nativeThreadId` is that id. Persistence
    // already saves `codexThreadId`, so storing it now is what lets a later
    // `codex resume <id>` work. Gate on a real change to avoid redundant writes.
    if (
      p.cli === "codex"
      && isValidUUID(p.nativeThreadId)
      && thread.codexThreadId !== p.nativeThreadId
    ) {
      state.setCodexThreadId(thread.id, p.nativeThreadId);
    }

    const current =
      state.transcriptInfo[thread.id] ?? createInitialTranscriptInfo();
    // A thread Heed has declared gone is never "working" — its process is dead.
    // Heed can leave activity frozen at its last value (e.g. killed mid-turn), so
    // coerce gone -> idle here rather than trusting the stale field.
    const isGone = p.liveness === "gone";
    const activityState: ThreadActivityState = isGone
      ? "idle"
      : (p.activityState as ThreadActivityState);

    // Surface the "done" badge on a clean working -> idle transition, and reset
    // it when a new turn starts working again. The reset also clears
    // `badgeDismissedAt` — it's set when the user clicks the thread to dismiss a
    // badge and is never otherwise cleared, so without this a thread clicked
    // once would never badge again on later turns. awaiting_input needs no badge
    // here — ThreadItem maps that activityState to "needs_input".
    let badge = current.badge;
    let badgeSince = current.badgeSince;
    let badgeDismissedAt = current.badgeDismissedAt;
    if (
      activityState === "idle"
      && !isGone
      && current.activityState === "working"
      && current.badge !== "done"
      && current.badgeDismissedAt == null
    ) {
      badge = "done";
      badgeSince = Date.now();
    } else if (
      activityState === "working"
      && (current.badge === "done" || current.badgeDismissedAt != null)
    ) {
      badge = null;
      badgeSince = null;
      badgeDismissedAt = null;
    }

    const lastToolName = p.lastToolName ?? null;
    const lastToolTarget = p.lastToolTarget ?? null;

    // Uncommitted-work attribution: when a file-writing tool fires on an absolute
    // path, record the RAW path on this thread. Gate on the tool EVENT changing
    // (name OR target) — not target alone — so an Edit that follows a Read of the
    // same file (the Read already set lastToolTarget to that path) is still
    // recorded. Attribution to a worktree/main happens at display time using the
    // active project's worktrees, so it doesn't matter which project is active now.
    const toolEventChanged =
      lastToolName !== current.lastToolName || lastToolTarget !== current.lastToolTarget;
    if (
      toolEventChanged &&
      lastToolTarget != null &&
      lastToolTarget.startsWith("/") &&
      FILE_WRITE_TOOLS.has(lastToolName ?? "")
    ) {
      state.recordThreadTouch(thread.id, lastToolTarget, Date.now());
      // Live-follow: if the ACTIVE thread just edited, re-root the file panel to
      // that edit's env so the worktree selection tracks it without re-selecting
      // the thread. Only the active thread moves the selection — a background
      // thread's edit must not yank the panel away. The active thread is in the
      // active project, so state.worktrees is the right list to resolve against.
      if (thread.id === state.activeThreadId) {
        const projectPath = state.projects.find((pr) => pr.id === thread.projectId)?.path ?? null;
        const env = projectPath ? attributeEnv(lastToolTarget, state.worktrees, projectPath) : null;
        const nextEnv = env && env !== projectPath ? env : null;
        if (nextEnv !== state.selectedEnvPath) state.setSelectedEnvPath(nextEnv);
      }
    }

    const planProgress = p.planProgress ?? null;

    // Skip threads whose Heed-derived state is unchanged. `lastEventTime` is
    // deliberately excluded — a redundant emit must not, on its own, count as a
    // change (that would defeat the diff and re-render the thread anyway).
    const unchanged =
      current.hookAuthoritative === true
      && current.activityState === activityState
      && current.lastToolName === lastToolName
      && current.lastToolTarget === lastToolTarget
      && current.inPlanMode === p.inPlanMode
      && current.badge === badge
      && current.badgeSince === badgeSince
      && current.badgeDismissedAt === badgeDismissedAt
      && (current.planProgress?.total ?? null) === (planProgress?.total ?? null)
      && (current.planProgress?.done ?? null) === (planProgress?.done ?? null);
    if (unchanged) continue;

    changed[thread.id] = {
      ...current,
      hookAuthoritative: true,
      activityState,
      lastToolName,
      lastToolTarget,
      inPlanMode: p.inPlanMode,
      planProgress,
      lastEventTime: Date.now(),
      badge,
      badgeSince,
      badgeDismissedAt,
    };
  }
  state.updateTranscriptInfoBatch(changed);
}

function applyPtyCommandStart(thread: Thread): void {
  const state = useAppStore.getState();
  const now = Date.now();
  const current = state.transcriptInfo[thread.id] ?? createInitialTranscriptInfo();

  const baseNext = {
    ...current,
    ptyActive: true,
    source: nextPtySource(current.source),
    lastEventTime: now,
    ptyLifecycleSource: "marker" as const,
    ptyLastTransitionReason: "command_start",
    ptyLastTransitionAt: now,
  };

  const next = applyResolvedCoreStatus(
    current,
    baseNext,
    thread,
    state.activeThreadId,
    now,
  );

  state.updateTranscriptInfo(thread.id, next);
}

function applyPtyCommandEnd(thread: Thread, exitCode: number | null): void {
  const state = useAppStore.getState();
  const now = Date.now();
  const current = state.transcriptInfo[thread.id] ?? createInitialTranscriptInfo();

  const baseNext = {
    ...current,
    ptyActive: false,
    source: nextPtySource(current.source),
    lastEventTime: now,
    ptyLifecycleSource: "marker" as const,
    ptyLastTransitionReason: `command_end:${exitCode ?? "unknown"}`,
    ptyLastTransitionAt: now,
  };

  const next = applyResolvedCoreStatus(
    current,
    baseNext,
    thread,
    state.activeThreadId,
    now,
  );

  state.updateTranscriptInfo(thread.id, next);
}

export default function TerminalMultiplexer() {
  const threads = useAppStore((s) => s.threads);
  const activeThreadId = useAppStore((s) => s.activeThreadId);
  const activeJobId = useAppStore((s) => s.activeJobId);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const projects = useAppStore((s) => s.projects);
  const addThread = useAppStore((s) => s.addThread);
  const removeProject = useAppStore((s) => s.removeProject);
  const setProjectIcon = useAppStore((s) => s.setProjectIcon);
  const skillsManagerOpen = useAppStore((s) => s.skillsManagerOpen);
  const presetsManagerOpen = useAppStore((s) => s.presetsManagerOpen);
  const betaFeatures = useAppStore((s) => s.betaFeatures);
  const betaFeaturesOpen = useAppStore((s) => s.betaFeaturesOpen);
  const getProjectJobs = useAppStore((s) => s.getProjectJobs);
  const setActiveJob = useAppStore((s) => s.setActiveJob);
  const markThreadExited = useAppStore((s) => s.markThreadExited);
  const resumeThread = useAppStore((s) => s.resumeThread);
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const instancesRef = useRef<Map<string, TerminalInstance>>(new Map());
  const resizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastDimsRef = useRef<Map<string, { rows: number; cols: number }>>(new Map());

  const [showScrollButton, setShowScrollButton] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const [loadingSession, setLoadingSession] = useState<string | null>(null);
  const [iconPickerPos, setIconPickerPos] = useState<{ x: number; y: number } | null>(null);
  const [showJobForm, setShowJobForm] = useState(false);
  const scrollCallbackRef = useRef<((atBottom: boolean) => void) | null>(null);
  scrollCallbackRef.current = (atBottom: boolean) => setShowScrollButton(!atBottom);
  const selectionCallbackRef = useRef<((hasSel: boolean) => void) | null>(null);
  selectionCallbackRef.current = (hasSel: boolean) => setHasSelection(hasSel);
  const onFirstOutputRef = useRef<((sessionId: string) => void) | null>(null);
  onFirstOutputRef.current = (sessionId: string) => {
    setLoadingSession((cur) => (cur === sessionId ? null : cur));
  };
  const activeThread = threads.find((t) => t.id === activeThreadId);
  const prevSessionRef = useRef<string | null>(null);

  // Auto-resume dormant or exited threads when clicked
  useEffect(() => {
    if (activeThread && (activeThread.state === "dormant" || activeThread.state === "exited")) {
      // Show loading immediately for dormant threads (no sessionId yet)
      setLoadingSession("pending");
      resumeThread(activeThread.id);
    }
  }, [activeThread, resumeThread]);

  // Subscribe to Heed's per-thread activity state. Heed's daemon runs the
  // reducer and writes ~/.heed/state.json; the Rust heed_client watcher filters
  // to Codezilla-owned threads and forwards each change here as a batch. Map
  // every record onto transcriptInfo by Codezilla thread id (owner_thread_id).
  useEffect(() => {
    let cancelled = false;
    const unlistenPromise = listen<HeedThreadPayload[]>(
      "heed-thread-state",
      (event) => {
        if (cancelled) return;
        applyHeedThreadState(event.payload);
      },
    );
    return () => {
      cancelled = true;
      unlistenPromise.then((fn) => fn()).catch(() => { /* ignore */ });
    };
  }, []);

  const handleResize = useCallback(() => {
    if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
    resizeTimeoutRef.current = setTimeout(() => {
      const state = useAppStore.getState();
      if (!state.activeThreadId) return;
      const active = state.threads.find(
        (t) => t.id === state.activeThreadId,
      );
      if (!active?.sessionId) return;
      const instance = instancesRef.current.get(active.sessionId);
      if (instance) {
        suppressOutputActivity(active.id, RESIZE_ACTIVITY_SUPPRESS_MS);
        const wasAtBottom = isTerminalAtBottom(instance.terminal);
        const distanceFromBottom = getTerminalDistanceFromBottom(instance.terminal);
        instance.fitAddon.fit();
        restoreTerminalViewportAfterFit(instance.terminal, wasAtBottom, distanceFromBottom);
        const rows = instance.terminal.rows;
        const cols = instance.terminal.cols;
        const last = lastDimsRef.current.get(active.sessionId);
        if (!last || last.rows !== rows || last.cols !== cols) {
          lastDimsRef.current.set(active.sessionId, { rows, cols });
          resizePty(active.sessionId, rows, cols).catch(console.error);
        }
      }
    }, RESIZE_DEBOUNCE_MS);
  }, []);

  // Observe wrapper for resize
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const observer = new ResizeObserver(() => handleResize());
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [handleResize]);

  // Create/destroy terminal instances as threads come and go
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const instances = instancesRef.current;
    const currentSessionIds = new Set(
      threads.map((t) => t.sessionId).filter((s): s is string => s !== null),
    );

    // Remove instances for deleted threads
    for (const [sessionId, instance] of instances) {
      if (!currentSessionIds.has(sessionId)) {
        killPty(sessionId).catch(console.error);
        const addon = webglAddons.get(sessionId);
        if (addon) {
          addon.dispose();
          webglAddons.delete(sessionId);
        }
        instance.terminal.dispose();
        if (instance.container.parentNode === wrapper) {
          wrapper.removeChild(instance.container);
        }
        instances.delete(sessionId);
        lastDimsRef.current.delete(sessionId);
        sessionsWithOutput.delete(sessionId);
        contextLossTimes.delete(sessionId);
      }
    }

    // Create instances for new threads (skip dormant — no sessionId)
    for (const thread of threads) {
      if (thread.sessionId && !instances.has(thread.sessionId)) {
        createTerminalInstance(wrapper, thread, instances, markThreadExited, (atBottom) => {
          scrollCallbackRef.current?.(atBottom);
        }, (hasSel) => {
          selectionCallbackRef.current?.(hasSel);
        }, (sid) => {
          onFirstOutputRef.current?.(sid);
        });
      }
    }
  }, [threads, markThreadExited]);

  // Show/hide based on active thread.
  // Only fit/scroll/resize when the active session actually changes (not on
  // every threads array mutation, which caused repeated resize storms).
  const activeSessionId = activeThread?.sessionId ?? null;
  useEffect(() => {
    const instances = instancesRef.current;
    const sessionChanged = activeSessionId !== prevSessionRef.current;
    prevSessionRef.current = activeSessionId;

    // Show loading indicator for sessions that haven't received output yet
    if (activeSessionId && !sessionsWithOutput.has(activeSessionId)) {
      setLoadingSession(activeSessionId);
    } else {
      setLoadingSession(null);
    }

    for (const [sessionId, instance] of instances) {
      if (sessionId === activeSessionId) {
        instance.container.style.visibility = "visible";
        instance.container.style.pointerEvents = "auto";
        instance.container.style.zIndex = "2";
        instance.visible = true;
        // Attach WebGL on first visibility (deferred from creation to avoid
        // expensive GPU context init for background terminals on launch).
        ensureWebgl(sessionId, instance.terminal);
        // Drain any output that accumulated while hidden
        instance.flushPendingOutput();
        if (sessionChanged) {
          if (activeThread) {
            suppressOutputActivity(activeThread.id, RESIZE_ACTIVITY_SUPPRESS_MS);
          }
          // Defer fit/scroll until after the browser has reflowed the newly-visible container.
          const capturedSessionId = sessionId;
          const capturedInstance = instance;
          requestAnimationFrame(() => {
            const latest = useAppStore.getState();
            const latestActiveSessionId = latest.activeThreadId
              ? latest.threads.find((t) => t.id === latest.activeThreadId)?.sessionId ?? null
              : null;
            if (latestActiveSessionId !== capturedSessionId) {
              return;
            }
            capturedInstance.fitAddon.fit();
            capturedInstance.userScrolledUp = false;
            capturedInstance.terminal.scrollToBottom();
            setShowScrollButton(false);
            const rows = capturedInstance.terminal.rows;
            const cols = capturedInstance.terminal.cols;
            const last = lastDimsRef.current.get(capturedSessionId);
            if (!last || last.rows !== rows || last.cols !== cols) {
              lastDimsRef.current.set(capturedSessionId, { rows, cols });
              resizePty(capturedSessionId, rows, cols).catch(console.error);
            }
            capturedInstance.terminal.focus();
          });
        }
      } else {
        instance.visible = false;
        instance.container.style.visibility = "hidden";
        instance.container.style.pointerEvents = "none";
        instance.container.style.zIndex = "1";
      }
    }
  }, [activeSessionId]);

  // React to font size changes — update terminal font and re-fit.
  const baseFontSize = useAppStore((s) => s.baseFontSize);
  useEffect(() => {
    for (const [sessionId, instance] of instancesRef.current) {
      const thread = useAppStore.getState().threads.find((t) => t.sessionId === sessionId);
      if (thread) {
        suppressOutputActivity(thread.id, RESIZE_ACTIVITY_SUPPRESS_MS);
      }
      const wasAtBottom = isTerminalAtBottom(instance.terminal);
      const distanceFromBottom = getTerminalDistanceFromBottom(instance.terminal);

      instance.terminal.options.fontSize = baseFontSize;
      instance.fitAddon.fit();

      restoreTerminalViewportAfterFit(instance.terminal, wasAtBottom, distanceFromBottom);

      const rows = instance.terminal.rows;
      const cols = instance.terminal.cols;
      const last = lastDimsRef.current.get(sessionId);
      if (!last || last.rows !== rows || last.cols !== cols) {
        lastDimsRef.current.set(sessionId, { rows, cols });
        resizePty(sessionId, rows, cols).catch(console.error);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseFontSize]);

  // React to theme changes — update terminal theme live.
  const accentColorId = useAppStore((s) => s.accentColorId);
  const appearanceMode = useAppStore((s) => s.appearanceMode);
  useEffect(() => {
    const resolveIsDark = () => {
      if (appearanceMode === "dark") return true;
      if (appearanceMode === "light") return false;
      return window.matchMedia("(prefers-color-scheme: dark)").matches;
    };
    const isDark = resolveIsDark();
    const palette = isDark ? DARK_PALETTE : LIGHT_PALETTE;
    const theme = getTerminalTheme(palette, isDark);
    for (const [, instance] of instancesRef.current) {
      instance.terminal.options.theme = theme;
    }
  }, [accentColorId, appearanceMode]);

  // Cleanup all on unmount
  useEffect(() => {
    return () => {
      for (const [sessionId, instance] of instancesRef.current) {
        killPty(sessionId).catch(console.error);
        const addon = webglAddons.get(sessionId);
        if (addon) {
          addon.dispose();
          webglAddons.delete(sessionId);
        }
        instance.terminal.dispose();
        contextLossTimes.delete(sessionId);
      }
      instancesRef.current.clear();
    };
  }, []);

  return (
    <div
      ref={wrapperRef}
      style={{ width: "100%", height: "100%", position: "relative" }}
    >
      {loadingSession && activeThreadId && (
        <LoadingOverlay threadType={activeThread?.type ?? "shell"} />
      )}
      {hasSelection && activeThreadId && (
        <CopyProseButton onClick={() => {
          const active = threads.find((t) => t.id === activeThreadId);
          if (active?.sessionId) {
            const instance = instancesRef.current.get(active.sessionId);
            if (instance) {
              const sel = instance.terminal.getSelection();
              if (sel) {
                const cleaned = collapseProseWraps(sel);
                navigator.clipboard.writeText(cleaned);
              }
            }
          }
        }} />
      )}
      {showScrollButton && activeThreadId && (
        <ScrollToBottomButton onClick={() => {
          const active = threads.find((t) => t.id === activeThreadId);
          if (active?.sessionId) {
            const instance = instancesRef.current.get(active.sessionId);
            if (instance) {
              instance.userScrolledUp = false;
              instance.terminal.scrollToBottom();
              instance.terminal.focus();
              setShowScrollButton(false);
            }
          }
        }} />
      )}
      {betaFeatures.scheduledJobs && activeJobId && (
        <JobDetailPanel jobId={activeJobId} />
      )}
      {!activeThreadId && !activeJobId && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100%",
            gap: "12px",
          }}
        >
          {activeProject && (
            <>
              <ProjectIcon
                project={activeProject}
                size={baseFontSize + 22}
                onClick={(e) => {
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setIconPickerPos({ x: rect.left, y: rect.bottom + 4 });
                }}
              />
              <div style={{ color: "var(--text-primary)", fontSize: "calc(var(--font-size) + 10px)", fontWeight: 600, marginBottom: "2px" }}>
                {activeProject.name}
              </div>
            </>
          )}
          <div style={{ color: "var(--text-secondary)", fontSize: "var(--font-size)", marginBottom: "4px" }}>
            {activeProjectId ? "Start a session" : "Select a project to begin"}
          </div>
          {activeProjectId && (
            <div style={{ display: "flex", gap: "8px" }}>
              {THREAD_TYPES.filter((type) => type !== "codex" || betaFeatures.codexThreads).map((type) => (
                <EmptyStateButton
                  key={type}
                  type={type}
                  label={THREAD_NEW_LABELS[type]}
                  onClick={() => addThread(activeProjectId, type)}
                />
              ))}
            </div>
          )}
          {betaFeatures.scheduledJobs && activeProjectId && <ScheduledJobsSummary projectId={activeProjectId} getProjectJobs={getProjectJobs} setActiveJob={setActiveJob} onNewJob={() => setShowJobForm(true)} />}
          {betaFeatures.skillsPlugins && activeProjectId && <SkillsPluginsSummary />}
          {activeProjectId && (
            <RemoveProjectButton onClick={() => removeProject(activeProjectId)} />
          )}
        </div>
      )}
      {/* Icon picker for project home */}
      {activeProject && iconPickerPos && createPortal(
        <IconPicker
          anchor={iconPickerPos}
          currentIcon={activeProject.icon}
          onSelect={(icon) => {
            setProjectIcon(activeProject.id, icon);
          }}
          onRemove={() => {
            setProjectIcon(activeProject.id, undefined);
          }}
          onClose={() => setIconPickerPos(null)}
        />,
        document.body,
      )}
      {/* Scheduled job creation form */}
      {betaFeatures.scheduledJobs && activeProjectId && showJobForm && createPortal(
        <JobCreationForm
          projectId={activeProjectId}
          onClose={() => setShowJobForm(false)}
        />,
        document.body,
      )}
      {/* Skills & Plugins Manager overlay */}
      {betaFeatures.skillsPlugins && skillsManagerOpen && createPortal(
        <SkillsPluginsManager />,
        document.body,
      )}
      {/* Launch Presets Manager overlay */}
      {presetsManagerOpen && createPortal(
        <PresetsManager />,
        document.body,
      )}
      {/* Beta Features Manager overlay */}
      {betaFeaturesOpen && createPortal(
        <BetaFeaturesManager />,
        document.body,
      )}
    </div>
  );
}

function LoadingOverlay({ threadType }: { threadType: ThreadType }) {
  const label = threadType === "claude" ? "Claude" : threadType === "codex" ? "Codex" : "Terminal";
  const [dots, setDots] = useState("");
  useEffect(() => {
    const id = setInterval(() => setDots((d) => (d.length >= 3 ? "" : d + ".")), 400);
    return () => clearInterval(id);
  }, []);
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 15,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg-primary)",
      }}
    >
      <span style={{ color: "var(--text-secondary)", fontSize: "var(--font-size)", fontFamily: "var(--font-family)" }}>
        Starting {label}<span style={{ display: "inline-block", width: "1.5em", textAlign: "left" }}>{dots}</span>
      </span>
    </div>
  );
}

function ScheduledJobsSummary({
  projectId,
  getProjectJobs,
  setActiveJob,
  onNewJob,
}: {
  projectId: string;
  getProjectJobs: (projectId: string) => ScheduledJob[];
  setActiveJob: (jobId: string) => void;
  onNewJob: () => void;
}) {
  const jobs = getProjectJobs(projectId);
  const [hoverManage, setHoverManage] = useState(false);

  return (
    <div style={{ marginTop: "16px", textAlign: "center" }}>
      <div style={{
        fontSize: "var(--font-size-sm)",
        fontWeight: 600,
        textTransform: "uppercase",
        color: "var(--text-secondary)",
        letterSpacing: "0.5px",
        marginBottom: "6px",
      }}>
        Scheduled Jobs
      </div>
      {jobs.length > 0 ? (
        <div style={{ fontSize: "var(--font-size-sm)", color: "var(--text-secondary)", lineHeight: 1.6 }}>
          {jobs.slice(0, 5).map((job, i) => (
            <span key={job.id}>
              <span
                style={{ color: "var(--text-primary)", cursor: "pointer" }}
                onClick={() => setActiveJob(job.id)}
              >
                {job.name}
              </span>
              {i < Math.min(jobs.length, 5) - 1 && " \u00B7 "}
            </span>
          ))}
          {jobs.length > 5 && (
            <span style={{ color: "var(--text-secondary)" }}> + {jobs.length - 5} more</span>
          )}
        </div>
      ) : (
        <div style={{ fontSize: "var(--font-size-sm)", color: "var(--text-secondary)" }}>
          No scheduled jobs
        </div>
      )}
      <button
        onClick={onNewJob}
        onMouseEnter={() => setHoverManage(true)}
        onMouseLeave={() => setHoverManage(false)}
        style={{
          marginTop: "8px",
          background: hoverManage ? "var(--accent-selection)" : "transparent",
          border: "1px solid var(--border-medium)",
          color: "var(--text-secondary)",
          fontSize: "var(--font-size-sm)",
          padding: "4px 14px",
          borderRadius: "4px",
          cursor: "pointer",
        }}
      >
        New Job
      </button>
    </div>
  );
}

function EmptyStateButton({ type, label, onClick }: { type: ThreadType; label: string; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        background: hovered ? "var(--accent-selection)" : "transparent",
        border: "1px solid var(--accent)",
        color: "var(--text-primary)",
        fontSize: "var(--font-size-sm)",
        cursor: "pointer",
        padding: "6px 16px",
        borderRadius: "4px",
      }}
    >
      <ThreadIcon type={type} />
      {label}
    </button>
  );
}

function RemoveProjectButton({ onClick }: { onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: "absolute",
        bottom: "24px",
        right: "24px",
        background: hovered ? "rgba(255,80,80,0.15)" : "none",
        border: "1px solid var(--border-medium)",
        borderColor: hovered ? "#f44" : "var(--border-medium)",
        color: hovered ? "#f44" : "var(--text-secondary)",
        fontSize: "var(--font-size-sm)",
        padding: "4px 12px",
        borderRadius: "4px",
        cursor: "pointer",
        transition: "color 0.15s, border-color 0.15s, background 0.15s",
      }}
    >
      Remove Project
    </button>
  );
}

function ScrollToBottomButton({ onClick }: { onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: "absolute",
        bottom: "16px",
        right: "24px",
        zIndex: 20,
        background: hovered ? "var(--accent-selection)" : "var(--bg-elevated)",
        border: "1px solid var(--border-medium)",
        color: "var(--text-primary)",
        fontSize: "var(--font-size-sm)",
        cursor: "pointer",
        padding: "4px 12px",
        borderRadius: "12px",
        opacity: 0.9,
        transition: "background 0.15s, border-color 0.15s",
        borderColor: hovered ? "var(--accent)" : "var(--border-medium)",
      }}
    >
      ↓ Latest
    </button>
  );
}

// collapseProseWraps lives in src/lib/proseCopy.ts (pure + unit-tested, see
// tests/prose-copy.test.ts) and is imported at the top of this file.

function CopyProseButton({ onClick }: { onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        onClick();
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: "absolute",
        top: "8px",
        right: "24px",
        zIndex: 20,
        background: copied
          ? "var(--accent)"
          : hovered ? "var(--accent)" : "var(--accent-selection)",
        border: "1px solid var(--accent)",
        color: copied || hovered ? "var(--accent-text)" : "var(--text-primary)",
        fontSize: "var(--font-size-sm)",
        fontWeight: 600,
        cursor: "pointer",
        padding: "4px 12px",
        borderRadius: "12px",
        transition: "background 0.15s, border-color 0.15s, color 0.15s",
      }}
    >
      {copied ? "Copied!" : "Copy as prose"}
    </button>
  );
}

function createTerminalInstance(
  wrapper: HTMLDivElement,
  thread: Thread,
  instances: Map<string, TerminalInstance>,
  markThreadExited: (threadId: string, exitCode: number | null) => void,
  onScrollStateChange: ((atBottom: boolean) => void) | null,
  onSelectionChange: ((hasSelection: boolean) => void) | null,
  onFirstOutput: ((sessionId: string) => void) | null,
) {
  if (!thread.sessionId) return;
  const sessionId = thread.sessionId;

  const container = document.createElement("div");
  container.style.cssText =
    "position:absolute;top:0;right:0;bottom:0;left:6px;visibility:hidden;pointer-events:none;z-index:1;";
  wrapper.appendChild(container);

  const storeState = useAppStore.getState();
  const resolveIsDark = () => {
    if (storeState.appearanceMode === "dark") return true;
    if (storeState.appearanceMode === "light") return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  };
  const isDark = resolveIsDark();
  const palette = isDark ? DARK_PALETTE : LIGHT_PALETTE;
  const dynamicTheme = getTerminalTheme(palette, isDark);

  const openTerminalLink = (event: MouseEvent, uri: string) => {
    openExternalUrl(uri, event);
  };

  const terminal = new Terminal({
    ...TERMINAL_CONFIG,
    fontSize: storeState.baseFontSize,
    theme: dynamicTheme,
    linkHandler: {
      activate: openTerminalLink,
    },
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon(openTerminalLink));
  terminal.open(container);

  // Let key combos with 3+ modifiers pass through to macOS so global
  // shortcuts (e.g. Ctrl+Option+Cmd+Space) aren't swallowed by xterm.
  terminal.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
    const modCount =
      (ev.ctrlKey ? 1 : 0) +
      (ev.altKey ? 1 : 0) +
      (ev.metaKey ? 1 : 0) +
      (ev.shiftKey ? 1 : 0);
    if (modCount >= 3) return false;
    return true;
  });

  // WebGL addon is deferred until the terminal is first made visible
  // to avoid expensive GPU context creation for background terminals on launch.

  // Fit happens in the active-thread show/hide effect after this container
  // is marked visible and the browser has had a frame to settle layout.
  const instance: TerminalInstance = {
    terminal, fitAddon, container, isAtBottom: true, userScrolledUp: false,
    visible: false, flushPendingOutput: () => {}, hasSelection: false,
  };
  instances.set(thread.sessionId, instance);

  // Track selection state for "Copy as prose" button
  terminal.onSelectionChange(() => {
    const hasSel = terminal.hasSelection();
    instance.hasSelection = hasSel;
    const activeId = useAppStore.getState().activeThreadId;
    if (activeId === thread.id && onSelectionChange) {
      onSelectionChange(hasSel);
    }
  });

  // Track scroll position to show/hide "scroll to bottom" button.
  // Check on both scroll events and after new output is written, so the
  // button appears reliably when the user is scrolled up.
  const checkScrollState = () => {
    const atBottom = isTerminalAtBottom(terminal);
    instance.isAtBottom = atBottom;
    // Clear the user-scrolled-up flag once they've returned to the bottom
    if (atBottom) instance.userScrolledUp = false;
    const activeId = useAppStore.getState().activeThreadId;
    if (activeId === thread.id && onScrollStateChange) {
      onScrollStateChange(atBottom);
    }
  };
  terminal.onScroll(() => {
    checkScrollState();
  });

  // Detect intentional user scroll-up via wheel events.  When the user
  // scrolls up we set a sticky flag that prevents auto-scroll in
  // flushOutput, so they can read previous output while new content
  // streams in.  The flag is cleared when they scroll back to the bottom
  // (handled in checkScrollState above) or click the "↓ Latest" button.
  container.addEventListener("wheel", (e: WheelEvent) => {
    if (e.deltaY < 0) {
      instance.userScrolledUp = true;
    }
  }, { passive: true });

  // Register file path link provider for Cmd+click navigation
  const project = useAppStore
    .getState()
    .projects.find((p) => p.id === thread.projectId);
  const cwd = project?.path;
  if (cwd) {
    const linkProvider = createFilePathLinkProviderForTerminal(
      terminal,
      cwd,
      {
        onSelect: (path) => {
          useAppStore.getState().selectFileInTree(path);
        },
        onPreview: (path, line) => {
          const store = useAppStore.getState();
          store.selectFileInTree(path);
          store.openPreview(path, line);
        },
        onMultipleMatches: (candidates, position, line, col) => {
          useAppStore.getState().showFilePicker(candidates, position, line, col);
        },
        onShowMenu: (path, position, line, col) => {
          useAppStore.getState().showFileLinkMenu(path, position, line, col);
        },
      },
    );
    terminal.registerLinkProvider(linkProvider);
  }

  // Register commit hash link provider (plain click opens commit preview)
  {
    const commitLinkProvider = createCommitHashLinkProviderForTerminal(
      terminal,
      {
        onPreviewCommit: (hash) => {
          useAppStore.getState().openCommitPreview(hash);
        },
      },
    );
    terminal.registerLinkProvider(commitLinkProvider);
  }

  // --- Output buffering strategy ---
  // Visible terminal: output is written to xterm.js via requestAnimationFrame,
  //   capped at MAX_WRITE_PER_FRAME per frame to avoid blocking the main thread
  //   during output bursts (e.g. Claude resume replaying conversation history).
  // Hidden terminal: output accumulates in the queue but is NOT written to
  //   xterm.js (no parsing, no WebGL rendering, no CPU cost). The queue is
  //   flushed when the terminal becomes visible via instance.flushPendingOutput().
  //   The queue evicts oldest chunks to stay under cap, so the latest output is
  //   always preserved.
  // Activity tracking (badges, status, touchThread) runs regardless of
  //   visibility. The activity-hint fallback (star spinner detection) uses
  //   outputQueueTailHasActivityHint() to scan raw queue bytes when the xterm
  //   buffer is stale.
  const outputQueue: Uint8Array[] = [];
  let outputQueueBytes = 0;
  const MAX_OUTPUT_QUEUE_BYTES = 8 * 1024 * 1024; // 8MB cap
  const MAX_WRITE_PER_FRAME = 256 * 1024; // 256KB — avoid blocking UI with huge terminal.write() calls
  let flushScheduled = false;
  let evictedSinceFlush = false;
  let markerEventsObserved = false;
  let waitingForCommandStart = false;
  let progressActive = false;
  let lastProgressEventAt = 0;
  let lastOutputAt = 0;
  let lastCtrlCAt = 0;
  let inputEchoSuppressUntil = 0;
  let hasReceivedOutput = false;

  const flushOutput = () => {
    if (flushScheduled) return;
    flushScheduled = true;

    requestAnimationFrame(() => {
      flushScheduled = false;
      if (outputQueue.length === 0) return;
      // Skip write for hidden terminals — data stays buffered in the queue
      // and will be flushed when the terminal becomes visible.
      if (!instance.visible) return;

      // Merge pending chunks up to MAX_WRITE_PER_FRAME.
      // Capping the write size keeps the main thread responsive during
      // bursts (e.g. Claude resume replaying conversation history).
      // Remaining data is drained on subsequent frames.
      let writeBytes = 0;
      let writeChunks = 0;
      for (const chunk of outputQueue) {
        if (writeBytes + chunk.length > MAX_WRITE_PER_FRAME && writeChunks > 0) break;
        writeBytes += chunk.length;
        writeChunks++;
      }

      const chunks = outputQueue.splice(0, writeChunks);
      outputQueueBytes -= writeBytes;

      // If eviction dropped oldest chunks, the remaining data may start
      // mid-escape-sequence. Prepend an SGR reset so xterm's parser
      // doesn't inherit corrupted state (wrong colors/attributes).
      const needsReset = evictedSinceFlush;
      if (needsReset) evictedSinceFlush = false;
      const SGR_RESET = [0x1b, 0x5b, 0x30, 0x6d]; // \x1b[0m

      let merged: Uint8Array;
      if (chunks.length === 1 && !needsReset) {
        merged = chunks[0];
      } else {
        merged = new Uint8Array(writeBytes + (needsReset ? SGR_RESET.length : 0));
        let off = 0;
        if (needsReset) {
          merged.set(SGR_RESET, 0);
          off = SGR_RESET.length;
        }
        for (const chunk of chunks) {
          merged.set(chunk, off);
          off += chunk.length;
        }
      }

      const shouldAutoScroll = instance.isAtBottom && !instance.userScrolledUp;
      try {
        terminal.write(merged, () => {
          if (shouldAutoScroll) terminal.scrollToBottom();
          checkScrollState();
          // If more data remains (capped write or new arrivals), schedule next frame
          if (outputQueue.length > 0) flushOutput();
        });
      } catch (err) {
        console.error(`[terminal] failed flushing PTY output for ${thread.id}:`, err);
        outputQueue.length = 0;
        outputQueueBytes = 0;
      }
    });
  };

  // Expose flush for visibility transitions
  instance.flushPendingOutput = () => {
    if (outputQueue.length === 0) return;
    flushScheduled = false;
    flushOutput();
  };

  // PTY channel
  const channel = new Channel<PtyEvent>();
  channel.onmessage = (event: PtyEvent) => {
    const currentThread = useAppStore.getState().threads.find((t) => t.id === thread.id);
    // Ignore stale events from an older PTY session after resume/switch.
    if (!currentThread || currentThread.sessionId !== sessionId) {
      return;
    }

    if (event.event === "Output") {
      const { data } = event.data as PtyOutputData;
      const outputChunk = new Uint8Array(data);
      if (!hasReceivedOutput) {
        hasReceivedOutput = true;
        sessionsWithOutput.add(sessionId);
        onFirstOutput?.(sessionId);
      }
      // Always keep the latest output: evict oldest chunks when over cap
      // (old behaviour dropped new data, losing the latest output for hidden terminals)
      outputQueue.push(outputChunk);
      outputQueueBytes += outputChunk.length;
      while (outputQueueBytes > MAX_OUTPUT_QUEUE_BYTES && outputQueue.length > 1) {
        outputQueueBytes -= outputQueue.shift()!.length;
        evictedSinceFlush = true;
      }
      // Only drive the RAF flush loop for the visible terminal.
      // Hidden terminals accumulate in the queue and drain on switch.
      if (instance.visible) {
        flushOutput();
      }
      recordOutput(thread.id);
      lastOutputAt = Date.now();
      // Only count unsuppressed PTY output as real activity.
      // Suppressed output is often UI-induced redraw noise (resize/input echo).
      // Also skip touching idle/done threads — their PTYs still emit housekeeping
      // output (prompt redraws, cursor blinks, health checks) which would reset
      // lastActivityAt and make idle threads look freshly active.
      if (!isOutputActivitySuppressed(thread.id)) {
        const now = Date.now();
        const lastTouch = touchTimestamps.get(thread.id) ?? 0;
        if (now - lastTouch >= TOUCH_DEBOUNCE_MS) {
          // For Claude/Codex threads, suppress touch if PTY is quiet — the
          // output we just saw is likely housekeeping (prompt redraws, cursor
          // blinks) rather than real activity. Shell threads always touch.
          const info = useAppStore.getState().transcriptInfo[thread.id];
          const threadIdle = info != null
            && thread.type !== "shell"
            && !info.ptyActive;
          if (!threadIdle) {
            touchTimestamps.set(thread.id, now);
            useAppStore.getState().touchThread(thread.id);
          }
        }
      }
    } else if (event.event === "Activity") {
      const { active, source } = event.data as PtyActivityData;
      const fromProgress = source === "progress";
      const now = Date.now();
      // Check for activity hints (star spinner, "esc to interrupt", etc.).
      // For hidden terminals the xterm buffer is stale (output is queued but
      // not written), so we scan the raw output queue tail instead.
      const interruptFallbackActive = thread.type !== "shell"
        && now - lastOutputAt <= INTERRUPT_HINT_ACTIVE_MS
        && (instance.visible
          ? terminalTailHasActivityHint(terminal, thread.type, INTERRUPT_HINT_LOOKBACK_LINES)
          : outputQueueTailHasActivityHint(outputQueue, thread.type));
      const outputSuppressed = now <= inputEchoSuppressUntil
        || isOutputActivitySuppressed(thread.id);

      // Heed is the authoritative quiet signal — once it owns this thread and
      // its activity has settled to idle/awaiting_input, the spinner-hint
      // heuristic should not keep the thread "active". Threads Heed doesn't
      // track yet have no such signal, so the interrupt-fallback still applies.
      const hookConfirmedDone = !active
        && thread.type !== "shell"
        && (() => {
          const info = useAppStore.getState().transcriptInfo[thread.id];
          return info?.hookAuthoritative === true
            && info.activityState !== "working";
        })();
      const userCancelled = now - lastCtrlCAt < 5_000;
      const effectiveInterruptFallback = interruptFallbackActive && !hookConfirmedDone && !userCancelled;

      if (fromProgress) {
        progressActive = active;
        lastProgressEventAt = now;
      }

      // When the star animation or activity hint is still visible, don't let
      // a brief progress-idle marker flip the status to idle. The CLI is
      // visually active (spinner/status line) even if progress markers gap.
      if (fromProgress && !active && thread.type !== "shell" && effectiveInterruptFallback) {
        return;
      }

      // Once command start/end markers are observed, only process progress-sourced
      // activity events. Exception: for Claude/Codex, allow output-active as a
      // recovery path when progress markers briefly desync from visible output.
      if (markerEventsObserved && !fromProgress) {
        if (
          !active
          && thread.type !== "shell"
          && effectiveInterruptFallback
        ) {
          return;
        }
        if (
          active
          && thread.type !== "shell"
          && !outputSuppressed
          && !waitingForCommandStart
        ) {
          applyPtyActivityUpdate(thread, true, "output", "output_activity_marker_fallback");
          return;
        }
        if (
          !active
          && thread.type !== "shell"
          && progressActive
          && now - lastProgressEventAt > PROGRESS_IDLE_RECOVERY_MS
        ) {
          // Progress markers can occasionally get stuck active; let output-idle
          // recover runtime status in that case.
          progressActive = false;
          applyPtyActivityUpdate(thread, false, "output", "output_idle_progress_stale_recovery");
        }
        return;
      }

      // Progress markers are authoritative: if the CLI says it's active
      // (spinner visible), ignore the output watchdog's idle timeout.
      // If the progress marker stream goes stale, recover via output-idle.
      if (!fromProgress && !active && progressActive) {
        if (now - lastProgressEventAt <= PROGRESS_IDLE_RECOVERY_MS) {
          return;
        }
        progressActive = false;
      }
      if (!fromProgress && !active && thread.type !== "shell" && effectiveInterruptFallback) {
        return;
      }

      if (!fromProgress && outputSuppressed) {
        return;
      }

      applyPtyActivityUpdate(
        thread,
        active,
        fromProgress ? "marker" : "output",
        fromProgress
          ? (active ? "progress_activity" : "progress_idle")
          : (active ? "output_activity" : "output_idle"),
      );
    } else if (event.event === "CommandStart") {
      markerEventsObserved = true;
      waitingForCommandStart = false;
      applyPtyCommandStart(thread);
    } else if (event.event === "CommandEnd") {
      markerEventsObserved = true;
      waitingForCommandStart = true;
      const { exit_code } = event.data as PtyCommandEndData;
      applyPtyCommandEnd(thread, exit_code);
    } else if (event.event === "Exit") {
      const { code } = event.data as PtyExitData;
      if (markerEventsObserved) {
        applyPtyCommandEnd(thread, code ?? null);
      } else {
        applyPtyActivityUpdate(thread, false, "output", "output_idle");
      }
      clearActivity(thread.id);
      touchTimestamps.delete(thread.id);
      try {
        terminal.write(
          `\r\n\x1b[90m[Process exited with code ${code ?? "unknown"}]\x1b[0m\r\n`,
        );
      } catch (err) {
        console.error(`[terminal] failed writing PTY exit line for ${thread.id}:`, err);
      }
      markThreadExited(thread.id, code ?? null);
    }
  };

  // Build command for AI threads (spawned via shell -l -c, exits when AI exits)
  // Shell threads pass no command (interactive shell)
  let command: string | undefined;
  if (thread.type === "claude") {
    command = isValidUUID(thread.claudeSessionId)
      ? (thread.resuming
        ? `claude --resume ${thread.claudeSessionId}`
        : `claude --session-id ${thread.claudeSessionId}`)
      : "claude";
  } else if (thread.type === "codex") {
    command =
      thread.resuming && isValidUUID(thread.codexThreadId)
        ? `codex resume ${thread.codexThreadId}`
        : "codex";
  }

  // Append extra CLI flags from launch preset (shell-escaped to prevent injection)
  // For shell threads, extraArgs IS the command to run
  if (thread.extraArgs) {
    if (command) {
      const escaped = shellEscapeArgs(thread.extraArgs);
      if (escaped) {
        command = `${command} ${escaped}`;
      }
    } else if (thread.type === "shell") {
      command = thread.extraArgs;
    }
  }

  const spawnWithCommand = (cmd: string | undefined) => {
    spawnPty(
      sessionId,
      terminal.rows,
      terminal.cols,
      channel,
      cwd,
      cmd,
      ACTIVITY_DETECTION_MODE,
    )
      .catch(console.error);
  };

  spawnWithCommand(command);

  // Tag this thread in Heed's ownership overlay so it shows up as ours in
  // ~/.heed/state.json. Claude (and resumed Codex) carry a known native id and
  // bind deterministically; a fresh Codex thread is correlated by the backend
  // once Heed observes it. Best-effort — failures never block the spawn.
  if (thread.type === "claude" && isValidUUID(thread.claudeSessionId)) {
    registerHeedOwner("claude", thread.id, thread.claudeSessionId, cwd).catch(
      console.error,
    );
  } else if (thread.type === "codex") {
    const codexNativeId =
      thread.resuming && isValidUUID(thread.codexThreadId)
        ? thread.codexThreadId
        : null;
    registerHeedOwner("codex", thread.id, codexNativeId, cwd).catch(
      console.error,
    );
  }

  // Wire input
  terminal.onData((data: string) => {
    if (data.includes("\x03")) lastCtrlCAt = Date.now();
    const submittedInput = data.includes("\r") || data.includes("\n");
    if (submittedInput) {
      // User-entered text should count as activity even before PTY output arrives.
      useAppStore.getState().touchThread(thread.id);
    }
    if (!data.includes("\r") && !data.includes("\n")) {
      inputEchoSuppressUntil = Date.now() + INPUT_ECHO_SUPPRESS_MS;
      suppressOutputActivity(thread.id, INPUT_ECHO_SUPPRESS_MS);
    } else {
      inputEchoSuppressUntil = 0;
    }
    writePty(sessionId, data).catch(console.error);
  });
}
