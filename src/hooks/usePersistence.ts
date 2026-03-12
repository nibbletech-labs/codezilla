import { useEffect, useRef } from "react";
import { load } from "@tauri-apps/plugin-store";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store/appStore";
import { useSkillsPluginsStore } from "../store/skillsPluginsStore";
import type { Project, PersistedThread, ScheduledJob } from "../store/types";
import type { SkillsPluginsRegistry } from "../store/skillsPluginsTypes";
import type { AccentColorId, AppearanceMode } from "../lib/themes";
import { syncLaunchdEntries } from "../lib/launchdSync";
import { checkRegistryUpdates, reconcileInstalledItems } from "../lib/skillsSync";

const STORE_FILE = "codezilla-config.json";
const PROJECTS_KEY = "projects";
const EXPANDED_PATHS_KEY = "expandedPaths";
const THREADS_KEY = "threads";
const FONT_SIZE_KEY = "baseFontSize";
const ACCENT_COLOR_KEY = "accentColor";
const APPEARANCE_MODE_KEY = "appearanceMode";
const REMEMBER_WINDOW_KEY = "rememberWindowPosition";
const SHOW_LEFT_PANEL_KEY = "showLeftPanel";
const SHOW_RIGHT_PANEL_KEY = "showRightPanel";
const SCHEDULED_JOBS_KEY = "scheduledJobs";
const SKILLS_PLUGINS_KEY = "skillsPluginsRegistry";

let pendingSave: ReturnType<typeof setTimeout> | null = null;
let lastStore: Awaited<ReturnType<typeof load>> | null = null;
const SAVE_DEBOUNCE_MS = 2000;

function debouncedSave(store: Awaited<ReturnType<typeof load>>) {
  lastStore = store;
  if (pendingSave) clearTimeout(pendingSave);
  pendingSave = setTimeout(async () => {
    try { await store.save(); } catch (e) { console.error("Failed to save store:", e); }
    pendingSave = null;
  }, SAVE_DEBOUNCE_MS);
}

function flushPendingSave() {
  if (pendingSave) {
    clearTimeout(pendingSave);
    pendingSave = null;
  }
  if (lastStore) {
    lastStore.save().catch((e) => console.error("Failed to flush store on quit:", e));
  }
}

