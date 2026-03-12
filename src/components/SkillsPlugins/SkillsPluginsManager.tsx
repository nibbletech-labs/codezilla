import { useState, useCallback, useEffect, useRef } from "react";
import { useAppStore } from "../../store/appStore";
import { useSkillsPluginsStore } from "../../store/skillsPluginsStore";
import type { DetectedItem, Installation, InstallTarget, ScannedItem } from "../../store/skillsPluginsTypes";
import {
  fetchGitRepo,
  detectInstallableItems,
  installItem,
  toInstallation,
  removeItem,
  cleanupFetch,
  uninstallPlugin,
  registerMarketplace,
  installPlugin,
  checkInstallPathExists,
  moveItem as moveItemTauri,
  hashFile,
  hashFileInTemp,
  listMarketplaces,
} from "../../lib/skillsTauri";
import { detectDuplicates, reconcileInstalledItems } from "../../lib/skillsSync";
import { deriveMarketplaceName, groupRegistryItems, groupFetchedItems } from "./helpers";
import { styles } from "./styles";
import { modalKeyframes } from "../../styles/modal";
import { useModalBackdrop } from "../../hooks/useModalBackdrop";
import { ConfirmDialog } from "./ConfirmDialog";
import { InstalledRow } from "./InstalledRow";
import { PluginRow } from "./PluginRow";
import { ScannedRow } from "./ScannedRow";
import { RegistryGroupRow } from "./RegistryGroupRow";
import { FetchGroupRow } from "./FetchGroupRow";
import { TargetDropdown } from "./TargetDropdown";

