import { useEffect, useCallback, useMemo, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { getGitDiffStat } from "../lib/tauri";
import { useAppStore } from "../store/appStore";
import { singleFlight } from "../lib/singleFlight";
import { onEnvDiffRefresh } from "../lib/refreshBus";
import { isPrefix } from "../lib/worktree";

/**
 * Keeps each environment's uncommitted +/- totals fresh in store.envDiffStats,
 * keyed by env path: the active project root (main) plus every non-main
 * worktree. Mounted in the always-rendered TitleBar.
 *
 * Refresh triggers, cheapest-first:
 *  - fs-change events (the watcher covers every env root via useWatchRoots) —
 *    each changed dir is attributed to its env by longest prefix, so churn in
 *    one worktree only re-runs git for that worktree;
 *  - targeted requests from the refresh bus (an agent's file-write tool event);
 *  - the window becoming visible again after being hidden;
 *  - a 10s poll, gated on recent thread activity, as the backstop.
 *
 * Each env fetches independently and merges into the store as it resolves, so
 * one slow or locked env can't hold up the others. On a transient git failure
 * (index.lock contention etc.) the env keeps its last-known value rather than
 * blanking to 0/0 — the singleFlight wrapper guarantees a refresh requested
 * mid-fetch reruns, so a stale value never sticks past the burst that caused it.
 */
export function useWorktreeDiffStats(): void {
  const worktrees = useAppStore((s) => s.worktrees);
  const projectPath = useAppStore(
    (s) => s.projects.find((p) => p.id === s.activeProjectId)?.path ?? null,
  );
  const setEnvDiffStats = useAppStore((s) => s.setEnvDiffStats);
  const mergeEnvDiffStats = useAppStore((s) => s.mergeEnvDiffStats);
  const pruneEnvDiffStats = useAppStore((s) => s.pruneEnvDiffStats);
  const envTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // Env path set: the project root (main, keyed by the store path so it matches
  // attributeEnv + the ThreadItem dot), then each non-main worktree by its path.
  const envPaths = useMemo(() => {
    const paths: string[] = [];
    if (projectPath) paths.push(projectPath);
    for (const wt of worktrees) {
      if (wt.source !== "main" && !paths.includes(wt.path)) paths.push(wt.path);
    }
    return paths;
  }, [worktrees, projectPath]);
  const envPathsRef = useRef(envPaths);
  envPathsRef.current = envPaths;

  // Fetch one env and merge its stats the moment they arrive. Per-env
  // singleFlight so bursts against the same env coalesce instead of stacking.
  const envFetchers = useRef(new Map<string, () => Promise<void>>());
  const fetchEnv = useCallback(
    (p: string): Promise<void> => {
      let runner = envFetchers.current.get(p);
      if (!runner) {
        runner = singleFlight(async () => {
          try {
            const [added, removed] = await getGitDiffStat(p);
            mergeEnvDiffStats({ [p]: { added, removed } });
          } catch {
            // Transient git failure (common while another git process holds the
            // index lock) — keep the env's last-known value rather than blanking.
          }
        });
        envFetchers.current.set(p, runner);
      }
      return runner();
    },
    [mergeEnvDiffStats],
  );

  const fetchAll = useMemo(
    () =>
      singleFlight(async () => {
        const paths = envPathsRef.current;
        if (paths.length === 0) {
          setEnvDiffStats({});
          return;
        }
        pruneEnvDiffStats(paths);
        await Promise.all(paths.map(fetchEnv));
      }),
    [setEnvDiffStats, pruneEnvDiffStats, fetchEnv],
  );

  // Debounced targeted refresh for one env.
  const scheduleEnvFetch = useCallback(
    (p: string, delayMs = 350) => {
      const timers = envTimers.current;
      const existing = timers.get(p);
      if (existing) clearTimeout(existing);
      timers.set(
        p,
        setTimeout(() => {
          timers.delete(p);
          fetchEnv(p);
        }, delayMs),
      );
    },
    [fetchEnv],
  );

  // Clear any pending per-env timers on unmount / identity change.
  useEffect(() => {
    const timers = envTimers.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, [scheduleEnvFetch]);

  // Refresh whenever the env set changes (project switch, worktree add/remove).
  useEffect(() => {
    envFetchers.current.clear();
    fetchAll();
  }, [envPaths, fetchAll]);

  // fs-change: attribute each changed dir to its env (longest prefix wins, so a
  // Claude worktree nested under the repo root doesn't count as main churn) and
  // refresh only the touched envs.
  useEffect(() => {
    if (!projectPath) return;
    const unlisten = listen<string[]>("fs-change", (event) => {
      const touched = new Set<string>();
      for (const dir of event.payload) {
        let best: string | null = null;
        for (const env of envPathsRef.current) {
          if (isPrefix(env, dir) && (!best || env.length > best.length)) best = env;
        }
        if (best) touched.add(best);
      }
      for (const env of touched) scheduleEnvFetch(env);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [projectPath, scheduleEnvFetch]);

  // Targeted refresh requests from the terminal's tool-event stream (agent just
  // wrote a file in this env). Ignore envs we don't track — attribution against
  // another project's worktrees isn't meaningful here.
  useEffect(() => {
    return onEnvDiffRefresh((envPath) => {
      if (envPathsRef.current.includes(envPath)) scheduleEnvFetch(envPath);
    });
  }, [scheduleEnvFetch]);

  // The gated poll skips while the window is hidden — catch up the moment it
  // becomes visible again instead of waiting out the next interval.
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) fetchAll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [fetchAll]);

  // Poll every 10s, but only when the project had activity in the past 60s.
  useEffect(() => {
    if (!projectPath) return;
    const id = setInterval(() => {
      if (document.hidden) return;
      const state = useAppStore.getState();
      const now = Date.now();
      const projectThreads = state.threads.filter((t) => t.projectId === state.activeProjectId);
      const recentActivity = projectThreads.some((t) => now - t.lastActivityAt < 60_000);
      if (recentActivity) fetchAll();
    }, 10_000);
    return () => clearInterval(id);
  }, [projectPath, fetchAll]);
}
