import { useState, useEffect, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { getGitBranch } from "../lib/tauri";

export function useGitBranch(projectPath: string | null): string | null {
  const [branch, setBranch] = useState<string | null>(null);
  const prevPath = useRef<string | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);

  const fetchBranch = useCallback(async () => {
    if (!projectPath) {
      setBranch((prev) => (prev === null ? prev : null));
      return;
    }
    // On slow repos one git call can outlive the refresh debounce; never stack them.
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const name = await getGitBranch(projectPath);
      setBranch((prev) => (prev === name ? prev : name));
    } catch {
      setBranch((prev) => (prev === null ? prev : null));
    } finally {
      inFlight.current = false;
    }
  }, [projectPath]);

  const scheduleFetchBranch = useCallback((delayMs = 350) => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      fetchBranch();
    }, delayMs);
  }, [fetchBranch]);

  useEffect(() => {
    if (projectPath !== prevPath.current) {
      prevPath.current = projectPath;
      fetchBranch();
    }
  }, [projectPath, fetchBranch]);

  useEffect(() => {
    if (!projectPath) return;
    const unlisten = listen<string[]>("fs-change", () => {
      scheduleFetchBranch();
    });
    return () => {
      if (refreshTimer.current) {
        clearTimeout(refreshTimer.current);
        refreshTimer.current = null;
      }
      unlisten.then((fn) => fn());
    };
  }, [projectPath, scheduleFetchBranch]);

  return branch;
}
