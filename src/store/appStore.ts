import { create } from "zustand";
import type { Project, Thread, ThreadType, PersistedThread, PreviewTarget, ProjectIcon, ScheduledJob, LaunchPreset, BetaFeatures, UsageChartVisibility } from "./types";
import type { UsageSnapshot, UsageAgent } from "./usageTypes";
import { THREAD_LABELS } from "./types";
import type { TranscriptInfo } from "./transcriptTypes";
import type { RepoHealth, WorktreeInfo } from "../lib/tauri";
import { getGitWorktrees } from "../lib/tauri";
import { attributeEnv } from "../lib/worktree";
import type { AccentColorId, AppearanceMode } from "../lib/themes";

const MAX_EXITED_THREADS_PER_PROJECT = 50;

// Repo health: a project is flagged after this many consecutive git polls
// exceed the slow threshold. Streaks live outside the store — only the flag
// itself needs to trigger renders.
export const SLOW_GIT_MS = 400;
const SLOW_GIT_STREAK = 3;
const gitSlowStreaks = new Map<string, number>();

export interface RepoHealthDismissal {
  dismissedAt: number;
  /** `git status` duration when dismissed — re-warn only if it gets much worse. */
  statusDurationMs: number;
}

interface AppState {
  // Data
  projects: Project[];
  threads: Thread[];
  activeProjectId: string | null;
  activeThreadId: string | null;
  expandedPaths: Record<string, string[]>; // projectId -> array of expanded dir paths
  previewFile: PreviewTarget | null;
  selectedFilePath: string | null;
  fileIndex: Set<string>;
  filePicker: { candidates: string[]; position: { x: number; y: number }; line?: number; col?: number } | null;
  fileLinkMenu: { path: string; position: { x: number; y: number }; line?: number; col?: number } | null;
  transcriptInfo: Record<string, TranscriptInfo>;
  worktrees: WorktreeInfo[];                     // runtime: worktrees of the active project (git source of truth)
  baseFontSize: number;
  accentColorId: AccentColorId;
  appearanceMode: AppearanceMode;
  rememberWindowPosition: boolean;
  showLeftPanel: boolean;
  showRightPanel: boolean;
  renamingThreadId: string | null;
  sidebarOpenedForRename: boolean;
  skillsManagerOpen: boolean;
  presetsManagerOpen: boolean;

  // Preview / selection actions
  openPreview: (path: string, line?: number, mode?: "preview" | "edit") => void;
  openCommitPreview: (hash: string) => void;
  closePreview: () => void;
  selectFileInTree: (path: string) => void;
  setFileIndex: (index: Set<string>) => void;
  showFilePicker: (candidates: string[], position: { x: number; y: number }, line?: number, col?: number) => void;
  closeFilePicker: () => void;
  showFileLinkMenu: (path: string, position: { x: number; y: number }, line?: number, col?: number) => void;
  closeFileLinkMenu: () => void;
  updateTranscriptInfo: (threadId: string, info: TranscriptInfo) => void;
  updateTranscriptInfoBatch: (entries: Record<string, TranscriptInfo>) => void;
  clearTranscriptInfo: (threadId: string) => void;
  setWorktrees: (worktrees: WorktreeInfo[]) => void;

  // Worktree environment selector + uncommitted-work attribution (CZ-53).
  selectedEnvPath: string | null;                                  // null = main (the active project root)
  setSelectedEnvPath: (path: string | null) => void;
  envDiffStats: Record<string, { added: number; removed: number }>; // per-env uncommitted diff totals, keyed by env path
  setEnvDiffStats: (stats: Record<string, { added: number; removed: number }>) => void;
  touchedEnvsByThread: Record<string, Record<string, number>>;      // threadId -> absolute file path -> lastTouchMs
  recordThreadTouch: (threadId: string, filePath: string, ms: number) => void;
  loadTouchedEnvs: (touched: Record<string, Record<string, number>>) => void;

  // Project actions
  addProject: (path: string, name: string) => void;
  removeProject: (projectId: string) => void;
  reorderProjects: (fromIndex: number, toIndex: number) => void;
  setActiveProject: (projectId: string) => void;
  toggleProjectExpanded: (projectId: string) => void;

