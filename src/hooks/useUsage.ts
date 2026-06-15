import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../store/appStore";
import { getUsageSnapshot, startUsageTracking, stopUsageTracking } from "../lib/tauri";
import type { UsageSnapshot } from "../store/usageTypes";

/**
 * Drives the plan-usage tracker: starts the backend refresher, primes the store
 * with the cached snapshot, and subscribes to `usage-updated` events. The
 * refresher is cheap and self-degrading (agents with no subscription report
 * `na` and are hidden), so it runs for everyone; unmount stops it.
 */
export function useUsage() {
  const setUsage = useAppStore((s) => s.setUsage);

  useEffect(() => {
    let cancelled = false;

    startUsageTracking().catch(() => { /* best-effort */ });
    getUsageSnapshot()
      .then((snap) => { if (!cancelled) setUsage(snap); })
      .catch(() => { /* no snapshot yet */ });

    const unlistenPromise = listen<UsageSnapshot>("usage-updated", (event) => {
      if (cancelled) return;
      setUsage(event.payload);
    });

    return () => {
      cancelled = true;
      unlistenPromise.then((fn) => fn()).catch(() => { /* ignore */ });
      stopUsageTracking().catch(() => { /* ignore */ });
    };
  }, [setUsage]);
}
