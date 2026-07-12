/**
 * Tiny pub-sub connecting the terminal's tool-event stream to the git refresh
 * hooks. When an agent's file-write tool fires (Heed reports the absolute
 * path), the touched env's diff stats can refresh immediately — a push signal
 * that works wherever the env lives on disk, ahead of (or instead of) any
 * fs-change event. A write that attributes to no known env means the worktree
 * list itself is stale (freshly created worktree), so that gets its own signal.
 */

const envListeners = new Set<(envPath: string) => void>();
const worktreeListeners = new Set<() => void>();

/** Subscribe to targeted env diff-stat refresh requests. Returns unsubscribe. */
export function onEnvDiffRefresh(fn: (envPath: string) => void): () => void {
  envListeners.add(fn);
  return () => {
    envListeners.delete(fn);
  };
}

export function requestEnvDiffRefresh(envPath: string): void {
  for (const fn of envListeners) fn(envPath);
}

/** Subscribe to worktree-list refresh requests. Returns unsubscribe. */
export function onWorktreeListRefresh(fn: () => void): () => void {
  worktreeListeners.add(fn);
  return () => {
    worktreeListeners.delete(fn);
  };
}

export function requestWorktreeListRefresh(): void {
  for (const fn of worktreeListeners) fn();
}