  // Thread actions
  addThread: (projectId: string, type: ThreadType, extraArgs?: string | null) => Thread;
  removeThread: (threadId: string) => void;
  setActiveThread: (threadId: string) => void;
  renameThread: (threadId: string, name: string) => void;
  markThreadExited: (threadId: string, exitCode: number | null) => void;
  resumeThread: (threadId: string) => string;
  newSession: (threadId: string) => string;
  setCodexThreadId: (threadId: string, codexThreadId: string) => void;
  clearResuming: (threadId: string) => void;
  touchThread: (threadId: string) => void;

  setProjectIcon: (projectId: string, icon: ProjectIcon | undefined) => void;
  markProjectMissing: (projectId: string, missing: boolean) => void;

  // File tree actions
  toggleExpandedPath: (projectId: string, path: string) => void;

  // Derived helpers
  getProjectThreads: (projectId: string) => Thread[];
  getActiveProject: () => Project | undefined;
  getActiveThread: () => Thread | undefined;

  // Font size
  setBaseFontSize: (size: number) => void;
  loadBaseFontSize: (size: number) => void;

  // Appearance
  setAccentColorId: (id: AccentColorId) => void;
  loadAccentColorId: (id: AccentColorId) => void;
  setAppearanceMode: (mode: AppearanceMode) => void;
  loadAppearanceMode: (mode: AppearanceMode) => void;
  setRememberWindowPosition: (value: boolean) => void;
  loadRememberWindowPosition: (value: boolean) => void;

  // Panel visibility
  toggleLeftPanel: () => void;
  toggleRightPanel: () => void;
  loadPanelVisibility: (left: boolean, right: boolean) => void;
  startRenamingThread: (threadId: string) => void;
  clearRenamingThread: () => void;
  openSkillsManager: () => void;
  closeSkillsManager: () => void;
  openPresetsManager: () => void;
  closePresetsManager: () => void;

  // Scheduled jobs
  scheduledJobs: ScheduledJob[];
  activeJobId: string | null;
  addScheduledJob: (projectId: string, job: Omit<ScheduledJob, "id" | "createdAt">) => ScheduledJob;
  updateScheduledJob: (jobId: string, updates: Partial<Pick<ScheduledJob, "name" | "command" | "schedule" | "type" | "enabled">>) => void;
  removeScheduledJob: (jobId: string) => void;
  setActiveJob: (jobId: string) => void;
  getProjectJobs: (projectId: string) => ScheduledJob[];
  loadScheduledJobs: (jobs: ScheduledJob[]) => void;

  // Launch presets
  launchPresets: LaunchPreset[];
  addLaunchPreset: (preset: Omit<LaunchPreset, "id">) => LaunchPreset;
  updateLaunchPreset: (id: string, updates: Partial<Omit<LaunchPreset, "id">>) => void;
  removeLaunchPreset: (id: string) => void;
  loadLaunchPresets: (presets: LaunchPreset[]) => void;

  // Plan-usage tracker (Claude + Codex subscription limits)
  usage: UsageSnapshot | null;
  setUsage: (snapshot: UsageSnapshot) => void;
  usageChartVisibility: UsageChartVisibility;
  setUsageChartVisibility: (agent: UsageAgent, visible: boolean) => void;
  loadUsageChartVisibility: (v: UsageChartVisibility) => void;

  // Beta features
  betaFeatures: BetaFeatures;
  betaFeaturesOpen: boolean;
  autoDisabledJobIds: string[];
  setBetaFeature: (key: keyof BetaFeatures, value: boolean) => void;
  loadBetaFeatures: (features: BetaFeatures) => void;
  loadAutoDisabledJobIds: (ids: string[]) => void;
  openBetaFeatures: () => void;
  closeBetaFeatures: () => void;

  // Repo health (slow-git detection, keyed by project path)
  repoHealthFlagged: Record<string, boolean>;
  repoHealth: Record<string, RepoHealth>;
  repoHealthDismissals: Record<string, RepoHealthDismissal>;
  reportGitTiming: (projectPath: string, durationMs: number) => void;
  setRepoHealth: (projectPath: string, health: RepoHealth) => void;
  dismissRepoHealth: (projectPath: string) => void;
  loadRepoHealthDismissals: (dismissals: Record<string, RepoHealthDismissal>) => void;

