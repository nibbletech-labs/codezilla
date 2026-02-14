import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../store/appStore";
import { FONT_SIZE_DEFAULT, FONT_SIZE_MIN, FONT_SIZE_MAX, FONT_SIZE_STEP } from "../lib/constants";
import type { ThreadType } from "../store/types";
import type { AccentColorId, AppearanceMode } from "../lib/themes";
import { ACCENT_COLORS } from "../lib/themes";

const VALID_ACCENT_IDS = new Set(ACCENT_COLORS.map((c) => c.id));
const VALID_APPEARANCES: AppearanceMode[] = ["dark", "light", "system"];

export function useMenuEvents() {
  useEffect(() => {
    const unlisten = listen<string>("menu-event", (event) => {
      const id = event.payload;
      const state = useAppStore.getState();

      switch (id) {
        case "zoom-in":
          state.setBaseFontSize(Math.min(state.baseFontSize + FONT_SIZE_STEP, FONT_SIZE_MAX));
          break;
        case "zoom-out":
          state.setBaseFontSize(Math.max(state.baseFontSize - FONT_SIZE_STEP, FONT_SIZE_MIN));
          break;
        case "zoom-reset":
          state.setBaseFontSize(FONT_SIZE_DEFAULT);
          break;
        case "remember-window-position":
          state.setRememberWindowPosition(!state.rememberWindowPosition);
          break;
        case "toggle-left-panel":
          state.toggleLeftPanel();
          break;
        case "toggle-right-panel":
          state.toggleRightPanel();
          break;
        case "new-thread-claude":
        case "new-thread-codex":
        case "new-thread-shell": {
          const projectId = state.activeProjectId;
          if (projectId) {
            const threadType = id.slice("new-thread-".length) as ThreadType;
            state.addThread(projectId, threadType);
          }
          break;
        }
        case "remove-thread": {
          if (state.activeThreadId) {
            state.removeThread(state.activeThreadId);
          }
          break;
        }
        default:
          if (id.startsWith("appearance-")) {
            const mode = id.slice("appearance-".length) as AppearanceMode;
            if (VALID_APPEARANCES.includes(mode)) {
              state.setAppearanceMode(mode);
            }
          } else if (id.startsWith("accent-")) {
            const colorId = id.slice("accent-".length) as AccentColorId;
            if (VALID_ACCENT_IDS.has(colorId)) {
              state.setAccentColorId(colorId);
            }
          }
          break;
      }
    });

    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);
}
