import { create } from "zustand";
import type {
  RegistrySource,
  Installation,
  ScannedItem,
} from "./skillsPluginsTypes";

interface SkillsPluginsState {
  sources: Record<string, RegistrySource>;
  installations: Record<string, Installation>;
  scanResults: ScannedItem[];
  fetchState: "idle" | "fetching" | "detecting" | "error";
  updateCheckState: "idle" | "checking" | "done";

  // Actions
  loadRegistry: (data: { sources: Record<string, RegistrySource>; installations: Record<string, Installation> }) => void;
  addSource: (source: RegistrySource) => void;
  removeSource: (sourceId: string) => void;
  updateSource: (sourceId: string, updates: Partial<RegistrySource>) => void;
  addInstallation: (installation: Installation) => void;
  removeInstallation: (installationId: string) => void;
  updateInstallation: (installationId: string, updates: Partial<Installation>) => void;
  setFetchState: (state: "idle" | "fetching" | "detecting" | "error") => void;
  setUpdateCheckState: (state: "idle" | "checking" | "done") => void;
  setScanResults: (results: ScannedItem[]) => void;

  // Helpers
  getInstallationsForProject: (projectPath: string) => Installation[];
  getGlobalInstallations: () => Installation[];
  getSourceInstallations: (sourceId: string) => Installation[];
  getInstalledItemNames: (projectPath?: string) => string[];
  getUpdateCount: () => number;
  getItemCounts: (projectPath?: string) => Record<string, number>;
}

export const useSkillsPluginsStore = create<SkillsPluginsState>((set, get) => ({
  sources: {},
  installations: {},
  scanResults: [],
  fetchState: "idle",
  updateCheckState: "idle",

  loadRegistry: (data) => {
    set({
      sources: data.sources ?? {},
      installations: data.installations ?? {},
    });
  },

  addSource: (source) => {
    set((s) => ({
      sources: { ...s.sources, [source.id]: source },
    }));
  },

  removeSource: (sourceId) => {
    set((s) => {
      const next = { ...s.sources };
      delete next[sourceId];
      return { sources: next };
    });
  },

  updateSource: (sourceId, updates) => {
    set((s) => {
      const existing = s.sources[sourceId];
      if (!existing) return s;
      return {
        sources: { ...s.sources, [sourceId]: { ...existing, ...updates } },
      };
    });
  },

  addInstallation: (installation) => {
    set((s) => ({
      installations: { ...s.installations, [installation.id]: installation },
    }));
  },

  removeInstallation: (installationId) => {
    set((s) => {
      const next = { ...s.installations };
      delete next[installationId];
      return { installations: next };
    });
  },

  updateInstallation: (installationId, updates) => {
    set((s) => {
      const existing = s.installations[installationId];
      if (!existing) return s;
      return {
        installations: {
          ...s.installations,
          [installationId]: { ...existing, ...updates },
        },
      };
    });
  },

  setFetchState: (fetchState) => set({ fetchState }),
  setUpdateCheckState: (updateCheckState) => set({ updateCheckState }),
  setScanResults: (scanResults) => set({ scanResults }),

  getInstallationsForProject: (projectPath) => {
    return Object.values(get().installations).filter(
      (i) => i.target === "Project" && i.projectPath === projectPath,
    );
  },

  getGlobalInstallations: () => {
    return Object.values(get().installations).filter((i) => i.target === "Global");
  },

  getSourceInstallations: (sourceId) => {
    return Object.values(get().installations).filter((i) => i.sourceId === sourceId);
  },

  getInstalledItemNames: (projectPath?: string) => {
    const all = Object.values(get().installations);
    const global = all.filter((i) => i.target === "Global");
    const project = projectPath
      ? all.filter((i) => i.target === "Project" && i.projectPath === projectPath)
      : [];
    return [...global, ...project].map((i) => i.itemName);
  },

  getUpdateCount: () => {
    return Object.values(get().sources).filter((s) => s.updateAvailable).length;
  },

  getItemCounts: (projectPath?: string) => {
    const all = Object.values(get().installations);
    const relevant = all.filter(
      (i) =>
        i.target === "Global" ||
        (i.target === "Project" && i.projectPath === projectPath),
    );
    const counts: Record<string, number> = {};
    for (const item of relevant) {
      const key = item.itemType.toLowerCase() + "s";
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  },
}));