  // Persistence
  loadProjects: (projects: Project[]) => void;
  loadExpandedPaths: (expandedPaths: Record<string, string[]>) => void;
  loadThreads: (persisted: PersistedThread[]) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  projects: [],
  threads: [],
  activeProjectId: null,
  activeThreadId: null,
  expandedPaths: {},
  previewFile: null,
  selectedFilePath: null,
  fileIndex: new Set<string>(),
  filePicker: null,
  fileLinkMenu: null,
  transcriptInfo: {},
  worktrees: [],
  selectedEnvPath: null,
  envDiffStats: {},
  touchedEnvsByThread: {},
  baseFontSize: 14,
  accentColorId: "green",
  appearanceMode: "dark",
  rememberWindowPosition: true,
  showLeftPanel: true,
  showRightPanel: true,
  renamingThreadId: null,
  sidebarOpenedForRename: false,
  skillsManagerOpen: false,
  presetsManagerOpen: false,
  scheduledJobs: [],
  activeJobId: null,
  launchPresets: [],
  usage: null,
  setUsage: (snapshot) => set({ usage: snapshot }),
  usageChartVisibility: { claude: true, codex: true },
  setUsageChartVisibility: (agent, visible) =>
    set((s) => ({ usageChartVisibility: { ...s.usageChartVisibility, [agent]: visible } })),
  loadUsageChartVisibility: (v) =>
    set({ usageChartVisibility: { claude: v.claude ?? true, codex: v.codex ?? true } }),

  betaFeatures: { codexThreads: false, skillsPlugins: false, scheduledJobs: false },
  betaFeaturesOpen: false,
  autoDisabledJobIds: [],
  repoHealthFlagged: {},
  repoHealth: {},
  repoHealthDismissals: {},

  openPreview: (path, line, mode = "preview") => {
    set({ previewFile: { kind: "file", path, line, mode } });
  },

  openCommitPreview: (hash) => {
    set({ previewFile: { kind: "commit", hash } });
  },

  closePreview: () => {
    set({ previewFile: null });
  },

  selectFileInTree: (path) => {
    // Expand all ancestor directories so the file is visible
    const state = get();
    const project = state.projects.find((p) => p.id === state.activeProjectId);
    if (!project) {
      set({ selectedFilePath: path });
      return;
    }
    const projectRoot = project.path.endsWith("/") ? project.path : project.path + "/";
    if (!path.startsWith(projectRoot)) {
      set({ selectedFilePath: path });
      return;
    }
    const rel = path.slice(projectRoot.length);
    const parts = rel.split("/");
    const current = state.expandedPaths[project.id] ?? [];
    const currentSet = new Set(current);
    // Expand each ancestor dir (all parts except the last which is the file)
    for (let i = 1; i < parts.length; i++) {
      const ancestor = projectRoot + parts.slice(0, i).join("/");
      currentSet.add(ancestor);
    }
    set({
      selectedFilePath: path,
      expandedPaths: { ...state.expandedPaths, [project.id]: Array.from(currentSet) },
    });
  },

  setFileIndex: (index) => {
    set({ fileIndex: index });
  },

  showFilePicker: (candidates, position, line, col) => {
    set({ filePicker: { candidates, position, line, col } });
  },

  closeFilePicker: () => {
    set({ filePicker: null });
  },

  showFileLinkMenu: (path, position, line, col) => {
    set({ fileLinkMenu: { path, position, line, col } });
  },

  closeFileLinkMenu: () => {
    set({ fileLinkMenu: null });
  },

  updateTranscriptInfo: (threadId, info) => {
    if (get().transcriptInfo[threadId] === info) return;
    set((s) => ({
      transcriptInfo: { ...s.transcriptInfo, [threadId]: info },
    }));
  },

  // Apply many transcript-info updates in a single store mutation. Used by the
  // Heed activity stream, which can touch every owned thread per emit: one
  // `set()` (one spread, one subscriber-notification pass) instead of N keeps
  // the activity-indicator hot path off the main thread. Callers must only
  // include threads whose info actually changed — unchanged entries here still
  // produce new object references and would force redundant ThreadItem renders.
  updateTranscriptInfoBatch: (entries) => {
    if (Object.keys(entries).length === 0) return;
    set((s) => ({
      transcriptInfo: { ...s.transcriptInfo, ...entries },
    }));
  },

  clearTranscriptInfo: (threadId) => {
    if (!(threadId in get().transcriptInfo)) return;
    set((s) => {
      const next = { ...s.transcriptInfo };
      delete next[threadId];
      return { transcriptInfo: next };
    });
  },

