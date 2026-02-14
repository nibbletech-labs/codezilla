import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Channel } from "@tauri-apps/api/core";
import {
  spawnPty,
  writePty,
  resizePty,
  killPty,
  type PtyEvent,
  type PtyActivityData,
  type PtyCommandEndData,
  type PtyOutputData,
  type PtyExitData,
} from "../../lib/tauri";
import {
  TERMINAL_CONFIG,
  RESIZE_DEBOUNCE_MS,
} from "../../lib/constants";
import { getTerminalTheme, DARK_PALETTE, LIGHT_PALETTE } from "../../lib/themes";
import { useAppStore } from "../../store/appStore";
import type { Thread, ThreadType } from "../../store/types";
import { THREAD_NEW_LABELS } from "../../store/types";
import ThreadIcon from "../LeftPanel/ThreadIcons";
import {
  clearActivity,
  isOutputActivitySuppressed,
  recordOutput,
  suppressOutputActivity,
} from "../../lib/activityTracker";

import { createFilePathLinkProviderForTerminal } from "../../lib/filePathLinkProvider";
import { createCommitHashLinkProviderForTerminal } from "../../lib/commitHashLinkProvider";
import { createInitialTranscriptInfo } from "../../store/transcriptTypes";
import type { RuntimeStateSource } from "../../store/transcriptTypes";
import { deriveCoreRuntimeStatus } from "../../lib/threadActivityCore.ts";
import { deriveSubtitle } from "../../lib/transcriptStateMachine.ts";
import "@xterm/xterm/css/xterm.css";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUUID(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

// Track sessions that have received first PTY output (shared across instances)
const sessionsWithOutput = new Set<string>();

interface TerminalInstance {
  terminal: Terminal;
  fitAddon: FitAddon;
  container: HTMLDivElement;
  isAtBottom: boolean;
}

const THREAD_TYPES: ThreadType[] = ["claude", "codex", "shell"];
const RESIZE_ACTIVITY_SUPPRESS_MS = 900;
const TOUCH_DEBOUNCE_MS = 30_000;
const touchTimestamps = new Map<string, number>();
const INPUT_ECHO_SUPPRESS_MS = 450;
type ActivityDetectionMode = "legacy" | "hybrid" | "marker";

function parseActivityDetectionMode(raw: string | undefined): ActivityDetectionMode {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === "legacy" || normalized === "hybrid" || normalized === "marker") {
    return normalized;
  }
  return "hybrid";
}

const ACTIVITY_DETECTION_MODE = parseActivityDetectionMode(
  import.meta.env.VITE_THREAD_ACTIVITY_MODE,
);
const MARKER_EVENTS_ENABLED = ACTIVITY_DETECTION_MODE !== "legacy";
const STRICT_MARKER_MODE = ACTIVITY_DETECTION_MODE === "marker";

