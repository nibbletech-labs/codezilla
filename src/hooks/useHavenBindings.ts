import { useEffect } from "react";
import { useAppStore } from "../store/appStore";
import { havenListProjects, havenRepoBinding } from "../lib/haven";
import type { HavenBindings } from "../lib/havenBinding";

/**
 * Monotonic read counter per Codezilla project id, at module scope so both
 * effects and `refreshHavenBindings` order their reads against each other: a
 * result is only applied if no newer read for that project has started since.
 * Never reset — StrictMode's double mount is handled by the effects' `disposed`
 * flags, not by this map.
 */
const generations = new Map<string, number>();

function nextGeneration(projectId: string): number {
  const gen = (generations.get(projectId) ?? 0) + 1;
  generations.set(projectId, gen);
  return gen;
}

/**
 * Read one project's binding, returning `[id, key]` for the patch or `null`
 * when the result must not be written.
 *
 * A *rejection* — the repo path could not be resolved, e.g. an unmounted
 * volume — is deliberately omitted rather than written as `null`: an
 * unreachable repo is not an unbound one, and the page must not flip back to
 * the Link button for it. Only a successful `null` means unbound.
 */
async function readOne(
  project: { id: string; path: string },
): Promise<[string, string | null] | null> {
  const gen = nextGeneration(project.id);
  try {
    const key = await havenRepoBinding(project.path);
    if (generations.get(project.id) !== gen) return null;
    return [project.id, key];
  } catch (e) {
    console.warn(`haven: could not read the binding for ${project.path}`, e);
    return null;
  }
}

/** Read the given projects' bindings and merge the lot in one store update. */
async function readBindings(
  projects: { id: string; path: string }[],
  isDisposed: () => boolean,
): Promise<void> {
  const results = await Promise.all(projects.map(readOne));
  if (isDisposed()) return;
  const patch: HavenBindings = {};
  for (const result of results) {
    if (!result) continue;
    patch[result[0]] = result[1];
  }
  if (Object.keys(patch).length > 0) useAppStore.getState().setHavenBindings(patch);
}

async function readProjectList(isDisposed: () => boolean): Promise<void> {
  try {
    const listed = await havenListProjects();
    if (!isDisposed()) useAppStore.getState().setHavenProjects(listed);
  } catch (e) {
    // The chooser surfaces its own error; a background refresh failing just
    // leaves the last list in place.
    console.warn("haven: could not refresh the project list", e);
  }
}

/**
 * Re-read one project's binding now (or every project's, with no argument) and
 * resolve once the fresh value is in the store. Mirrors `refreshHavenGraph`:
 * the project page calls it straight after `haven link` returns.
 */
export async function refreshHavenBindings(projectId?: string): Promise<void> {
  const projects = useAppStore
    .getState()
    .projects.filter((p) => !projectId || p.id === projectId);
  await readBindings(projects, () => false);
}

/**
 * Keeps `store.havenBindings` current. Mounted once, beside `useHavenDetect`.
 *
 * Four triggers, all gated on Haven being installed: the project set changing
 * (which is also the first read, once persistence has loaded the projects),
 * the window coming back to the foreground (a `haven link` run in a terminal
 * shows up on return), the active project changing (acceptance 3), and an
 * explicit `refreshHavenBindings` after an in-app link.
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
      void readBindings(projects, isDisposed);
      void readProjectList(isDisposed);
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