  // Replace the active project's worktree list. Skips the update when nothing
  // changed so consumers (TitleBar, RightPanel, ThreadItem) don't re-render.
  setWorktrees: (worktrees) => {
    const prev = get().worktrees;
    if (
      prev.length === worktrees.length &&
      prev.every((w, i) => {
        const n = worktrees[i];
        return (
          w.path === n.path &&
          w.branch === n.branch &&
          w.detached === n.detached &&
          w.head === n.head &&
          w.source === n.source
        );
      })
    ) {
      return;
    }
    set({ worktrees });
  },

  setSelectedEnvPath: (path) => set({ selectedEnvPath: path }),

  // Record that a thread edited a file at `filePath` (an absolute path). We store
  // the RAW path, not a resolved env — the path is attributed to a worktree/main
  // at DISPLAY time using the active project's worktrees (correct because the user
  // is then viewing that project), so attribution never depends on whichever
  // project happened to be active at edit time. Idempotent per (thread, path).
  recordThreadTouch: (threadId, filePath, ms) =>
    set((s) => ({
      touchedEnvsByThread: {
        ...s.touchedEnvsByThread,
        [threadId]: { ...(s.touchedEnvsByThread[threadId] ?? {}), [filePath]: ms },
      },
    })),

  loadTouchedEnvs: (touched) => set({ touchedEnvsByThread: touched }),

  // Replace the per-env diff totals. Skips the write when nothing changed so
  // consumers don't re-render. (Touch records are raw file paths, attributed and
  // dirtiness-gated at display time, so no env-based pruning is needed here.)
  setEnvDiffStats: (stats) => {
    set((s) => {
      const prev = s.envDiffStats;
      const nextKeys = Object.keys(stats);
      const unchanged =
        Object.keys(prev).length === nextKeys.length &&
        nextKeys.every(
          (k) => prev[k] && prev[k].added === stats[k].added && prev[k].removed === stats[k].removed,
        );
      return unchanged ? {} : { envDiffStats: stats };
    });
  },

  addProject: (path, name) => {
    const state = get();
    // Focus existing project if duplicate path
    const existing = state.projects.find((p) => p.path === path);
    if (existing) {
      set({ activeProjectId: existing.id, activeThreadId: null });
      return;
    }

    const project: Project = {
      id: crypto.randomUUID(),
      name,
      path,
      expanded: true,
      threadCounter: { claude: 0, codex: 0, shell: 0 },
    };
    set((s) => ({
      projects: [...s.projects, project],
      activeProjectId: project.id,
      activeThreadId: null,
    }));
  },

  reorderProjects: (fromIndex, toIndex) => {
    set((s) => {
      const next = [...s.projects];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return { projects: next };
    });
  },

  removeProject: (projectId) => {
    set((s) => {
      const removedThreadIds = new Set(
        s.threads.filter((t) => t.projectId === projectId).map((t) => t.id),
      );
      const remainingProjects = s.projects.filter((p) => p.id !== projectId);
      const remainingThreads = s.threads.filter(
        (t) => t.projectId !== projectId,
      );
      const removedThreadActive =
        s.activeThreadId &&
        s.threads.some(
          (t) => t.id === s.activeThreadId && t.projectId === projectId,
        );

      const nextExpandedPaths = { ...s.expandedPaths };
      delete nextExpandedPaths[projectId];

      // Clean up transcriptInfo for all removed threads
      let nextTranscriptInfo = s.transcriptInfo;
      const hasOrphans = [...removedThreadIds].some(id => id in s.transcriptInfo);
      if (hasOrphans) {
        nextTranscriptInfo = { ...s.transcriptInfo };
        for (const id of removedThreadIds) {
          delete nextTranscriptInfo[id];
        }
      }

      const removedJobActive =
        s.activeJobId &&
        s.scheduledJobs.some(
          (j) => j.id === s.activeJobId && j.projectId === projectId,
        );

      return {
        projects: remainingProjects,
        threads: remainingThreads,
        scheduledJobs: s.scheduledJobs.filter((j) => j.projectId !== projectId),
        expandedPaths: nextExpandedPaths,
        transcriptInfo: nextTranscriptInfo,
        activeProjectId:
          s.activeProjectId === projectId
            ? (remainingProjects[0]?.id ?? null)
            : s.activeProjectId,
        activeThreadId: removedThreadActive ? null : s.activeThreadId,
        activeJobId: removedJobActive ? null : s.activeJobId,
        selectedEnvPath: s.activeProjectId === projectId ? null : s.selectedEnvPath,
      };
    });
  },

