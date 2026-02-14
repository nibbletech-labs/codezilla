import { create } from "zustand";
import type { Project, Thread, ThreadType, PersistedThread, PreviewTarget } from "./types";
import { THREAD_LABELS } from "./types";
import type { TranscriptInfo } from "./transcriptTypes";
import type { AccentColorId, AppearanceMode } from "../lib/themes";

const MAX_EXITED_THREADS_PER_PROJECT = 200;

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
  transcriptInfo: Record<string, TranscriptInfo>;
  baseFontSize: number;
  accentColorId: AccentColorId;
  appearanceMode: AppearanceMode;
  rememberWindowPosition: boolean;
  showLeftPanel: boolean;
  showRightPanel: boolean;
  renamingThreadId: string | null;
  sidebarOpenedForRename: boolean;

  // Preview / selection actions
  openPreview: (path: string, line?: number) => void;
  openCommitPreview: (hash: string) => void;
  closePreview: () => void;
  selectFileInTree: (path: string) => void;
  setFileIndex: (index: Set<string>) => void;
  showFilePicker: (candidates: string[], position: { x: number; y: number }, line?: number, col?: number) => void;
  closeFilePicker: () => void;
  updateTranscriptInfo: (threadId: string, info: TranscriptInfo) => void;
  clearTranscriptInfo: (threadId: string) => void;

  // Project actions
  addProject: (path: string, name: string) => void;
  removeProject: (projectId: string) => void;
  setActiveProject: (projectId: string) => void;
  toggleProjectExpanded: (projectId: string) => void;

  // Thread actions
  addThread: (projectId: string, type: ThreadType) => Thread;
  removeThread: (threadId: string) => void;
  setActiveThread: (threadId: string) => void;
  renameThread: (threadId: string, name: string) => void;
  markThreadExited: (threadId: string, exitCode: number | null) => void;
  resumeThread: (threadId: string) => string;
  newSession: (threadId: string) => string;
  setCodexThreadId: (threadId: string, codexThreadId: string) => void;
  touchThread: (threadId: string) => void;

  markProjectMissing: (projectId: string, missing: boolean) => void;

  // File tree actions
  toggleExpandedPath: (projectId: string, path: string) => void;
  getExpandedPaths: (projectId: string) => Set<string>;

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
  transcriptInfo: {},
  baseFontSize: 14,
  accentColorId: "green",
  appearanceMode: "dark",
  rememberWindowPosition: true,
  showLeftPanel: true,
  showRightPanel: true,
  renamingThreadId: null,
  sidebarOpenedForRename: false,

  openPreview: (path, line) => {
    set({ previewFile: { kind: "file", path, line } });
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

  updateTranscriptInfo: (threadId, info) => {
    set((s) => ({
      transcriptInfo: { ...s.transcriptInfo, [threadId]: info },
    }));
  },

  clearTranscriptInfo: (threadId) => {
    set((s) => {
      const next = { ...s.transcriptInfo };
      delete next[threadId];
      return { transcriptInfo: next };
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
      activeProjectId: s.activeProjectId ?? project.id,
    }));
  },

  removeProject: (projectId) => {
    set((s) => {
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

      return {
        projects: remainingProjects,
        threads: remainingThreads,
        expandedPaths: nextExpandedPaths,
        activeProjectId:
          s.activeProjectId === projectId
            ? (remainingProjects[0]?.id ?? null)
            : s.activeProjectId,
        activeThreadId: removedThreadActive ? null : s.activeThreadId,
      };
    });
  },

  setActiveProject: (projectId) => {
    set({ activeProjectId: projectId, activeThreadId: null });
  },

  toggleProjectExpanded: (projectId) => {
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === projectId ? { ...p, expanded: !p.expanded } : p,
      ),
    }));
  },

  addThread: (projectId, type) => {
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
      };

      let newThreads = [...s.threads, thread];

      // Prune oldest exited/dormant threads per project if over limit
      const projectThreads = newThreads.filter(t => t.projectId === projectId);
      const exited = projectThreads
        .filter(t => t.state === "exited" || t.state === "dormant")
        .sort((a, b) => a.lastActivityAt - b.lastActivityAt);
      const excess = exited.length - MAX_EXITED_THREADS_PER_PROJECT;
      if (excess > 0) {
        const toRemove = new Set(exited.slice(0, excess).map(t => t.id));
        newThreads = newThreads.filter(t => !toRemove.has(t.id));
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
        activeProjectId: projectId,
      };
    });
    return thread;
  },

  removeThread: (threadId) => {
    set((s) => {
      if (s.activeThreadId !== threadId) {
        return { threads: s.threads.filter((t) => t.id !== threadId) };
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
      };
    });
  },

  setActiveThread: (threadId) => {
    const thread = get().threads.find((t) => t.id === threadId);
    if (!thread) return;
    // Clear badge when switching to this thread (like marking email as read)
    const info = get().transcriptInfo[threadId];
    const transcriptUpdate: Record<string, TranscriptInfo> = {};
    if (info && info.badge != null) {
      transcriptUpdate[threadId] = { ...info, badge: null, badgeSince: null };
    }
    set({
      activeThreadId: threadId,
      activeProjectId: thread.projectId,
      ...(Object.keys(transcriptUpdate).length > 0
        ? { transcriptInfo: { ...get().transcriptInfo, ...transcriptUpdate } }
        : {}),
    });
  },

  renameThread: (threadId, name) => {
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === threadId ? { ...t, name } : t,
      ),
    }));
  },

  markThreadExited: (threadId, exitCode) => {
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === threadId ? { ...t, state: "exited" as const, exitCode, lastActivityAt: Date.now() } : t,
      ),
      activeThreadId: s.activeThreadId === threadId ? null : s.activeThreadId,
    }));
  },

  resumeThread: (threadId) => {
    const newSessionId = crypto.randomUUID();
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === threadId
          ? { ...t, sessionId: newSessionId, state: "running" as const, exitCode: null, resuming: true, lastActivityAt: Date.now() }
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

  touchThread: (threadId) => {
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === threadId ? { ...t, lastActivityAt: Date.now() } : t,
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

  getExpandedPaths: (projectId) => {
    return new Set(get().expandedPaths[projectId] ?? []);
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
    }));
    set({ threads });
  },
}));
