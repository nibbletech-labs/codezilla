import { useSkillsPluginsStore } from "../store/skillsPluginsStore";
import { checkForUpdates, scanInstalledItems } from "./skillsTauri";

let hasCheckedThisSession = false;

/**
 * Check registry sources for available updates via git ls-remote.
 * Runs at most once per app launch (guard resets on full page reload, not HMR).
 */
export async function checkRegistryUpdates(): Promise<void> {
  if (hasCheckedThisSession) return;

  const store = useSkillsPluginsStore.getState();
  const sources = Object.values(store.sources);
  if (sources.length === 0) return;

  // Set the guard only after confirming there are sources to check
  hasCheckedThisSession = true;
  store.setUpdateCheckState("checking");

  const inputs = sources.map((s) => ({
    source_id: s.id,
    url: s.url,
    current_sha: s.latestCommitSha,
  }));

  try {
    const results = await checkForUpdates(inputs);
    for (const result of results) {
      store.updateSource(result.source_id, {
        updateAvailable: result.update_available,
        lastCheckedAt: Date.now(),
      });
    }
  } catch (e) {
    console.error("Failed to check for skills/plugins updates:", e);
  }

  store.setUpdateCheckState("done");
}

/**
 * Reconcile installed items on disk with registry records.
 * - Stale records (files missing): auto-remove
 * - Unmanaged items (files exist, no record): store as scanResults
 */
export async function reconcileInstalledItems(projectPath?: string): Promise<void> {
  const store = useSkillsPluginsStore.getState();

  try {
    const scanned = await scanInstalledItems(projectPath);
    const installations = Object.values(store.installations);

    // Mark scanned items as managed if they match an installation
    for (const item of scanned) {
      const match = installations.find(
        (inst) => inst.installPath === item.path || item.path.startsWith(inst.installPath + "/"),
      );
      item.managed = !!match;
    }

    // Remove stale installation records (files gone)
    for (const inst of installations) {
      if (inst.itemType === "Plugin") continue;

      // Check if this installation's path was found in the scan
      const found = scanned.some(
        (s) => s.path === inst.installPath || s.path.startsWith(inst.installPath + "/"),
      );
      if (!found) {
        console.warn(`Stale installation record removed: ${inst.itemName} at ${inst.installPath}`);
        store.removeInstallation(inst.id);
      }
    }

    // Store unmanaged items for UI display
    const unmanaged = scanned.filter((s) => !s.managed);
    store.setScanResults(unmanaged);

    // Duplicate detection: same itemName at both project and global scope
    detectDuplicates(projectPath);
  } catch (e) {
    console.error("Failed to reconcile installed items:", e);
  }
}

/**
 * Detect items installed at both project and global scope.
 * A project-scoped copy is redundant when the same item exists globally.
 */
export function detectDuplicates(projectPath?: string): void {
  const store = useSkillsPluginsStore.getState();
  if (!projectPath) {
    store.setDuplicates([]);
    return;
  }

  const all = Object.values(store.installations);
  const globalInsts = all.filter((i) => i.target === "Global");
  const projectInsts = all.filter(
    (i) => i.target === "Project" && i.projectPath === projectPath,
  );

  const duplicates: { projectInstId: string; globalInstId: string }[] = [];
  for (const proj of projectInsts) {
    const globalMatch = globalInsts.find(
      (g) => g.itemName === proj.itemName && g.itemType === proj.itemType,
    );
    if (globalMatch) {
      duplicates.push({
        projectInstId: proj.id,
        globalInstId: globalMatch.id,
      });
    }
  }

  store.setDuplicates(duplicates);
}