export default function SkillsPluginsManager() {
  const backdropStyle = useModalBackdrop();
  const closeManager = useAppStore((s) => s.closeSkillsManager);
  const activeProject = useAppStore((s) => s.getActiveProject());

  const sources = useSkillsPluginsStore((s) => s.sources);
  const installations = useSkillsPluginsStore((s) => s.installations);
  const scanResults = useSkillsPluginsStore((s) => s.scanResults);
  const duplicates = useSkillsPluginsStore((s) => s.duplicates);
  const fetchState = useSkillsPluginsStore((s) => s.fetchState);
  const addSource = useSkillsPluginsStore((s) => s.addSource);
  const removeSource = useSkillsPluginsStore((s) => s.removeSource);
  const addInstallation = useSkillsPluginsStore((s) => s.addInstallation);
  const removeInstallation = useSkillsPluginsStore((s) => s.removeInstallation);
  const updateSource = useSkillsPluginsStore((s) => s.updateSource);
  const setFetchState = useSkillsPluginsStore((s) => s.setFetchState);

  const [url, setUrl] = useState("");
  const [fetchedItems, setFetchedItems] = useState<DetectedItem[]>([]);
  const [selectedItems, setSelectedItems] = useState<Set<number>>(new Set());
  const [tempPath, setTempPath] = useState<string | null>(null);
  const [commitSha, setCommitSha] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [installTarget, setInstallTarget] = useState<"dropdown" | null>(null);
  const [installTargetIdx, setInstallTargetIdx] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    message: string;
    onConfirm: () => void;
    onCancel?: () => void;
    confirmLabel?: string;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const tempPathRef = useRef<string | null>(null);
  // H1: Generation counter to guard against race conditions in handleFetch
  const fetchGenRef = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Escape: close confirm dialog first, then manager
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (confirmDialog) {
          setConfirmDialog(null);
        } else {
          closeManager();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [closeManager, confirmDialog]);

  useEffect(() => {
    tempPathRef.current = tempPath;
  }, [tempPath]);

  useEffect(() => {
    return () => {
      if (tempPathRef.current) cleanupFetch(tempPathRef.current).catch(console.error);
    };
  }, []);

  // Re-scan installed items when the active project changes so project-scoped
  // plugins/skills are correctly filtered to the current project.
  const activeProjectPath = activeProject?.path;
  useEffect(() => {
    reconcileInstalledItems(activeProjectPath).catch(console.error);
  }, [activeProjectPath]);

  // Marketplace name → repo URL map (loaded once on mount)
  const [marketplaceUrls, setMarketplaceUrls] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    listMarketplaces()
      .then((list) => {
        const map = new Map<string, string>();
        for (const m of list) {
          if (m.source === "github" && m.repo) {
            map.set(m.name, `https://github.com/${m.repo}`);
          } else if (m.source === "url" && m.url) {
            map.set(m.name, m.url);
          }
        }
        setMarketplaceUrls(map);
      })
      .catch(console.error);
  }, []);

  /* ── Fetch ─────────────────────────────────────────────── */

  // H1: Race condition guard — increment generation on each fetch, bail if stale
  const handleFetch = useCallback(async () => {
    if (!url.trim()) return;
    const gen = ++fetchGenRef.current;
    const prevTempPath = tempPath;
    setError(null);
    setFetchedItems([]);
    setSelectedItems(new Set());
    setFetchState("fetching");

    try {
      const result = await fetchGitRepo(url.trim());

      // If a newer fetch was started, clean up this result and bail
      if (fetchGenRef.current !== gen) {
        cleanupFetch(result.temp_path).catch(console.error);
        return;
      }

      // Clean up the previous temp dir only after the new fetch succeeds
      if (prevTempPath) {
        cleanupFetch(prevTempPath).catch(console.error);
      }

      setTempPath(result.temp_path);
      setCommitSha(result.commit_sha);
      setFetchState("detecting");

      const items = await detectInstallableItems(result.temp_path);

      // Check generation again after detection
      if (fetchGenRef.current !== gen) {
        cleanupFetch(result.temp_path).catch(console.error);
        return;
      }

      setFetchedItems(items);
      setSelectedItems(new Set(items.map((_, i) => i)));
      setFetchState("idle");
    } catch (e: any) {
      if (fetchGenRef.current !== gen) return;
      setError(e?.toString() ?? "Fetch failed");
      setFetchState("error");
    }
  }, [url, tempPath, setFetchState]);

  /* ── Add to Registry (P7: only selected items) ─────────── */

  const handleAddToRegistry = useCallback(() => {
    const selected = fetchedItems.filter((_, i) => selectedItems.has(i));
    if (selected.length === 0) return;

    const sourceId = crypto.randomUUID();
    addSource({
      id: sourceId,
      url: url.trim(),
      lastFetchedAt: Date.now(),
      lastCheckedAt: Date.now(),
      latestCommitSha: commitSha,
      updateAvailable: false,
      detectedItems: selected,
    });

    setFetchedItems([]);
    setSelectedItems(new Set());
    setUrl("");
    if (tempPath) {
      cleanupFetch(tempPath).catch(console.error);
      setTempPath(null);
    }
  }, [fetchedItems, selectedItems, url, commitSha, tempPath, addSource]);

  /* ── Install from Fetch (P1 plugins, P2 conflict check) ── */

  const handleInstallFromFetch = useCallback(
    async (target: InstallTarget) => {
      const selected = fetchedItems.filter((_, i) => selectedItems.has(i));
      if (selected.length === 0) return;

      // P2: Check for file conflicts
      const conflicts: string[] = [];
      for (const item of selected.filter((i) => i.item_type !== "Plugin")) {
        try {
          const check = await checkInstallPathExists(
            item.item_type,
            item.name,
            target,
            target === "Project" ? activeProject?.path : undefined,
          );
          if (check.exists) conflicts.push(`${item.name} (${check.path})`);
        } catch {
          /* ignore check failures */
        }
      }

      const doInstall = async () => {
        const sourceId = crypto.randomUUID();
        addSource({
          id: sourceId,
          url: url.trim(),
          lastFetchedAt: Date.now(),
          lastCheckedAt: Date.now(),
          latestCommitSha: commitSha,
          updateAvailable: false,
          detectedItems: selected,
        });

        const installable = selected.filter((item) => item.item_type !== "Plugin");
        const plugins = selected.filter((item) => item.item_type === "Plugin");
        const errors: string[] = [];

        // Install non-plugins via file copy
        for (const item of installable) {
          try {
            const rustResult = await installItem(
              url.trim(),
              item.repo_path,
              item.item_type,
              item.name,
              target,
              target === "Project" ? activeProject?.path : undefined,
              tempPath ?? undefined,
            );
            const result = toInstallation(rustResult);
            addInstallation({
              ...result,
              sourceId,
              itemRepoPath: item.repo_path,
              itemType: item.item_type,
              itemName: item.name,
              itemDescription: item.description,
              target,
              parentPluginName: item.parent_plugin_name,
            });
          } catch (e: any) {
            console.error(`Failed to install ${item.name}:`, e);
            errors.push(`${item.name}: ${e?.toString()}`);
          }
        }

        // P1: Install plugins via CLI
        if (plugins.length > 0) {
          try {
            await registerMarketplace(url.trim());
          } catch (e: any) {
            errors.push(`marketplace registration: ${e?.toString()}`);
          }
        }
        // M1: Look up marketplace name from CLI instead of guessing from URL
        let marketplace = deriveMarketplaceName(url.trim());
        try {
          const mktList = await listMarketplaces();
          const match = mktList.find((m) =>
            (m.source === "url" && m.url === url.trim()) ||
            (m.source === "github" && m.repo && url.trim() === `https://github.com/${m.repo}`)
          );
          if (match) marketplace = match.name;
        } catch { /* fall back to derived name */ }
        const cliScope = target === "Global" ? "user" : "project";
        for (const item of plugins) {
          try {
            await installPlugin(item.name, marketplace, cliScope);
            addInstallation({
              id: crypto.randomUUID(),
              sourceId,
              itemRepoPath: item.repo_path,
              itemType: item.item_type,
              itemName: item.name,
              itemDescription: item.description,
              target,
              projectPath: target === "Project" ? activeProject?.path : undefined,
              installPath: "",
              installedAt: Date.now(),
              installedCommitSha: commitSha,
              parentPluginName: item.parent_plugin_name,
              marketplaceUrl: url.trim(),
            });
          } catch (e: any) {
            console.error(`Failed to install plugin ${item.name}:`, e);
            errors.push(`${item.name}: ${e?.toString()}`);
          }
        }

        if (errors.length > 0) {
          setError(`Install errors: ${errors.join(", ")}`);
        }

        setFetchedItems([]);
        setSelectedItems(new Set());
        setUrl("");
        if (tempPath) {
          cleanupFetch(tempPath).catch(console.error);
          setTempPath(null);
        }
        setInstallTarget(null);
      };

      if (conflicts.length > 0) {
        setConfirmDialog({
          message: `These items already exist and will be overwritten:\n\n${conflicts.join("\n")}\n\nProceed?`,
          onConfirm: () => {
            setConfirmDialog(null);
            doInstall();
          },
          // H2: Clean up temp dir and reset state if user cancels
          onCancel: () => {
            if (tempPath) {
              cleanupFetch(tempPath).catch(console.error);
              setTempPath(null);
            }
            setFetchedItems([]);
            setSelectedItems(new Set());
          },
        });
      } else {
        doInstall();
      }
    },
    [fetchedItems, selectedItems, url, commitSha, tempPath, activeProject, addSource, addInstallation],
  );

  /* ── Install from Registry (P1 plugins, P2 conflict) ───── */

  const handleInstallFromRegistry = useCallback(
    async (sourceId: string, item: DetectedItem, target: InstallTarget) => {
      const source = sources[sourceId];
      if (!source) return;

      // P1: Plugin install via CLI
      if (item.item_type === "Plugin") {
        try {
          await registerMarketplace(source.url);
          // M1: Look up marketplace name from CLI instead of guessing from URL
          let marketplace = deriveMarketplaceName(source.url);
          try {
            const mktList = await listMarketplaces();
            const match = mktList.find((m) =>
              (m.source === "url" && m.url === source.url) ||
              (m.source === "github" && m.repo && source.url === `https://github.com/${m.repo}`)
            );
            if (match) marketplace = match.name;
          } catch { /* fall back to derived name */ }
          const cliScope = target === "Global" ? "user" : "project";
          await installPlugin(item.name, marketplace, cliScope);
          addInstallation({
            id: crypto.randomUUID(),
            sourceId,
            itemRepoPath: item.repo_path,
            itemType: item.item_type,
            itemName: item.name,
            itemDescription: item.description,
            target,
            projectPath: target === "Project" ? activeProject?.path : undefined,
            installPath: "",
            installedAt: Date.now(),
            installedCommitSha: source.latestCommitSha,
            parentPluginName: item.parent_plugin_name,
            marketplaceUrl: source.url,
          });
        } catch (e: any) {
          setError(`Plugin install failed: ${e?.toString()}`);
        }
        return;
      }

      const doInstall = async () => {
        try {
          const rustResult = await installItem(
            source.url,
            item.repo_path,
            item.item_type,
            item.name,
            target,
            target === "Project" ? activeProject?.path : undefined,
          );
          const result = toInstallation(rustResult);
          addInstallation({
            ...result,
            sourceId,
            itemRepoPath: item.repo_path,
            itemType: item.item_type,
            itemName: item.name,
            itemDescription: item.description,
            target,
            parentPluginName: item.parent_plugin_name,
          });
        } catch (e: any) {
          setError(`Install failed: ${e?.toString()}`);
        }
      };

      // P2: File conflict detection
      try {
        const check = await checkInstallPathExists(
          item.item_type,
          item.name,
          target,
          target === "Project" ? activeProject?.path : undefined,
        );
        if (check.exists) {
          setConfirmDialog({
            message: `A ${item.item_type.toLowerCase()} named '${item.name}' already exists at ${check.path}. Overwrite?`,
            onConfirm: () => {
              setConfirmDialog(null);
              doInstall();
            },
          });
          return;
        }
      } catch {
        /* ignore */
      }

      doInstall();
    },
    [sources, activeProject, addInstallation],
  );

  /* ── Remove (P0 confirm) ───────────────────────────────── */

  const handleRemove = useCallback(
    async (inst: Installation) => {
      try {
        if (inst.itemType === "Plugin") {
          const cliScope = inst.target === "Global" ? "user" : "project";
          await uninstallPlugin(inst.itemName, cliScope);
        } else {
          await removeItem(inst.installPath, inst.itemType);
        }
        removeInstallation(inst.id);
      } catch (e: any) {
        setError(`Remove failed: ${e?.toString()}`);
      }
    },
    [removeInstallation],
  );

  const requestRemove = useCallback(
    (inst: Installation) => {
      const isPlugin = inst.itemType === "Plugin";
      const message = isPlugin
        ? `Remove ${inst.itemName}? This will run claude plugin uninstall.`
        : `Remove ${inst.itemName}? Files will be deleted from ${inst.installPath}.`;
      setConfirmDialog({
        message,
        confirmLabel: "Remove",
        onConfirm: () => {
          setConfirmDialog(null);
          handleRemove(inst);
        },
      });
    },
    [handleRemove],
  );

  /* ── Remove scanned/unmanaged (P0 confirm) ─────────────── */

  const handleRemoveScanned = useCallback(async (item: ScannedItem) => {
    try {
      if (item.item_type === "Plugin") {
        const cliScope = item.scope === "Global" ? "user" : "project";
        const pluginRef = item.marketplace ? `${item.name}@${item.marketplace}` : item.name;
        await uninstallPlugin(pluginRef, cliScope);
      } else {
        await removeItem(item.path, item.item_type);
      }
      const store = useSkillsPluginsStore.getState();
      store.setScanResults(store.scanResults.filter((s) => s.path !== item.path));
    } catch (e: any) {
      setError(`Remove failed: ${e?.toString()}`);
    }
  }, []);

  const requestRemoveScanned = useCallback(
    (item: ScannedItem) => {
      setConfirmDialog({
        message: `Remove ${item.name}? This item is not tracked by Codezilla and cannot be restored.`,
        confirmLabel: "Remove",
        onConfirm: () => {
          setConfirmDialog(null);
          handleRemoveScanned(item);
        },
      });
    },
    [handleRemoveScanned],
  );

  /* ── Link source / Claim (P5 SHA-256 comparison) ────────── */

  const [linkingItem, setLinkingItem] = useState<ScannedItem | null>(null);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkState, setLinkState] = useState<"idle" | "fetching" | "detecting">("idle");

  const handleLinkSource = useCallback((item: ScannedItem) => {
    setLinkingItem(item);
    setLinkUrl("");
    setLinkState("idle");
    setError(null);
  }, []);

  const handleLinkConfirm = useCallback(async () => {
    if (!linkingItem || !linkUrl.trim()) return;
    setError(null);
    setLinkState("fetching");

    try {
      const result = await fetchGitRepo(linkUrl.trim());
      setLinkState("detecting");
      const detected = await detectInstallableItems(result.temp_path);

      const match = detected.find(
        (d) =>
          d.name.toLowerCase() === linkingItem.name.toLowerCase() &&
          d.item_type === linkingItem.item_type,
      );
      if (!match) {
        setError(
          `No ${linkingItem.item_type.toLowerCase()} named "${linkingItem.name}" found in this repository.`,
        );
        cleanupFetch(result.temp_path).catch(console.error);
        setLinkState("idle");
        return;
      }

      const doLink = () => {
        const sourceId = crypto.randomUUID();
        addSource({
          id: sourceId,
          url: linkUrl.trim(),
          lastFetchedAt: Date.now(),
          lastCheckedAt: Date.now(),
          latestCommitSha: result.commit_sha,
          updateAvailable: false,
          detectedItems: detected,
        });

        addInstallation({
          id: crypto.randomUUID(),
          sourceId,
          itemRepoPath: match.repo_path,
          itemType: match.item_type,
          itemName: match.name,
          itemDescription: match.description,
          target: linkingItem.scope,
          projectPath: linkingItem.scope === "Project" ? activeProject?.path : undefined,
          installPath: linkingItem.path,
          installedAt: Date.now(),
          installedCommitSha: result.commit_sha,
          parentPluginName: match.parent_plugin_name,
        });

        const store = useSkillsPluginsStore.getState();
        store.setScanResults(store.scanResults.filter((s) => s.path !== linkingItem.path));

        // P4: Re-check for duplicates after linking
        detectDuplicates(activeProject?.path);

        cleanupFetch(result.temp_path).catch(console.error);
        setLinkingItem(null);
        setLinkUrl("");
        setLinkState("idle");
      };

      // P5: SHA-256 content comparison
      try {
        const localPath =
          linkingItem.item_type === "Skill"
            ? `${linkingItem.path}/SKILL.md`
            : linkingItem.path;
        const repoFilePath =
          match.item_type === "Skill"
            ? `${result.temp_path}/${match.repo_path}/SKILL.md`
            : `${result.temp_path}/${match.repo_path}`;

        const [localHash, repoHash] = await Promise.all([
          hashFile(localPath),
          hashFileInTemp(repoFilePath),
        ]);

        if (localHash === repoHash) {
          doLink();
        } else {
          setLinkState("idle");
          setConfirmDialog({
            message:
              "Local files differ from the remote version. Link anyway? Future updates will overwrite local changes.",
            confirmLabel: "Link",
            onConfirm: () => {
              setConfirmDialog(null);
              doLink();
            },
            onCancel: () => {
              cleanupFetch(result.temp_path).catch(console.error);
            },
          });
        }
      } catch {
        // Hash comparison failed — proceed with name-only match
        doLink();
      }
    } catch (e: any) {
      setError(`Link failed: ${e?.toString()}`);
      setLinkState("idle");
    }
  }, [linkingItem, linkUrl, activeProject, addSource, addInstallation]);

  /* ── Update (P0 confirm) ───────────────────────────────── */

  const handleUpdate = useCallback(
    async (inst: Installation) => {
      const source = sources[inst.sourceId];
      if (!source) return;

      try {
        const result = await fetchGitRepo(source.url);
        const detected = await detectInstallableItems(result.temp_path);

        const match = detected.find((d) => d.repo_path === inst.itemRepoPath);
        if (!match) {
          setError(`Item "${inst.itemName}" not found in updated repo`);
          cleanupFetch(result.temp_path).catch(console.error);
          return;
        }

        if (inst.itemType === "Plugin") {
          // Plugin update: re-register marketplace and reinstall via CLI
          const marketplaceUrl = inst.marketplaceUrl || source.url;
          await registerMarketplace(marketplaceUrl);
          // M1: Look up marketplace name from CLI instead of guessing from URL
          let marketplace = deriveMarketplaceName(marketplaceUrl);
          try {
            const mktList = await listMarketplaces();
            const match = mktList.find((m) =>
              (m.source === "url" && m.url === marketplaceUrl) ||
              (m.source === "github" && m.repo && marketplaceUrl === `https://github.com/${m.repo}`)
            );
            if (match) marketplace = match.name;
          } catch { /* fall back to derived name */ }
          const cliScope = inst.target === "Global" ? "user" : "project";
          await uninstallPlugin(inst.itemName, cliScope);
          await installPlugin(inst.itemName, marketplace, cliScope);

          useSkillsPluginsStore.getState().updateInstallation(inst.id, {
            installedCommitSha: result.commit_sha,
            updatedAt: Date.now(),
            itemName: match.name,
            itemDescription: match.description,
          });
        } else {
          const rustInstallResult = await installItem(
            source.url,
            inst.itemRepoPath,
            inst.itemType,
            inst.itemName,
            inst.target,
            inst.projectPath,
            result.temp_path,
          );
          const installResult = toInstallation(rustInstallResult);

          useSkillsPluginsStore.getState().updateInstallation(inst.id, {
            installedCommitSha: installResult.installedCommitSha,
            installPath: installResult.installPath,
            updatedAt: Date.now(),
            itemName: match.name,
            itemDescription: match.description,
          });
        }

        updateSource(inst.sourceId, {
          latestCommitSha: result.commit_sha,
          lastCheckedAt: Date.now(),
          lastFetchedAt: Date.now(),
          updateAvailable: false,
          detectedItems: detected,
        });

        cleanupFetch(result.temp_path).catch(console.error);
      } catch (e: any) {
        setError(`Update failed: ${e?.toString()}`);
      }
    },
    [sources, updateSource],
  );

  const requestUpdate = useCallback(
    (inst: Installation) => {
      setConfirmDialog({
        message: `Update ${inst.itemName}? Local changes to these files will be overwritten.`,
        confirmLabel: "Update",
        onConfirm: () => {
          setConfirmDialog(null);
          handleUpdate(inst);
        },
      });
    },
    [handleUpdate],
  );

  /* ── Move Scope (P3) ───────────────────────────────────── */

  const handleMoveScope = useCallback(
    (inst: Installation) => {
      if (inst.itemType === "Plugin") return; // Plugins can't be moved via file copy
      const newTarget: InstallTarget = inst.target === "Global" ? "Project" : "Global";

      const doMove = async () => {
        try {
          const newPath = await moveItemTauri(
            inst.installPath,
            inst.itemType,
            inst.target,
            newTarget,
            newTarget === "Project" ? activeProject?.path : undefined,
          );
          useSkillsPluginsStore.getState().updateInstallation(inst.id, {
            target: newTarget,
            installPath: newPath,
            projectPath: newTarget === "Project" ? activeProject?.path : undefined,
          });
        } catch (e: any) {
          setError(`Move failed: ${e?.toString()}`);
        }
      };

      if (inst.target === "Global") {
        setConfirmDialog({
          message: "Other projects will lose access unless they install separately.",
          onConfirm: () => {
            setConfirmDialog(null);
            doMove();
          },
        });
      } else {
        doMove();
      }
    },
    [activeProject],
  );

  /* ── Remove duplicate (P4) ─────────────────────────────── */

  const handleRemoveDuplicate = useCallback(
    (instId: string) => {
      const inst = installations[instId];
      if (!inst) return;
      setConfirmDialog({
        message: `Remove duplicate "${inst.itemName}" from this project? The global copy will remain.`,
        confirmLabel: "Remove duplicate",
        onConfirm: () => {
          setConfirmDialog(null);
          handleRemove(inst);
        },
      });
    },
    [installations, handleRemove],
  );

  const handleRemoveSource = useCallback(
    (sourceId: string) => {
      removeSource(sourceId);
    },
    [removeSource],
  );

  /* ── Derived Data ──────────────────────────────────────── */

  const allInstallations = Object.values(installations);
  const globalInstallations = allInstallations.filter((i) => i.target === "Global");
  const projectInstallations = activeProject
    ? allInstallations.filter(
        (i) => i.target === "Project" && i.projectPath === activeProject.path,
      )
    : [];

  const installedKeys = new Set(
    allInstallations.map((i) => `${i.sourceId}:${i.itemRepoPath}:${i.target}`),
  );

  const registryItems: { sourceId: string; item: DetectedItem }[] = [];
  for (const source of Object.values(sources)) {
    for (const item of source.detectedItems) {
      const globalKey = `${source.id}:${item.repo_path}:Global`;
      const projectKey = activeProject ? `${source.id}:${item.repo_path}:Project` : null;
      const isInstalledGlobal = installedKeys.has(globalKey);
      const isInstalledProject = projectKey ? installedKeys.has(projectKey) : false;
      if (!isInstalledGlobal && !isInstalledProject) {
        registryItems.push({ sourceId: source.id, item });
      }
    }
  }

  // P6: group registry items by plugin
  const registryGroups = groupRegistryItems(registryItems);
  // P6: group fetch results by plugin
  const fetchGroups = groupFetchedItems(fetchedItems);

  // P4: duplicate lookup
  const duplicateProjectIds = new Set(duplicates.map((d) => d.projectInstId));

  const isEmpty =
    globalInstallations.length === 0 &&
    projectInstallations.length === 0 &&
    registryItems.length === 0 &&
    scanResults.length === 0 &&
    fetchedItems.length === 0;

  const getSourceLabel = (inst: Installation) => {
    const source = sources[inst.sourceId];
    if (!source) return "unmanaged";
    try {
      const u = new URL(source.url);
      return u.hostname + u.pathname.replace(/\.git$/, "");
    } catch {
      return source.url;
    }
  };

  /** Derive a clickable URL for an installed item. */
  const getSourceUrl = (inst: Installation): string | undefined => {
    // Linked / fetched items: use the registry source URL
    const source = sources[inst.sourceId];
    if (source) return source.url;
    // Marketplace plugins: look up the marketplace URL map
    if (inst.marketplaceUrl) {
      const name = deriveMarketplaceName(inst.marketplaceUrl);
      if (name && marketplaceUrls.has(name)) return marketplaceUrls.get(name);
      return inst.marketplaceUrl;
    }
    return undefined;
  };

  /* ── JSX ───────────────────────────────────────────────── */

  return (
    <div
      style={backdropStyle}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeManager();
      }}
    >
      <style>{modalKeyframes}</style>
      <div style={styles.modal}>
        {/* Header */}
        <div style={styles.header}>
          <span style={{ fontWeight: 600, fontSize: "var(--font-size)" }}>
            Skills & Plugins Manager
          </span>
          <button style={styles.closeBtn} onClick={closeManager}>
            &times;
          </button>
        </div>

        <div style={styles.body}>
          {/* URL input */}
          <div style={styles.fetchRow}>
            <span
              style={{
                color: "var(--text-secondary)",
                fontSize: "var(--font-size-sm)",
                whiteSpace: "nowrap",
              }}
            >
              Add from URL:
            </span>
            <input
              ref={inputRef}
              style={styles.input}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleFetch();
              }}
              placeholder="https://github.com/user/repo"
              spellCheck={false}
            />
            <button
              style={styles.actionBtn}
              onClick={handleFetch}
              disabled={fetchState === "fetching" || fetchState === "detecting"}
            >
              {fetchState === "fetching"
                ? "Cloning..."
                : fetchState === "detecting"
                  ? "Scanning..."
                  : "Fetch"}
            </button>
          </div>

          {error && (
            <div
              style={{
                color: "#f48771",
                fontSize: "var(--font-size-sm)",
                padding: "4px 0",
                whiteSpace: "pre-line",
              }}
            >
              {error}
            </div>
          )}

          {/* Fetch results (P6: grouped by plugin) */}
          {fetchedItems.length > 0 && (
            <div style={styles.section}>
              <div style={styles.sectionTitle}>Fetch results</div>
              {fetchGroups.map((group, gi) => (
                <FetchGroupRow
                  key={gi}
                  group={group}
                  selectedItems={selectedItems}
                  setSelectedItems={setSelectedItems}
                />
              ))}
              <div
                style={{
                  display: "flex",
                  gap: "8px",
                  marginTop: "8px",
                  justifyContent: "flex-end",
                }}
              >
                <button style={styles.actionBtn} onClick={handleAddToRegistry}>
                  Add to Registry
                </button>
                <div style={{ position: "relative" }}>
                  <button
                    style={styles.accentBtn}
                    onClick={() => setInstallTarget(installTarget ? null : "dropdown")}
                  >
                    Install ▾
                  </button>
                  {installTarget === "dropdown" && (
                    <TargetDropdown
                      hasProject={!!activeProject}
                      onSelect={(t) => {
                        handleInstallFromFetch(t);
                        setInstallTarget(null);
                      }}
                      onClose={() => setInstallTarget(null)}
                    />
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Installed — Global */}
          {globalInstallations.length > 0 && (
            <div style={styles.section}>
              <div style={styles.sectionTitle}>Installed — Global</div>
              {globalInstallations.map((inst) => (
                <InstalledRow
                  key={inst.id}
                  inst={inst}
                  sourceLabel={getSourceLabel(inst)}
                  sourceUrl={getSourceUrl(inst)}
                  hasUpdate={sources[inst.sourceId]?.updateAvailable}
                  isDuplicate={false}
                  hasProject={!!activeProject}
                  onRemove={() => requestRemove(inst)}
                  onUpdate={() => requestUpdate(inst)}
                  onMove={() => handleMoveScope(inst)}
                />
              ))}
            </div>
          )}

          {/* Installed — This Project */}
          {projectInstallations.length > 0 && (
            <div style={styles.section}>
              <div style={styles.sectionTitle}>Installed — This Project</div>
              {projectInstallations.map((inst) => (
                <InstalledRow
                  key={inst.id}
                  inst={inst}
                  sourceLabel={getSourceLabel(inst)}
                  sourceUrl={getSourceUrl(inst)}
                  hasUpdate={sources[inst.sourceId]?.updateAvailable}
                  isDuplicate={duplicateProjectIds.has(inst.id)}
                  hasProject={!!activeProject}
                  onRemove={() => requestRemove(inst)}
                  onUpdate={() => requestUpdate(inst)}
                  onMove={() => handleMoveScope(inst)}
                  onRemoveDuplicate={() => handleRemoveDuplicate(inst.id)}
                />
              ))}
            </div>
          )}

          {/* Marketplace plugins (from installed_plugins.json) */}
          {scanResults.filter((s) => s.item_type === "Plugin").length > 0 && (
            <div style={styles.section}>
              <div style={styles.sectionTitle}>Marketplace Plugins</div>
              {scanResults
                .filter((s) => s.item_type === "Plugin")
                .map((item, i) => (
                  <PluginRow
                    key={`plugin-${i}`}
                    plugin={item}
                    subItems={scanResults.filter(
                      (s) =>
                        s.parent_plugin_name === item.name &&
                        s.marketplace === item.marketplace &&
                        s.item_type !== "Plugin",
                    )}
                    onRemove={() => requestRemoveScanned(item)}
                    repoUrl={item.marketplace ? marketplaceUrls.get(item.marketplace) : undefined}
                  />
                ))}
            </div>
          )}

          {/* Unmanaged items */}
          {scanResults.filter((s) => s.item_type !== "Plugin" && !s.parent_plugin_name).length >
            0 && (
            <div style={styles.section}>
              <div style={styles.sectionTitle}>Unmanaged</div>
              {scanResults
                .filter((s) => s.item_type !== "Plugin" && !s.parent_plugin_name)
                .map((item, i) => (
                  <ScannedRow
                    key={`unmanaged-${i}`}
                    item={item}
                    label="unmanaged"
                    onRemove={() => requestRemoveScanned(item)}
                    onLink={() => handleLinkSource(item)}
                  />
                ))}
              {linkingItem && (
                <div
                  style={{
                    padding: "8px 0",
                    borderTop: "1px solid var(--border-subtle)",
                    marginTop: "4px",
                  }}
                >
                  <div
                    style={{
                      fontSize: "var(--font-size-sm)",
                      color: "var(--text-secondary)",
                      marginBottom: "6px",
                    }}
                  >
                    Link &ldquo;{linkingItem.name}&rdquo; to a git source:
                  </div>
                  <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                    <input
                      style={styles.input}
                      value={linkUrl}
                      onChange={(e) => setLinkUrl(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleLinkConfirm();
                      }}
                      placeholder="https://github.com/user/repo"
                      spellCheck={false}
                      autoFocus
                    />
                    <button
                      style={styles.actionBtn}
                      onClick={handleLinkConfirm}
                      disabled={linkState !== "idle" || !linkUrl.trim()}
                    >
                      {linkState === "fetching"
                        ? "Cloning..."
                        : linkState === "detecting"
                          ? "Matching..."
                          : "Link"}
                    </button>
                    <button
                      style={styles.actionBtn}
                      onClick={() => {
                        setLinkingItem(null);
                        setLinkUrl("");
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Registry (P6: grouped by plugin) */}
          {registryItems.length > 0 && (
            <div style={styles.section}>
              <div style={styles.sectionTitle}>Registry (not installed here)</div>
              {registryGroups.map((group, gi) => (
                <RegistryGroupRow
                  key={gi}
                  group={group}
                  installTargetIdx={installTargetIdx}
                  setInstallTargetIdx={setInstallTargetIdx}
                  hasProject={!!activeProject}
                  onInstall={handleInstallFromRegistry}
                />
              ))}
            </div>
          )}

          {/* Source management */}
          {Object.values(sources).length > 0 && (
            <div style={styles.section}>
              <div style={styles.sectionTitle}>Sources</div>
              {Object.values(sources).map((source) => (
                <div key={source.id} style={styles.itemRow}>
                  <span style={{ flex: 1, fontSize: "var(--font-size-sm)" }}>
                    {(() => {
                      try {
                        const u = new URL(source.url);
                        return u.hostname + u.pathname.replace(/\.git$/, "");
                      } catch {
                        return source.url;
                      }
                    })()}
                  </span>
                  <span style={{ color: "var(--text-secondary)", fontSize: "11px" }}>
                    {source.detectedItems.length} items
                    {source.updateAvailable && (
                      <span style={{ color: "var(--accent)", marginLeft: "6px" }}>● update</span>
                    )}
                  </span>
                  <button
                    style={styles.removeBtn}
                    onClick={() => handleRemoveSource(source.id)}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Empty state */}
          {isEmpty && (
            <div
              style={{ textAlign: "center", padding: "48px 24px", color: "var(--text-secondary)" }}
            >
              <div style={{ marginBottom: "8px" }}>
                Paste a git repo URL to discover and install Claude Code skills and plugins.
              </div>
              <div style={{ fontSize: "var(--font-size-sm)" }}>
                Skills, agents, and commands are auto-detected from the repository.
              </div>
            </div>
          )}
        </div>
      </div>

      {/* P0: Confirm dialog */}
      {confirmDialog && (
        <ConfirmDialog
          message={confirmDialog.message}
          confirmLabel={confirmDialog.confirmLabel}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => {
            confirmDialog.onCancel?.();
            setConfirmDialog(null);
          }}
        />
      )}
    </div>
  );
}
