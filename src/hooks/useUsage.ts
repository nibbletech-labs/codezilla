import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../store/appStore";
import {
  getUsageSnapshot,
  reportUsageActivity,
  startUsageTracking,
  stopUsageTracking,
} from "../lib/tauri";
import type { UsageSnapshot } from "../store/usageTypes";
import { usageActivity } from "../lib/usageActivity";

/** Cached measurements remain visible while the backend refreshes each provider. */
export function useUsage() {
  const setUsage = useAppStore((s) => s.setUsage);

  useEffect(() => {
    let cancelled = false;
    let receivedUpdate = false;

    let started = false;
    // Subscribe before starting workers so a fast cache restore cannot be lost.
    const unlistenPromise = listen<UsageSnapshot>("usage-updated", (event) => {
      if (cancelled) return;
      receivedUpdate = true;
      setUsage(event.payload);
    });
    unlistenPromise.then(async () => {
      if (cancelled) return;
      started = true;
      await startUsageTracking();
      if (cancelled) return;
      const snapshot = await getUsageSnapshot();
      if (!cancelled && !receivedUpdate) setUsage(snapshot);
    }).catch(() => { /* best-effort */ });

    return () => {
      cancelled = true;
      unlistenPromise.then((fn) => fn()).catch(() => { /* ignore */ });
      if (started) stopUsageTracking().catch(() => { /* ignore */ });
    };
  }, [setUsage]);

  useEffect(() => {
    const lastWorking = new Map<string, number>();
    const beat = () => {
      const state = useAppStore.getState();
      const activity = usageActivity(state.threads, state.transcriptInfo, lastWorking, Date.now());
      for (const agent of ["claude", "codex"] as const) {
        reportUsageActivity(agent, activity[agent]).catch(() => { /* best-effort */ });
      }
    };
    beat();
    // Capture short turns as well as long, quiet work. Store updates maintain
    // local timestamps; only the timer sends backend heartbeats.
    const unsubscribe = useAppStore.subscribe((state) => {
      usageActivity(state.threads, state.transcriptInfo, lastWorking, Date.now());
    });
    const id = setInterval(beat, 15_000);
    const onVisible = () => { if (!document.hidden) beat(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
}
