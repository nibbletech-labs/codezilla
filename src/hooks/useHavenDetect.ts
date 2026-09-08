import { useEffect } from "react";
import { useAppStore } from "../store/appStore";
import { havenDetect } from "../lib/haven";

/**
 * Ask once at mount whether the `haven` CLI is on PATH, and again whenever the
 * window comes back to the foreground — installing Haven then returning to
 * Codezilla brings the Backlog rows in without a restart.
 *
 * Every failure resolves to "not installed": a missing or broken CLI must leave
 * the sidebar exactly as it was, never surface an error.
 */
export function useHavenDetect() {
  const setHavenInstalled = useAppStore((s) => s.setHavenInstalled);

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      havenDetect()
        .then((version) => {
          if (!cancelled) setHavenInstalled(version !== null);
        })
        .catch(() => {
          if (!cancelled) setHavenInstalled(false);
        });
    };
    check();
    const onVisible = () => {
      if (!document.hidden) check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [setHavenInstalled]);
}
