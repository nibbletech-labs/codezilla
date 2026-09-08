import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../store/appStore";
import { havenGraph, havenStatusDbPath, havenWatchStore } from "../lib/haven";
import type { HavenGraph } from "../lib/havenTypes";
import { HavenLiveController } from "../lib/havenLive";

/**
 * A module-level handle on the live controller so the refresh button (and
 * CZ-47's header refresh) can ask for a read without threading the controller
 * through the tree. Reassigned on every construction and nulled on dispose, so
 * StrictMode's mount / unmount / mount always leaves it on the live one.
 */
let controllerHandle: HavenLiveController<HavenGraph> | null = null;

/** Refresh one Haven project now. A no-op when nothing is live. */
export function refreshHavenGraph(key: string): void {
  controllerHandle?.refresh(key);
}

/** Every distinct Haven key the open projects are bound to. */
function linkedKeysOf(projects: { havenProjectKey?: string }[]): string[] {
  const keys = new Set<string>();
  for (const p of projects) if (p.havenProjectKey) keys.add(p.havenProjectKey);
  return [...keys].sort();
}

/**
 * Keeps every linked project's graph current (spec section 10). Mounted once,
 * beside `useHavenDetect`.
 *
 * The controller does the sequencing that matters - subscribe, then register
 * the store watcher, then read - and owns the 500ms/2s (visible) and 2s/5s
 * (hidden) schedules. This hook only feeds it the two facts it cannot know:
 * which projects are linked, and which one is on screen.
 */
export function useHavenLive() {
  const havenInstalled = useAppStore((s) => s.havenInstalled);

  useEffect(() => {
    if (havenInstalled !== true) return;

    const store = useAppStore.getState;
    const controller = new HavenLiveController<HavenGraph>({
      listen: async (onStoreChanged) => {
        const unlisten = await listen("haven-graph-changed", () => onStoreChanged());
        return unlisten;
      },
      statusDbPath: havenStatusDbPath,
      watchStore: havenWatchStore,
      read: havenGraph,
      onResult: (key, result) => {
        if ("graph" in result) store().setHavenGraph(key, result.graph, Date.now());
        else store().setHavenGraphError(key, result.error);
      },
      onReading: (key, reading) => store().setHavenGraphReading(key, reading),
    });
    controllerHandle = controller;

    const visibleKeyOf = (state: ReturnType<typeof store>): string | null => {
      if (document.hidden || !state.activeBacklogProjectId) return null;
      const project = state.projects.find((p) => p.id === state.activeBacklogProjectId);
      return project?.havenProjectKey ?? null;
    };

    let lastKeys = "";
    let lastVisible: string | null = null;
    const sync = () => {
      const state = store();
      const keys = linkedKeysOf(state.projects);
      const joined = keys.join(" ");
      if (joined !== lastKeys) {
        lastKeys = joined;
        controller.setLinkedKeys(keys);
      }
      const visible = visibleKeyOf(state);
      if (visible !== lastVisible) {
        lastVisible = visible;
        controller.setVisibleKey(visible);
      }
    };

    sync();
    controller
      .start()
      .catch((e) => console.warn("haven: live controller failed to start", e));
    const unsubscribe = useAppStore.subscribe(sync);
    document.addEventListener("visibilitychange", sync);

    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", sync);
      controller.dispose();
      if (controllerHandle === controller) controllerHandle = null;
    };
  }, [havenInstalled]);
}
