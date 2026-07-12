import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../store/appStore";
import {
  getUsageSnapshot,
  reportUsageActivity,
  requestUsageRefresh,
  startUsageTracking,
  stopUsageTracking,
} from "../lib/tauri";
import type { UsageSnapshot } from "../store/usageTypes";

/** A Claude thread counts as active if it saw activity within this window. */
const ACTIVITY_WINDOW_MS = 10 * 60_000;
/** Consider the snapshot stale for the visibility catch-up beyond this age. */
const STALE_AFTER_SECS = 300;

/**
 * Drives the plan-usage tracker: starts the backend refresher, primes the store
 * with the cached snapshot, and subscribes to `usage-updated` events. The
 * refresher is cheap and self-degrading (agents with no subscription report
 * `na` and are hidden), so it runs for everyone; unmount stops it.
 *
 * Also shapes the backend's Claude poll cadence: a 60s heartbeat reports
 * whether any Claude thread has been active recently (active → 5 min cadence,
 * idle → hourly), and regaining window visibility with a stale snapshot
 * requests an immediate catch-up (floored backend-side).
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

  // Activity heartbeat: usage only moves while agents run, so tell the backend
  // when Claude threads are working (any project — the limit is account-wide).
  useEffect(() => {
    const beat = () => {
      const state = useAppStore.getState();
      const now = Date.now();
      const active = state.threads.some(
        (t) => t.type === "claude" && now - t.lastActivityAt < ACTIVITY_WINDOW_MS,
      );
      if (active) reportUsageActivity("claude").catch(() => { /* best-effort */ });
    };
    beat();
    const id = setInterval(beat, 60_000);
    return () => clearInterval(id);
  }, []);

  // Visibility catch-up: coming back to a long-hidden window shouldn't mean
  // staring at old numbers until the next scheduled poll.
  useEffect(() => {
    const onVisible = () => {
      if (document.hidden) return;
      const claude = useAppStore.getState().usage?.claude;
      const updatedAt = claude?.updated_at ?? 0;
      if (Date.now() / 1000 - updatedAt > STALE_AFTER_SECS) {
        requestUsageRefresh("claude").catch(() => { /* best-effort */ });
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
}