export function usePersistence() {
  const projects = useAppStore((s) => s.projects);
  const threads = useAppStore((s) => s.threads);
  const expandedPaths = useAppStore((s) => s.expandedPaths);
  const baseFontSize = useAppStore((s) => s.baseFontSize);
  const accentColorId = useAppStore((s) => s.accentColorId);
  const appearanceMode = useAppStore((s) => s.appearanceMode);
  const rememberWindowPosition = useAppStore((s) => s.rememberWindowPosition);
  const showLeftPanel = useAppStore((s) => s.showLeftPanel);
  const showRightPanel = useAppStore((s) => s.showRightPanel);
  const scheduledJobs = useAppStore((s) => s.scheduledJobs);
  const loadScheduledJobs = useAppStore((s) => s.loadScheduledJobs);
  const skillsSources = useSkillsPluginsStore((s) => s.sources);
  const skillsInstallations = useSkillsPluginsStore((s) => s.installations);
  const loadProjects = useAppStore((s) => s.loadProjects);
  const loadExpandedPaths = useAppStore((s) => s.loadExpandedPaths);
  const loadThreads = useAppStore((s) => s.loadThreads);
  const loadBaseFontSize = useAppStore((s) => s.loadBaseFontSize);
  const loadAccentColorId = useAppStore((s) => s.loadAccentColorId);
  const loadAppearanceMode = useAppStore((s) => s.loadAppearanceMode);
  const loadRememberWindowPosition = useAppStore((s) => s.loadRememberWindowPosition);
  const loadPanelVisibility = useAppStore((s) => s.loadPanelVisibility);
  const initialized = useRef(false);
  const threadsLoaded = useRef(false);

  // Load on mount
  useEffect(() => {
    (async () => {
      try {
        const store = await load(STORE_FILE);
        const saved = await store.get<Project[]>(PROJECTS_KEY);
        if (saved && saved.length > 0) {
          loadProjects(saved);
        }

        const savedPaths = await store.get<Record<string, string[]>>(EXPANDED_PATHS_KEY);
        if (savedPaths) {
          loadExpandedPaths(savedPaths);
        }

        const savedThreads = await store.get<PersistedThread[]>(THREADS_KEY);
        if (savedThreads && savedThreads.length > 0) {
          loadThreads(savedThreads);
        }
        threadsLoaded.current = true;

        const savedJobs = await store.get<ScheduledJob[]>(SCHEDULED_JOBS_KEY);
        if (savedJobs && savedJobs.length > 0) {
          loadScheduledJobs(savedJobs);
        }
        // Always sync launchd agents with persisted jobs
        if (saved && saved.length > 0) {
          syncLaunchdEntries(savedJobs ?? [], saved).catch(console.error);
        }

        // Load skills/plugins registry
        const savedRegistry = await store.get<SkillsPluginsRegistry>(SKILLS_PLUGINS_KEY);
        if (savedRegistry) {
          useSkillsPluginsStore.getState().loadRegistry(savedRegistry);
        }
        // Check for updates and reconcile on startup
        const activeProjectPath = saved?.[0]?.path;
        checkRegistryUpdates().catch(console.error);
        reconcileInstalledItems(activeProjectPath).catch(console.error);

        const savedFontSize = await store.get<number>(FONT_SIZE_KEY);
        if (savedFontSize != null) {
          loadBaseFontSize(savedFontSize);
        }

        const savedAccent = await store.get<AccentColorId>(ACCENT_COLOR_KEY);
        if (savedAccent) {
          loadAccentColorId(savedAccent);
        }
        invoke("sync_accent_menu", { colorId: savedAccent ?? "green" }).catch(() => {});

        const savedAppearance = await store.get<AppearanceMode>(APPEARANCE_MODE_KEY);
        if (savedAppearance) {
          loadAppearanceMode(savedAppearance);
        }
        invoke("sync_appearance_menu", { mode: savedAppearance ?? "dark" }).catch(() => {});

        const savedLeftPanel = await store.get<boolean>(SHOW_LEFT_PANEL_KEY);
        const savedRightPanel = await store.get<boolean>(SHOW_RIGHT_PANEL_KEY);
        loadPanelVisibility(savedLeftPanel ?? true, savedRightPanel ?? true);

        const savedRemember = await store.get<boolean>(REMEMBER_WINDOW_KEY);
        if (savedRemember != null) {
          loadRememberWindowPosition(savedRemember);
          invoke("sync_remember_window_position", { checked: savedRemember }).catch(() => {});
          if (!savedRemember) {
            try {
              const win = getCurrentWindow();
              await win.setSize(new (await import("@tauri-apps/api/dpi")).LogicalSize(1200, 800));
              await win.center();
            } catch (e) {
              console.error("Failed to reset window position:", e);
            }
          }
        }
      } catch (e) {
        console.error("Failed to load persisted state:", e);
      }
      initialized.current = true;
    })();
  }, [loadProjects, loadExpandedPaths, loadThreads, loadScheduledJobs, loadBaseFontSize, loadAccentColorId, loadAppearanceMode, loadRememberWindowPosition, loadPanelVisibility]);

  // Flush pending saves on window close
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    getCurrentWindow()
      .onCloseRequested(() => {
        flushPendingSave();
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => {
      unlisten?.();
    };
  }, []);

  // Persist all fields in a single effect (one load, one debounced save)
  useEffect(() => {
    if (!initialized.current) return;
    (async () => {
      try {
        const store = await load(STORE_FILE);
        await store.set(PROJECTS_KEY, projects);
        await store.set(EXPANDED_PATHS_KEY, expandedPaths);
        await store.set(FONT_SIZE_KEY, baseFontSize);
        await store.set(ACCENT_COLOR_KEY, accentColorId);
        await store.set(APPEARANCE_MODE_KEY, appearanceMode);
        await store.set(REMEMBER_WINDOW_KEY, rememberWindowPosition);
        await store.set(SHOW_LEFT_PANEL_KEY, showLeftPanel);
        await store.set(SHOW_RIGHT_PANEL_KEY, showRightPanel);
        await store.set(SCHEDULED_JOBS_KEY, scheduledJobs);
        await store.set(SKILLS_PLUGINS_KEY, { sources: skillsSources, installations: skillsInstallations });
        // Guard threads against HMR store resets wiping persisted data
        if (threads.length > 0 || threadsLoaded.current) {
          const persisted: PersistedThread[] = threads.map((t) => ({
            id: t.id,
            projectId: t.projectId,
            type: t.type,
            name: t.name,
            claudeSessionId: t.claudeSessionId,
            codexThreadId: t.codexThreadId,
            exitCode: t.exitCode,
            lastActivityAt: t.lastActivityAt,
          }));
          await store.set(THREADS_KEY, persisted);
        }
        debouncedSave(store);
      } catch (e) {
        console.error("Failed to persist state:", e);
      }
    })();
  }, [projects, expandedPaths, threads, scheduledJobs, skillsSources, skillsInstallations, baseFontSize, accentColorId, appearanceMode, rememberWindowPosition, showLeftPanel, showRightPanel]);

  // Sync Rust menu state (separate from persistence — these only need their specific dep)
  useEffect(() => {
    if (!initialized.current) return;
    invoke("sync_accent_menu", { colorId: accentColorId }).catch(() => {});
  }, [accentColorId]);

  useEffect(() => {
    if (!initialized.current) return;
    invoke("sync_appearance_menu", { mode: appearanceMode }).catch(() => {});
  }, [appearanceMode]);

  useEffect(() => {
    if (!initialized.current) return;
    invoke("sync_remember_window_position", { checked: rememberWindowPosition }).catch(() => {});
  }, [rememberWindowPosition]);
}
