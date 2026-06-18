import { useEffect, useCallback } from "react";
import { getSessionCwd } from "../lib/tauri";
import { useAppStore } from "../store/appStore";

/**
 * Resolves the foreground working directory of each live thread in the active
 * project and records it in the store (worktree awareness). Mirrors
 * useGitDiffStat's gated poller: a 10s interval that fires only when the window
 * is visible and the project saw activity in the past 60s, plus an immediate
 * fetch whenever the set of live sessions changes (new thread / restart).
 */
export function useThreadCwds(projectId: string | null): void {
  const setThreadCwd = useAppStore((s) => s.setThreadCwd);

  const fetchAll = useCallback(async () => {
    if (!projectId) return;
    const state = useAppStore.getState();
    // Only real worktrees (not the main repo root) are candidates for the
    // backend's descendant-cwd attribution.
    const worktreePaths = state.worktrees.filter((w) => w.source !== "main").map((w) => w.path);
    const live = state.threads.filter(
      (t) => t.projectId === projectId && t.sessionId && t.state === "running",
    );
    await Promise.allSettled(
      live.map(async (t) => {
        try {
          const cwd = await getSessionCwd(t.sessionId!, worktreePaths);
          setThreadCwd(t.id, cwd ?? null);
        } catch {
          /* process gone or unsupported — keep last-known cwd */
        }
      }),
    );
  }, [projectId, setThreadCwd]);

  // Immediate fetch when the set of live (thread, session) pairs changes, so a
  // freshly spawned or restarted worktree session resolves without waiting for
  // the next poll tick. Subscribing to this derived key (not the whole threads
  // array) keeps re-renders minimal.
  const liveKey = useAppStore((s) =>
    s.threads
      .filter((t) => t.projectId === projectId && t.sessionId && t.state === "running")
      .map((t) => `${t.id}:${t.sessionId}`)
      .join(","),
  );
  // Also re-poll when the worktree list changes — e.g. the agent just ran
  // `git worktree add`, so the new worktree should be attributed right away
  // rather than on the next tick.
  const worktreePathsKey = useAppStore((s) =>
    s.worktrees
      .filter((w) => w.source !== "main")
      .map((w) => w.path)
      .join(","),
  );
  useEffect(() => {
    fetchAll();
  }, [liveKey, worktreePathsKey, fetchAll]);

  // Poll every 10s, gated on visibility + recent activity (cwd can change
  // mid-session when an agent cds into a worktree).
  useEffect(() => {
    if (!projectId) return;
    const id = setInterval(() => {
      if (document.hidden) return;
      const now = Date.now();
      const recentActivity = useAppStore
        .getState()
        .threads.some((t) => t.projectId === projectId && now - t.lastActivityAt < 60_000);
      if (recentActivity) fetchAll();
    }, 10_000);
    return () => clearInterval(id);
  }, [projectId, fetchAll]);
}
