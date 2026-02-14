import { useEffect, useRef } from "react";
import { useAppStore } from "../store/appStore";
import { pathExists } from "../lib/tauri";

const POLL_INTERVAL_MS = 10_000;

export function useProjectHealthCheck() {
  const projects = useAppStore((s) => s.projects);
  const markProjectMissing = useAppStore((s) => s.markProjectMissing);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const check = async () => {
      for (const project of useAppStore.getState().projects) {
        try {
          const exists = await pathExists(project.path);
          if (exists === !project.missing) continue; // no change
          markProjectMissing(project.id, !exists);
        } catch {
          // IPC error — skip this cycle
        }
      }
    };

    check();
    intervalRef.current = setInterval(check, POLL_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [projects.length, markProjectMissing]);
}