  setActiveProject: (projectId) => {
    set({ activeProjectId: projectId, activeThreadId: null, activeJobId: null, selectedEnvPath: null });
  },

  toggleProjectExpanded: (projectId) => {
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId ? { ...p, expanded: !p.expanded } : p,
      ),
    }));
  },

  addThread: (projectId, type, extraArgs) => {
    let thread: Thread = null!;
    set((s) => {
      const project = s.projects.find((p) => p.id === projectId);
      if (!project) return s;

      const nextCount = project.threadCounter[type] + 1;
      const name = `${THREAD_LABELS[type]} #${nextCount}`;
      const id = crypto.randomUUID();

      thread = {
        id,
        projectId,
        type,
        name,
        sessionId: crypto.randomUUID(),
        claudeSessionId: type === "claude" ? crypto.randomUUID() : null,
        codexThreadId: null,
        state: "running",
        exitCode: null,
        resuming: false,
        lastActivityAt: Date.now(),
        extraArgs: extraArgs ?? null,
      };

      let newThreads = [...s.threads, thread];

      // Prune oldest exited/dormant threads per project if over limit
      const projectThreads = newThreads.filter(t => t.projectId === projectId);
      const exited = projectThreads
        .filter(t => t.state === "exited" || t.state === "dormant")
        .sort((a, b) => a.lastActivityAt - b.lastActivityAt);
      const excess = exited.length - MAX_EXITED_THREADS_PER_PROJECT;
      let nextTranscriptInfo = s.transcriptInfo;
      if (excess > 0) {
        const toRemove = new Set(exited.slice(0, excess).map(t => t.id));
        newThreads = newThreads.filter(t => !toRemove.has(t.id));
        // Clean up transcriptInfo for pruned threads
        const hasOrphans = [...toRemove].some(id => id in s.transcriptInfo);
        if (hasOrphans) {
          nextTranscriptInfo = { ...s.transcriptInfo };
          for (const id of toRemove) {
            delete nextTranscriptInfo[id];
          }
        }
      }

      return {
        projects: s.projects.map((p) =>
          p.id === projectId
            ? {
                ...p,
                threadCounter: { ...p.threadCounter, [type]: nextCount },
              }
            : p,
        ),
        threads: newThreads,
        activeThreadId: thread.id,
        activeJobId: null,
        activeProjectId: projectId,
        ...(s.activeProjectId !== projectId ? { selectedEnvPath: null } : {}),
        transcriptInfo: nextTranscriptInfo,
      };
    });
    return thread;
  },

  removeThread: (threadId) => {
    set((s) => {
      // Clean up transcriptInfo for the removed thread
      const nextTranscriptInfo = { ...s.transcriptInfo };
      delete nextTranscriptInfo[threadId];

      // Drop any uncommitted-work touch records for the removed thread (avoids
      // stale dots). Same reference when the thread had none — a no-op write.
      let nextTouched = s.touchedEnvsByThread;
      if (threadId in nextTouched) {
        nextTouched = { ...s.touchedEnvsByThread };
        delete nextTouched[threadId];
      }

      if (s.activeThreadId !== threadId) {
        return { threads: s.threads.filter((t) => t.id !== threadId), transcriptInfo: nextTranscriptInfo, touchedEnvsByThread: nextTouched };
      }

      const deleted = s.threads.find((t) => t.id === threadId);
      const siblings = deleted
        ? s.threads.filter((t) => t.projectId === deleted.projectId)
        : [];
      const idx = siblings.findIndex((t) => t.id === threadId);

      // Next sibling, then previous sibling, then null
      const next =
        siblings[idx + 1] ?? siblings[idx - 1] ?? null;

      return {
        threads: s.threads.filter((t) => t.id !== threadId),
        activeThreadId: next?.id ?? null,
        transcriptInfo: nextTranscriptInfo,
        touchedEnvsByThread: nextTouched,
      };
    });
  },

  setActiveThread: (threadId) => {
    const thread = get().threads.find((t) => t.id === threadId);
    if (!thread) return;
    const prevProjectId = get().activeProjectId;
    const sameProject = thread.projectId === prevProjectId;

    // Auto-select the env where this thread most recently edited a file: take its
    // newest touched path and resolve it against the project's worktrees, so
    // selecting a thread follows it to the worktree it last worked in (most recent
    // wins if it spanned several). Falls back to main.
    const touched = get().touchedEnvsByThread[threadId];
    let bestPath: string | null = null;
    if (touched) {
      let bestMs = -1;
      for (const [p, ms] of Object.entries(touched)) {
        if (ms > bestMs) { bestMs = ms; bestPath = p; }
      }
    }
    const projectPath = get().projects.find((p) => p.id === thread.projectId)?.path ?? null;
    // Resolve a touched path to the follow-env (null = main / no change handled by caller).
    const resolveEnv = (worktrees: WorktreeInfo[]): string | null => {
      const env = bestPath && projectPath ? attributeEnv(bestPath, worktrees, projectPath) : null;
      return env && env !== projectPath ? env : null;
    };

    // Clear badge when switching to this thread (like marking email as read)
    const info = get().transcriptInfo[threadId];
    const transcriptUpdate: Record<string, TranscriptInfo> = {};
    if (info && info.badge != null) {
      transcriptUpdate[threadId] = { ...info, badge: null, badgeSince: null, badgeDismissedAt: Date.now() };
    }
    const transcriptPatch = Object.keys(transcriptUpdate).length > 0
      ? { transcriptInfo: { ...get().transcriptInfo, ...transcriptUpdate } }
      : {};

    if (sameProject) {
      // Worktrees in the store already belong to this project, so resolve now. If
      // the thread has no recorded edits, leave the current selection untouched
      // (`undefined`); otherwise follow it (possibly back to main).
      const nextEnv: string | null | undefined = bestPath ? resolveEnv(get().worktrees) : undefined;
      set({
        activeThreadId: threadId,
        activeJobId: null,
        activeProjectId: thread.projectId,
        ...(nextEnv !== undefined ? { selectedEnvPath: nextEnv } : {}),
        ...transcriptPatch,
      });
      return;
    }

    // Cross-project switch: the store still holds the PREVIOUS project's worktrees
    // (useWorktrees only refetches after activeProjectId changes), so resolving
    // against get().worktrees here would always miss and fall back to main. Activate
    // immediately defaulting to main, then fetch the target project's worktrees and
    // resolve the follow-env once they're known.
    set({
      activeThreadId: threadId,
      activeJobId: null,
      activeProjectId: thread.projectId,
      selectedEnvPath: null,
      ...transcriptPatch,
    });
    if (!bestPath || !projectPath) return;
    void getGitWorktrees(projectPath)
      .then((worktrees) => {
        // The user may have navigated away during the fetch — only follow if this
        // thread is still active and the user hasn't manually picked an env since.
        if (get().activeThreadId !== threadId || get().selectedEnvPath !== null) return;
        const nextEnv = resolveEnv(worktrees);
        if (nextEnv !== get().selectedEnvPath) set({ selectedEnvPath: nextEnv });
      })
      .catch(() => { /* keep main on a transient git failure */ });
  },

  renameThread: (threadId, name) => {
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === threadId ? { ...t, name } : t,
      ),
    }));
  },

  markThreadExited: (threadId, exitCode) => {
    set((s) => {
      // Clean up transcriptInfo for exited thread to prevent unbounded growth
      const nextTranscriptInfo = { ...s.transcriptInfo };
      delete nextTranscriptInfo[threadId];
      return {
        threads: s.threads.map((t) =>
          t.id === threadId ? { ...t, state: "exited" as const, exitCode, lastActivityAt: Date.now() } : t,
        ),
        activeThreadId: s.activeThreadId === threadId ? null : s.activeThreadId,
        transcriptInfo: nextTranscriptInfo,
      };
    });
  },

  resumeThread: (threadId) => {
    const newSessionId = crypto.randomUUID();
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === threadId
          ? { ...t, sessionId: newSessionId, state: "running" as const, exitCode: null, resuming: true }
          : t,
      ),
    }));
    return newSessionId;
  },

  newSession: (threadId) => {
    const newSessionId = crypto.randomUUID();
    set((s) => ({
      threads: s.threads.map((t) => {
        if (t.id !== threadId) return t;
        return {
          ...t,
          sessionId: newSessionId,
          claudeSessionId: t.type === "claude" ? crypto.randomUUID() : null,
          codexThreadId: null,
          state: "running" as const,
          exitCode: null,
          resuming: false,
          lastActivityAt: Date.now(),
        };
      }),
    }));
    return newSessionId;
  },

  setCodexThreadId: (threadId, codexThreadId) => {
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === threadId ? { ...t, codexThreadId } : t,
      ),
    }));
  },

  clearResuming: (threadId) => {
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === threadId && t.resuming ? { ...t, resuming: false } : t,
      ),
    }));
  },

  touchThread: (threadId) => {
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === threadId ? { ...t, lastActivityAt: Date.now() } : t,
      ),
    }));
  },

  setProjectIcon: (projectId, icon) => {
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId ? { ...p, icon } : p,
      ),
    }));
  },

  markProjectMissing: (projectId, missing) => {
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId ? { ...p, missing } : p,
      ),
    }));
  },

  toggleExpandedPath: (projectId, path) => {
    set((s) => {
      const current = s.expandedPaths[projectId] ?? [];
      const idx = current.indexOf(path);
      const next = idx >= 0 ? current.filter((p) => p !== path) : [...current, path];
      return { expandedPaths: { ...s.expandedPaths, [projectId]: next } };
    });
  },

  getProjectThreads: (projectId) => {
    return get().threads.filter((t) => t.projectId === projectId);
  },

  getActiveProject: () => {
    const { projects, activeProjectId } = get();
    return projects.find((p) => p.id === activeProjectId);
  },

  getActiveThread: () => {
    const { threads, activeThreadId } = get();
    return threads.find((t) => t.id === activeThreadId);
  },

  setBaseFontSize: (size) => {
    set({ baseFontSize: size });
  },

  loadBaseFontSize: (size) => {
    set({ baseFontSize: size });
  },

  setAccentColorId: (id) => {
    set({ accentColorId: id });
  },

  loadAccentColorId: (id) => {
    set({ accentColorId: id });
  },

  setAppearanceMode: (mode) => {
    set({ appearanceMode: mode });
  },

  loadAppearanceMode: (mode) => {
    set({ appearanceMode: mode });
  },

  setRememberWindowPosition: (value) => {
    set({ rememberWindowPosition: value });
  },

  loadRememberWindowPosition: (value) => {
    set({ rememberWindowPosition: value });
  },

  toggleLeftPanel: () => {
    set((s) => ({ showLeftPanel: !s.showLeftPanel }));
  },

  toggleRightPanel: () => {
    set((s) => ({ showRightPanel: !s.showRightPanel }));
  },

  loadPanelVisibility: (left, right) => {
    set({ showLeftPanel: left, showRightPanel: right });
  },

  startRenamingThread: (threadId) => {
    const wasHidden = !get().showLeftPanel;
    set({ renamingThreadId: threadId, showLeftPanel: true, sidebarOpenedForRename: wasHidden });
  },

  clearRenamingThread: () => {
    set({ renamingThreadId: null });
  },

  openSkillsManager: () => set({ skillsManagerOpen: true }),
  closeSkillsManager: () => set({ skillsManagerOpen: false }),
  openPresetsManager: () => set({ presetsManagerOpen: true }),
  closePresetsManager: () => set({ presetsManagerOpen: false }),

  // Scheduled jobs actions

  addScheduledJob: (projectId, jobData) => {
    const id = crypto.randomUUID();
    const job: ScheduledJob = {
      ...jobData,
      id,
      createdAt: Date.now(),
    };
    set((s) => ({
      scheduledJobs: [...s.scheduledJobs, job],
      activeJobId: id,
      activeThreadId: null,
      activeProjectId: projectId,
      ...(s.activeProjectId !== projectId ? { selectedEnvPath: null } : {}),
    }));
    return job;
  },

  updateScheduledJob: (jobId, updates) => {
    set((s) => ({
      scheduledJobs: s.scheduledJobs.map((j) =>
        j.id === jobId ? { ...j, ...updates } : j,
      ),
    }));
  },

  removeScheduledJob: (jobId) => {
    set((s) => ({
      scheduledJobs: s.scheduledJobs.filter((j) => j.id !== jobId),
      activeJobId: s.activeJobId === jobId ? null : s.activeJobId,
    }));
  },

  setActiveJob: (jobId) => {
    const job = get().scheduledJobs.find((j) => j.id === jobId);
    if (!job) return;
    const prevProjectId = get().activeProjectId;
    set({
      activeJobId: jobId,
      activeThreadId: null,
      activeProjectId: job.projectId,
      ...(job.projectId !== prevProjectId ? { selectedEnvPath: null } : {}),
    });
  },

  getProjectJobs: (projectId) => {
    return get().scheduledJobs.filter((j) => j.projectId === projectId);
  },

  loadScheduledJobs: (jobs) => {
    set({ scheduledJobs: jobs });
  },

  // Launch presets actions

  addLaunchPreset: (presetData) => {
    const preset: LaunchPreset = {
      ...presetData,
      id: crypto.randomUUID(),
    };
    set((s) => ({ launchPresets: [...s.launchPresets, preset] }));
    return preset;
  },

  updateLaunchPreset: (id, updates) => {
    set((s) => ({
      launchPresets: s.launchPresets.map((p) =>
        p.id === id ? { ...p, ...updates } : p,
      ),
    }));
  },

  removeLaunchPreset: (id) => {
    set((s) => ({
      launchPresets: s.launchPresets.filter((p) => p.id !== id),
    }));
  },

  loadLaunchPresets: (presets) => {
    set({ launchPresets: presets });
  },

  // Beta features actions

  setBetaFeature: (key, value) => {
    if (key === "scheduledJobs" && !value) {
      // Disabling scheduled jobs: remember which were enabled, then disable all
      const enabledIds = get().scheduledJobs.filter((j) => j.enabled).map((j) => j.id);
      set((s) => ({
        betaFeatures: { ...s.betaFeatures, scheduledJobs: false },
        autoDisabledJobIds: enabledIds,
        scheduledJobs: s.scheduledJobs.map((j) => j.enabled ? { ...j, enabled: false } : j),
      }));
    } else if (key === "scheduledJobs" && value) {
      // Re-enabling: restore previously auto-disabled jobs
      const toReEnable = new Set(get().autoDisabledJobIds);
      set((s) => ({
        betaFeatures: { ...s.betaFeatures, scheduledJobs: true },
        autoDisabledJobIds: [],
        scheduledJobs: s.scheduledJobs.map((j) => toReEnable.has(j.id) ? { ...j, enabled: true } : j),
      }));
    } else {
      set((s) => ({
        betaFeatures: { ...s.betaFeatures, [key]: value },
      }));
    }
  },

  loadBetaFeatures: (features) => {
    // Merge over defaults so flags added in newer versions default to off
    // rather than `undefined` when loading an older persisted object.
    const defaults: BetaFeatures = { codexThreads: false, skillsPlugins: false, scheduledJobs: false };
    set({ betaFeatures: { ...defaults, ...features } });
  },

  loadAutoDisabledJobIds: (ids) => {
    set({ autoDisabledJobIds: ids });
  },

  openBetaFeatures: () => set({ betaFeaturesOpen: true }),
  closeBetaFeatures: () => set({ betaFeaturesOpen: false }),

  reportGitTiming: (projectPath, durationMs) => {
    if (durationMs < SLOW_GIT_MS) {
      gitSlowStreaks.delete(projectPath);
      return;
    }
    const streak = (gitSlowStreaks.get(projectPath) ?? 0) + 1;
    gitSlowStreaks.set(projectPath, streak);
    if (streak < SLOW_GIT_STREAK || get().repoHealthFlagged[projectPath]) return;
    set((s) => ({
      repoHealthFlagged: { ...s.repoHealthFlagged, [projectPath]: true },
    }));
  },

  setRepoHealth: (projectPath, health) => {
    set((s) => ({
      repoHealth: { ...s.repoHealth, [projectPath]: health },
    }));
  },

  dismissRepoHealth: (projectPath) => {
    const health = get().repoHealth[projectPath];
    set((s) => ({
      repoHealthDismissals: {
        ...s.repoHealthDismissals,
        [projectPath]: {
          dismissedAt: Date.now(),
          statusDurationMs: health?.status_duration_ms ?? 0,
        },
      },
    }));
  },

  loadRepoHealthDismissals: (dismissals) => {
    set({ repoHealthDismissals: dismissals });
  },

  loadProjects: (projects) => {
    set({
      projects,
      activeProjectId: projects.length > 0 ? projects[0].id : null,
    });
  },

  loadExpandedPaths: (expandedPaths) => {
    set({ expandedPaths });
  },

  loadThreads: (persisted) => {
    const threads: Thread[] = persisted.map((pt) => ({
      ...pt,
      sessionId: null,
      state: "dormant" as const,
      resuming: false,
      lastActivityAt: pt.lastActivityAt ?? 0,
      extraArgs: pt.extraArgs ?? null,
    }));
    set({ threads });
  },
}));