function nextPtySource(source: RuntimeStateSource): RuntimeStateSource {
  return source === "transcript" || source === "mixed" ? "mixed" : "pty";
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
    previousStatus: current.status,
    status: nextStatus,
  };
  resolved.subtitle = deriveSubtitle(resolved);

  if (nextStatus === "working") {
    // Preserve attention-requiring badges through brief PTY activity blips
    // (e.g. resize redraws). The transcript watcher is the authoritative
    // badge setter and will clear/update them when the idle reason changes.
    const keepBadge = current.badge === "needs_input" || current.badge === "needs_approval";
    return {
      ...resolved,
      badge: keepBadge ? current.badge : null,
      badgeSince: keepBadge ? current.badgeSince : null,
    };
  }

  // Badge assignment for idle transitions is handled by the transcript
  // watcher (useTranscriptWatcher), which has proper confirmation delays
  // and transcript-driven idle reason detection. Setting badges here
  // would race with the watcher and cause flash-on/flash-off artifacts.
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
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  const projects = useAppStore((s) => s.projects);
  const addThread = useAppStore((s) => s.addThread);
  const removeProject = useAppStore((s) => s.removeProject);
  const markThreadExited = useAppStore((s) => s.markThreadExited);
  const resumeThread = useAppStore((s) => s.resumeThread);
  const activeProject = projects.find((p) => p.id === activeProjectId);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const instancesRef = useRef<Map<string, TerminalInstance>>(new Map());
  const resizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastDimsRef = useRef<Map<string, { rows: number; cols: number }>>(new Map());

  const [showScrollButton, setShowScrollButton] = useState(false);
  const [loadingSession, setLoadingSession] = useState<string | null>(null);
  const scrollCallbackRef = useRef<((atBottom: boolean) => void) | null>(null);
  scrollCallbackRef.current = (atBottom: boolean) => setShowScrollButton(!atBottom);
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
        const buf = instance.terminal.buffer.active;
        const wasAtBottom = buf.viewportY >= buf.baseY;
        const savedViewportY = buf.viewportY;
        instance.fitAddon.fit();
        if (wasAtBottom) {
          instance.terminal.scrollToBottom();
        } else {
          instance.terminal.scrollToLine(Math.min(savedViewportY, instance.terminal.buffer.active.baseY));
        }
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
        instance.terminal.dispose();
        if (instance.container.parentNode === wrapper) {
          wrapper.removeChild(instance.container);
        }
        instances.delete(sessionId);
        lastDimsRef.current.delete(sessionId);
        sessionsWithOutput.delete(sessionId);
      }
    }

    // Create instances for new threads (skip dormant — no sessionId)
    for (const thread of threads) {
      if (thread.sessionId && !instances.has(thread.sessionId)) {
        createTerminalInstance(wrapper, thread, instances, markThreadExited, (atBottom) => {
          scrollCallbackRef.current?.(atBottom);
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
        instance.container.style.display = "block";
        if (sessionChanged) {
          if (activeThread) {
            suppressOutputActivity(activeThread.id, RESIZE_ACTIVITY_SUPPRESS_MS);
          }
          instance.fitAddon.fit();
          instance.terminal.scrollToBottom();
          setShowScrollButton(false);
          const rows = instance.terminal.rows;
          const cols = instance.terminal.cols;
          const last = lastDimsRef.current.get(sessionId);
          if (!last || last.rows !== rows || last.cols !== cols) {
            lastDimsRef.current.set(sessionId, { rows, cols });
            resizePty(sessionId, rows, cols).catch(console.error);
          }
          instance.terminal.focus();
        }
      } else {
        instance.container.style.display = "none";
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
      const buf = instance.terminal.buffer.active;
      const wasAtBottom = buf.viewportY >= buf.baseY;
      const savedViewportY = buf.viewportY;

      instance.terminal.options.fontSize = baseFontSize;
      instance.fitAddon.fit();

      if (wasAtBottom) {
        instance.terminal.scrollToBottom();
      } else {
        instance.terminal.scrollToLine(
          Math.min(savedViewportY, instance.terminal.buffer.active.baseY),
        );
      }

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
        instance.terminal.dispose();
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
      {showScrollButton && activeThreadId && (
        <ScrollToBottomButton onClick={() => {
          const active = threads.find((t) => t.id === activeThreadId);
          if (active?.sessionId) {
            const instance = instancesRef.current.get(active.sessionId);
            if (instance) {
              instance.terminal.scrollToBottom();
              setShowScrollButton(false);
            }
          }
        }} />
      )}
      {!activeThreadId && (
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
            <div style={{ color: "var(--text-primary)", fontSize: "calc(var(--font-size) + 10px)", fontWeight: 600, marginBottom: "2px" }}>
              {activeProject.name}
            </div>
          )}
          <div style={{ color: "var(--text-secondary)", fontSize: "var(--font-size)", marginBottom: "4px" }}>
            {activeProjectId ? "Start a session" : "Select a project to begin"}
          </div>
          {activeProjectId && (
            <div style={{ display: "flex", gap: "8px" }}>
              {THREAD_TYPES.map((type) => (
                <EmptyStateButton
                  key={type}
                  type={type}
                  label={THREAD_NEW_LABELS[type]}
                  onClick={() => addThread(activeProjectId, type)}
                />
              ))}
            </div>
          )}
          {activeProjectId && (
            <RemoveProjectButton onClick={() => removeProject(activeProjectId)} />
          )}
        </div>
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

function createTerminalInstance(
  wrapper: HTMLDivElement,
  thread: Thread,
  instances: Map<string, TerminalInstance>,
  markThreadExited: (threadId: string, exitCode: number | null) => void,
  onScrollStateChange: ((atBottom: boolean) => void) | null,
  onFirstOutput: ((sessionId: string) => void) | null,
) {
  if (!thread.sessionId) return;

  const container = document.createElement("div");
  container.style.cssText =
    "position:absolute;top:0;right:0;bottom:0;left:6px;display:none;";
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

  const terminal = new Terminal({
    ...TERMINAL_CONFIG,
    fontSize: storeState.baseFontSize,
    theme: dynamicTheme,
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);

  try {
    const webglAddon = new WebglAddon();
    webglAddon.onContextLoss(() => webglAddon.dispose());
    terminal.loadAddon(webglAddon);
  } catch {
    // Canvas fallback
  }

  // Don't call fit() here — container is display:none so FitAddon would
  // measure 0×0 and resize the terminal to minimum (2×1). The show/hide
  // effect will fit after setting display:block.
  const instance: TerminalInstance = { terminal, fitAddon, container, isAtBottom: true };
  instances.set(thread.sessionId, instance);

  // Track scroll position to show/hide "scroll to bottom" button.
  // Check on both scroll events and after new output is written, so the
  // button appears reliably when the user is scrolled up.
  const checkScrollState = () => {
    const buf = terminal.buffer.active;
    const atBottom = buf.baseY === 0 || buf.viewportY >= buf.baseY - 1;
    instance.isAtBottom = atBottom;
    const activeId = useAppStore.getState().activeThreadId;
    if (activeId === thread.id && onScrollStateChange) {
      onScrollStateChange(atBottom);
    }
  };
  terminal.onScroll(checkScrollState);

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

  const sessionId = thread.sessionId;
  const outputQueue: Uint8Array[] = [];
  let flushingOutput = false;
  let markerEventsObserved = false;
  let progressActive = false;
  let inputEchoSuppressUntil = 0;
  let hasReceivedOutput = false;

  const flushOutput = () => {
    if (flushingOutput) return;
    flushingOutput = true;

    const pump = () => {
      const chunk = outputQueue.shift();
      if (!chunk) {
        flushingOutput = false;
        return;
      }
      try {
        terminal.write(chunk, () => {
          checkScrollState();
          // Break synchronous recursion on very high-volume streams.
          setTimeout(pump, 0);
        });
      } catch (err) {
        console.error(`[terminal] failed flushing PTY output for ${thread.id}:`, err);
        outputQueue.length = 0;
        flushingOutput = false;
      }
    };

    pump();
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
      if (!hasReceivedOutput) {
        hasReceivedOutput = true;
        sessionsWithOutput.add(sessionId);
        onFirstOutput?.(sessionId);
      }
      outputQueue.push(new Uint8Array(data));
      flushOutput();
      recordOutput(thread.id);
      // Debounced lastActivityAt touch
      const now = Date.now();
      const lastTouch = touchTimestamps.get(thread.id) ?? 0;
      if (now - lastTouch >= TOUCH_DEBOUNCE_MS) {
        touchTimestamps.set(thread.id, now);
        useAppStore.getState().touchThread(thread.id);
      }
    } else if (event.event === "Activity") {
      const { active, source } = event.data as PtyActivityData;
      const fromProgress = source === "progress";

      if (fromProgress) {
        progressActive = active;
      }

      // Once command start/end markers are observed, only process progress-sourced
      // activity events — output-based heuristics are superseded by markers.
      if (MARKER_EVENTS_ENABLED && markerEventsObserved && !fromProgress) {
        return;
      }

      // Progress markers are authoritative: if the CLI says it's active
      // (spinner visible), ignore the output watchdog's idle timeout.
      // Claude/Codex sessions don't use the shell wrapper (no CommandStart),
      // so the watchdog isn't suppressed — but progress markers are reliable.
      if (!fromProgress && !active && progressActive) {
        return;
      }

      if (
        !fromProgress
        && Date.now() <= inputEchoSuppressUntil
        && isOutputActivitySuppressed(thread.id)
      ) {
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
      if (!MARKER_EVENTS_ENABLED) {
        return;
      }
      markerEventsObserved = true;
      applyPtyCommandStart(thread);
    } else if (event.event === "CommandEnd") {
      if (!MARKER_EVENTS_ENABLED) {
        return;
      }
      markerEventsObserved = true;
      const { exit_code } = event.data as PtyCommandEndData;
      applyPtyCommandEnd(thread, exit_code);
    } else if (event.event === "Exit") {
      const { code } = event.data as PtyExitData;
      if (MARKER_EVENTS_ENABLED && markerEventsObserved) {
        applyPtyCommandEnd(thread, code ?? null);
      } else {
        applyPtyActivityUpdate(thread, false, "output", "output_idle");
      }
      clearActivity(thread.id);
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

  // Wire input
  terminal.onData((data: string) => {
    if (!data.includes("\r") && !data.includes("\n")) {
      inputEchoSuppressUntil = Date.now() + INPUT_ECHO_SUPPRESS_MS;
      suppressOutputActivity(thread.id, INPUT_ECHO_SUPPRESS_MS);
    } else {
      inputEchoSuppressUntil = 0;
    }
    writePty(sessionId, data).catch(console.error);
  });
}
