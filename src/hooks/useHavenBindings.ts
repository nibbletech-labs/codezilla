import { useEffect } from "react";
import { useAppStore } from "../store/appStore";
import { havenListProjects, havenRepoBinding } from "../lib/haven";
import type { BindingRead } from "../lib/havenBinding";

/**
 * Monotonic read counter per Codezilla project id, at module scope so both
 * effects and `refreshHavenBindings` order their reads against each other: a
 * result is only applied if no newer read for that project has started since.
 * Never reset — StrictMode's double mount is handled by the effects' `disposed`
 * flags, not by this map — but pruned when a project leaves the set, so a long
 * session's removals do not accumulate dead counters.
 */
const generations = new Map<string, number>();

function nextGeneration(projectId: string): number {
  const gen = (generations.get(projectId) ?? 0) + 1;
  generations.set(projectId, gen);
  return gen;
}

/**
 * Read one project's binding as a tagged outcome. Only `read` is a fact about
 * the repo; `superseded` and `failed` both mean "write nothing" — see
 * `BindingRead` for why an unreachable repo is not an unbound one.
 */
async function readOne(project: { id: string; path: string }): Promise<BindingRead> {
  const gen = nextGeneration(project.id);
  try {
    const key = await havenRepoBinding(project.path);
    if (generations.get(project.id) !== gen) return { status: "superseded" };
    return { status: "read", key };
  } catch (e) {
    console.warn(`haven: could not read the binding for ${project.path}`, e);
    return { status: "failed", error: typeof e === "string" ? e : String(e) };
  }
}

/**
 * Read the given projects' bindings, merge the lot in one store update and hand
 * the outcomes back so a caller can react to its own read.
 */
async function readBindings(
  projects: { id: string; path: string }[],
  isDisposed: () => boolean,
): Promise<Record<string, BindingRead>> {
  const results = await Promise.all(projects.map(readOne));
  const reads: Record<string, BindingRead> = {};
  projects.forEach((project, i) => {
    reads[project.id] = results[i];
  });
  if (isDisposed()) return reads;
  if (projects.length > 0) useAppStore.getState().setHavenBindings(reads);
  return reads;
}

/**
 * The one place `store.havenProjects` is written. Rejects with the CLI's stderr
 * verbatim so the chooser can show it; the background refreshes below swallow
 * that and leave the last list in place.
 */
export async function refreshHavenProjects(): Promise<void> {
  const listed = await havenListProjects();
  useAppStore.getState().setHavenProjects(listed);
}

function refreshProjectListInBackground(): void {
  void refreshHavenProjects().catch((e) => {
    // The chooser surfaces its own error; a background refresh failing just
    // leaves the last list in place.
    console.warn("haven: could not refresh the project list", e);
  });
}

/**
 * Re-read one project's binding now and resolve with that read's outcome, once
 * the fresh value is in the store. Mirrors `refreshHavenGraph`: the project
 * page calls it straight after `haven link` returns, and needs the outcome to
 * tell "linked but no marker file" from "the repo could not be reached".
 */
export async function refreshHavenBindings(projectId: string): Promise<BindingRead> {
  const project = useAppStore.getState().projects.find((p) => p.id === projectId);
  // A project removed while the link ran: there is nothing to write and nothing
  // to report about it.
  if (!project) return { status: "superseded" };
  const reads = await readBindings([project], () => false);
  return reads[projectId] ?? { status: "superseded" };
}

/**
 * Keeps `store.havenBindings` current. Mounted once, beside `useHavenDetect`.
 *
 * Four triggers, all gated on Haven being installed: the project set changing
 * (which is also the first read, once persistence has loaded the projects), the
 * window coming back to the foreground, the active project changing
 * (acceptance 3), and an explicit `refreshHavenBindings` after an in-app link.
 *
 * `visibilitychange` is the *external* case: a `haven link` run in Terminal.app
 * while the Codezilla window is occluded shows up the moment the window comes
 * back. A link run in one of Codezilla's own embedded terminals changes no
 * visibility at all — that one lands on the next project selection instead.
 *
 * Deliberately not folded into `useHavenLive`: that hook's effect is keyed on
 * `havenInstalled` alone and owns the live controller's lifecycle, which must
 * not be torn down and rebuilt every time the user clicks another project.
 */
export function useHavenBindings() {
  const havenInstalled = useAppStore((s) => s.havenInstalled);
  const activeProjectId = useAppStore((s) => s.activeProjectId);
  // A string, so Zustand's Object.is only fires on a real change to the set of
  // projects or their paths — not on every unrelated store update.
  const projectsKey = useAppStore((s) =>
    s.projects.map((p) => `${p.id}\t${p.path}`).join("\n"),
  );

  useEffect(() => {
    if (havenInstalled !== true) return;
    let disposed = false;
    const isDisposed = () => disposed;
    const readAll = () => {
      const projects = useAppStore.getState().projects;
      // The project set is the authority on which counters are still worth
      // keeping; a removed project's would otherwise live until quit.
      const live = new Set(projects.map((p) => p.id));
      for (const id of generations.keys()) {
        if (!live.has(id)) generations.delete(id);
      }
      void readBindings(projects, isDisposed);
      refreshProjectListInBackground();
    };
    readAll();
    const onVisible = () => {
      if (!document.hidden) readAll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [havenInstalled, projectsKey]);

  // Selecting a project re-reads just that one — no project-list call.
  useEffect(() => {
    if (havenInstalled !== true || !activeProjectId) return;
    let disposed = false;
    const project = useAppStore.getState().projects.find((p) => p.id === activeProjectId);
    if (project) void readBindings([project], () => disposed);
    return () => {
      disposed = true;
    };
  }, [havenInstalled, activeProjectId]);
}
