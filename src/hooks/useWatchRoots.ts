import { useEffect } from "react";
import { setWatchRoots } from "../lib/tauri";
import { useAppStore } from "../store/appStore";

/**
 * Keeps the backend filesystem watcher covering every environment of the
 * active project: the project root plus each non-main worktree path (Claude,
 * Codex, manual — wherever they live on disk). Watching is deliberately
 * decoupled from the file panel's selected env: selecting a worktree must not
 * steal watch coverage from main (the old single-root watcher followed the
 * selection, so every unselected env only refreshed on the gated 10s poll).
 * Mounted in the always-rendered TitleBar next to useWorktrees.
 */
export function useWatchRoots(): void {
  const projectPath = useAppStore(
    (s) => s.projects.find((p) => p.id === s.activeProjectId)?.path ?? null,
  );
  const worktrees = useAppStore((s) => s.worktrees);

  // Key on the joined root set so a re-render with an unchanged list doesn't
  // tear down and re-arm the watcher. An empty set drops the watcher.
  const rootsKey = [
    ...(projectPath ? [projectPath] : []),
    ...worktrees.filter((wt) => wt.source !== "main").map((wt) => wt.path),
  ].join("\n");

  useEffect(() => {
    const roots = rootsKey ? rootsKey.split("\n") : [];
    setWatchRoots(roots).catch((err) =>
      console.error("Failed to set watch roots:", err),
    );
  }, [rootsKey]);
}
