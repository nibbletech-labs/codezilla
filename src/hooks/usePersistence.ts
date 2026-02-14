import { useEffect, useRef } from "react";
import { load } from "@tauri-apps/plugin-store";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store/appStore";
import type { Project, PersistedThread } from "../store/types";
import type { AccentColorId, AppearanceMode } from "../lib/themes";

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
  }, [loadProjects, loadExpandedPaths, loadThreads, loadBaseFontSize, loadAccentColorId, loadAppearanceMode, loadRememberWindowPosition, loadPanelVisibility]);

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

  // Save when projects change
  useEffect(() => {
    if (!initialized.current) return;
    (async () => {
      try {
        const store = await load(STORE_FILE);
        await store.set(PROJECTS_KEY, projects);
        debouncedSave(store);
      } catch (e) {
        console.error("Failed to persist state:", e);
      }
    })();
  }, [projects]);

  // Save when expanded paths change
  useEffect(() => {
    if (!initialized.current) return;
    (async () => {
      try {
        const store = await load(STORE_FILE);
        await store.set(EXPANDED_PATHS_KEY, expandedPaths);
        debouncedSave(store);
      } catch (e) {
        console.error("Failed to persist expanded paths:", e);
      }
    })();
  }, [expandedPaths]);

  // Save when font size changes
  useEffect(() => {
    if (!initialized.current) return;
    (async () => {
      try {
        const store = await load(STORE_FILE);
        await store.set(FONT_SIZE_KEY, baseFontSize);
        debouncedSave(store);
      } catch (e) {
        console.error("Failed to persist font size:", e);
      }
    })();
  }, [baseFontSize]);

  // Save when accent color changes + sync Rust menu ticks
  useEffect(() => {
    if (!initialized.current) return;
    invoke("sync_accent_menu", { colorId: accentColorId }).catch(() => {});
    (async () => {
      try {
        const store = await load(STORE_FILE);
        await store.set(ACCENT_COLOR_KEY, accentColorId);
        debouncedSave(store);
      } catch (e) {
        console.error("Failed to persist accent color:", e);
      }
    })();
  }, [accentColorId]);

  // Save when appearance mode changes + sync Rust menu ticks
  useEffect(() => {
    if (!initialized.current) return;
    invoke("sync_appearance_menu", { mode: appearanceMode }).catch(() => {});
    (async () => {
      try {
        const store = await load(STORE_FILE);
        await store.set(APPEARANCE_MODE_KEY, appearanceMode);
        debouncedSave(store);
      } catch (e) {
        console.error("Failed to persist appearance mode:", e);
      }
    })();
  }, [appearanceMode]);

  // Save when remember window position changes + sync Rust menu checkbox
  useEffect(() => {
    if (!initialized.current) return;
    invoke("sync_remember_window_position", { checked: rememberWindowPosition }).catch(() => {});
    (async () => {
      try {
        const store = await load(STORE_FILE);
        await store.set(REMEMBER_WINDOW_KEY, rememberWindowPosition);
        debouncedSave(store);
      } catch (e) {
        console.error("Failed to persist remember window position:", e);
      }
    })();
  }, [rememberWindowPosition]);

  // Save when panel visibility changes
  useEffect(() => {
    if (!initialized.current) return;
    (async () => {
      try {
        const store = await load(STORE_FILE);
        await store.set(SHOW_LEFT_PANEL_KEY, showLeftPanel);
        await store.set(SHOW_RIGHT_PANEL_KEY, showRightPanel);
        debouncedSave(store);
      } catch (e) {
        console.error("Failed to persist panel visibility:", e);
      }
    })();
  }, [showLeftPanel, showRightPanel]);

  // Save when threads change (strip runtime-only fields)
  useEffect(() => {
    if (!initialized.current) return;
    // Skip saving empty array until persistence has loaded (protects against HMR store resets)
    if (threads.length === 0 && !threadsLoaded.current) return;
    (async () => {
      try {
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
        const store = await load(STORE_FILE);
        await store.set(THREADS_KEY, persisted);
        debouncedSave(store);
      } catch (e) {
        console.error("Failed to persist threads:", e);
      }
    })();
  }, [threads]);
}
