import { useState, useEffect, useCallback, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { getGitBranch } from "../lib/tauri";

export function useGitBranch(projectPath: string | null): string | null {
  const [branch, setBranch] = useState<string | null>(null);
  const prevPath = useRef<string | null>(null);

  const fetchBranch = useCallback(async () => {
    if (!projectPath) {
      setBranch(null);
      return;
    }
    try {
      const name = await getGitBranch(projectPath);
      setBranch(name);
    } catch {
      setBranch(null);
    }
  }, [projectPath]);

  useEffect(() => {
    if (projectPath !== prevPath.current) {
      prevPath.current = projectPath;
      fetchBranch();
    }
  }, [projectPath, fetchBranch]);

  useEffect(() => {
    if (!projectPath) return;
    const unlisten = listen<string[]>("fs-change", () => {
      fetchBranch();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [projectPath, fetchBranch]);

  return branch;
}
