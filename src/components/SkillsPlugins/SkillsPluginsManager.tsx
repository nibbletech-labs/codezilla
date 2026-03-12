import { useState, useCallback, useEffect, useRef } from "react";
import { useAppStore } from "../../store/appStore";
import { useSkillsPluginsStore } from "../../store/skillsPluginsStore";
import type { DetectedItem, Installation, InstallTarget } from "../../store/skillsPluginsTypes";
import type { ScannedItem } from "../../store/skillsPluginsTypes";
import {
  fetchGitRepo,
  detectInstallableItems,
  installItem,
  toInstallation,
  removeItem,
  cleanupFetch,
  uninstallPlugin,
} from "../../lib/skillsTauri";

export default function SkillsPluginsManager() {
  const closeManager = useAppStore((s) => s.closeSkillsManager);
  const activeProject = useAppStore((s) => s.getActiveProject());

  const sources = useSkillsPluginsStore((s) => s.sources);
  const installations = useSkillsPluginsStore((s) => s.installations);
  const scanResults = useSkillsPluginsStore((s) => s.scanResults);
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
  const inputRef = useRef<HTMLInputElement>(null);
  const tempPathRef = useRef<string | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeManager();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [closeManager]);

  // Keep ref in sync for unmount cleanup
  useEffect(() => {
    tempPathRef.current = tempPath;
  }, [tempPath]);

  // Cleanup temp dir on unmount
  useEffect(() => {
    return () => {
      if (tempPathRef.current) cleanupFetch(tempPathRef.current).catch(console.error);
    };
  }, []);

  const handleFetch = useCallback(async () => {
    if (!url.trim()) return;
    setError(null);
    setFetchedItems([]);
    setSelectedItems(new Set());
    setFetchState("fetching");

    try {
      const result = await fetchGitRepo(url.trim());
      setTempPath(result.temp_path);
      setCommitSha(result.commit_sha);
      setFetchState("detecting");

      const items = await detectInstallableItems(result.temp_path);
      setFetchedItems(items);
      setSelectedItems(new Set(items.map((_, i) => i)));
      setFetchState("idle");
    } catch (e: any) {
      setError(e?.toString() ?? "Fetch failed");
      setFetchState("error");
    }
  }, [url, setFetchState]);

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
      detectedItems: fetchedItems,
    });

    // Clean up
    setFetchedItems([]);
    setSelectedItems(new Set());
    setUrl("");
    if (tempPath) {
      cleanupFetch(tempPath).catch(console.error);
      setTempPath(null);
    }
  }, [fetchedItems, selectedItems, url, commitSha, tempPath, addSource]);

  const handleInstallFromFetch = useCallback(
    async (target: InstallTarget) => {
      const selected = fetchedItems.filter((_, i) => selectedItems.has(i));
      if (selected.length === 0) return;

      // Add to registry first
      const sourceId = crypto.randomUUID();
      addSource({
        id: sourceId,
        url: url.trim(),
        lastFetchedAt: Date.now(),
        lastCheckedAt: Date.now(),
        latestCommitSha: commitSha,
        updateAvailable: false,
        detectedItems: fetchedItems,
      });

      // Install each selected item
      const installable = selected.filter((item) => item.item_type !== "Plugin");
      const skippedPlugins = selected.length - installable.length;

      const errors: string[] = [];
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

      if (skippedPlugins > 0) {
        const msg = `${skippedPlugins} plugin(s) skipped — use Claude CLI to install plugins.`;
        setError(errors.length > 0 ? `${msg} Also failed: ${errors.join(", ")}` : msg);
      } else if (errors.length > 0) {
        setError(`Install failed: ${errors.join(", ")}`);
      }

      setFetchedItems([]);
      setSelectedItems(new Set());
      setUrl("");
      if (tempPath) {
        cleanupFetch(tempPath).catch(console.error);
        setTempPath(null);
      }
      setInstallTarget(null);
    },
    [fetchedItems, selectedItems, url, commitSha, tempPath, activeProject, addSource, addInstallation],
  );

  const handleInstallFromRegistry = useCallback(
    async (sourceId: string, item: DetectedItem, target: InstallTarget) => {
      const source = sources[sourceId];
      if (!source) return;

      if (item.item_type === "Plugin") return; // Plugins use CLI flow

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
    },
    [sources, activeProject, addInstallation],
  );

  const handleRemove = useCallback(
    async (inst: Installation) => {
      try {
        await removeItem(inst.installPath, inst.itemType);
        removeInstallation(inst.id);
      } catch (e: any) {
        setError(`Remove failed: ${e?.toString()}`);
      }
    },
    [removeInstallation],
  );

  const handleRemoveScanned = useCallback(
    async (item: ScannedItem) => {
      try {
        if (item.item_type === "Plugin") {
          const cliScope = item.scope === "Global" ? "user" : "project";
          await uninstallPlugin(item.name, cliScope);
        } else {
          await removeItem(item.path, item.item_type);
        }
        // Remove from scan results
        const store = useSkillsPluginsStore.getState();
        store.setScanResults(store.scanResults.filter((s) => s.path !== item.path));
      } catch (e: any) {
        setError(`Remove failed: ${e?.toString()}`);
      }
    },
    [],
  );

  const handleRemoveSource = useCallback(
    (sourceId: string) => {
      removeSource(sourceId);
    },
    [removeSource],
  );

  const handleUpdate = useCallback(
    async (inst: Installation) => {
      const source = sources[inst.sourceId];
      if (!source) return;

      try {
        const result = await fetchGitRepo(source.url);
        const detected = await detectInstallableItems(result.temp_path);

        // Find the matching item
        const match = detected.find((d) => d.repo_path === inst.itemRepoPath);
        if (!match) {
          setError(`Item "${inst.itemName}" not found in updated repo`);
          cleanupFetch(result.temp_path).catch(console.error);
          return;
        }

        // Re-install
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

        // Update installation record
        useSkillsPluginsStore.getState().updateInstallation(inst.id, {
          installedCommitSha: installResult.installedCommitSha,
          installPath: installResult.installPath,
          updatedAt: Date.now(),
          itemName: match.name,
          itemDescription: match.description,
        });

        // Update source
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

  const allInstallations = Object.values(installations);
  const globalInstallations = allInstallations.filter((i) => i.target === "Global");
  const projectInstallations = activeProject
    ? allInstallations.filter(
        (i) => i.target === "Project" && i.projectPath === activeProject.path,
      )
    : [];

  // Registry items not installed in current context
  const installedKeys = new Set(
    allInstallations.map((i) => `${i.sourceId}:${i.itemRepoPath}:${i.target}`),
  );

  const registryItems: { sourceId: string; item: DetectedItem }[] = [];
  for (const source of Object.values(sources)) {
    for (const item of source.detectedItems) {
      const globalKey = `${source.id}:${item.repo_path}:Global`;
      const projectKey = activeProject
        ? `${source.id}:${item.repo_path}:Project`
        : null;
      const isInstalledGlobal = installedKeys.has(globalKey);
      const isInstalledProject = projectKey ? installedKeys.has(projectKey) : false;
      if (!isInstalledGlobal && !isInstalledProject) {
        registryItems.push({ sourceId: source.id, item });
      }
    }
  }

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

  return (
    <div style={styles.backdrop} onClick={(e) => { if (e.target === e.currentTarget) closeManager(); }}>
      <style>{`
        @keyframes skills-backdrop-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes skills-modal-in { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }
      `}</style>
      <div style={styles.modal}>
        {/* Header */}
        <div style={styles.header}>
          <span style={{ fontWeight: 600, fontSize: "var(--font-size)" }}>Skills & Plugins Manager</span>
          <button style={styles.closeBtn} onClick={closeManager}>&times;</button>
        </div>

        <div style={styles.body}>
          {/* URL input */}
          <div style={styles.fetchRow}>
            <span style={{ color: "var(--text-secondary)", fontSize: "var(--font-size-sm)", whiteSpace: "nowrap" }}>Add from URL:</span>
            <input
              ref={inputRef}
              style={styles.input}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleFetch(); }}
              placeholder="https://github.com/user/repo"
              spellCheck={false}
            />
            <button
              style={styles.actionBtn}
              onClick={handleFetch}
              disabled={fetchState === "fetching" || fetchState === "detecting"}
            >
              {fetchState === "fetching" ? "Cloning..." : fetchState === "detecting" ? "Scanning..." : "Fetch"}
            </button>
          </div>

          {error && (
            <div style={{ color: "#f48771", fontSize: "var(--font-size-sm)", padding: "4px 0" }}>{error}</div>
          )}

          {/* Fetch results */}
          {fetchedItems.length > 0 && (
            <div style={styles.section}>
              <div style={styles.sectionTitle}>Fetch results</div>
              {fetchedItems.map((item, i) => (
                <div key={i} style={styles.itemRow}>
                  <label style={{ display: "flex", alignItems: "center", gap: "8px", flex: 1, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={selectedItems.has(i)}
                      onChange={() => {
                        setSelectedItems((prev) => {
                          const next = new Set(prev);
                          if (next.has(i)) next.delete(i);
                          else next.add(i);
                          return next;
                        });
                      }}
                    />
                    <span>{item.name}</span>
                    <TypeBadge type={item.item_type} />
                  </label>
                  {item.description && (
                    <span style={{ color: "var(--text-secondary)", fontSize: "var(--font-size-sm)" }}>
                      {item.description}
                    </span>
                  )}
                </div>
              ))}
              <div style={{ display: "flex", gap: "8px", marginTop: "8px", justifyContent: "flex-end" }}>
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
                  hasUpdate={sources[inst.sourceId]?.updateAvailable}
                  onRemove={() => handleRemove(inst)}
                  onUpdate={() => handleUpdate(inst)}
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
                  hasUpdate={sources[inst.sourceId]?.updateAvailable}
                  onRemove={() => handleRemove(inst)}
                  onUpdate={() => handleUpdate(inst)}
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
                  <ScannedRow
                    key={`plugin-${i}`}
                    item={item}
                    label="marketplace"
                    onRemove={() => handleRemoveScanned(item)}
                  />
                ))}
            </div>
          )}

          {/* Unmanaged items (skills/agents/commands not tracked by registry) */}
          {scanResults.filter((s) => s.item_type !== "Plugin").length > 0 && (
            <div style={styles.section}>
              <div style={styles.sectionTitle}>Unmanaged</div>
              {scanResults
                .filter((s) => s.item_type !== "Plugin")
                .map((item, i) => (
                  <ScannedRow
                    key={`unmanaged-${i}`}
                    item={item}
                    label="unmanaged"
                    onRemove={() => handleRemoveScanned(item)}
                  />
                ))}
            </div>
          )}

          {/* Registry (not installed here) */}
          {registryItems.length > 0 && (
            <div style={styles.section}>
              <div style={styles.sectionTitle}>Registry (not installed here)</div>
              {registryItems.map(({ sourceId, item }) => {
                const itemKey = `${sourceId}:${item.repo_path}`;
                return (
                  <div key={itemKey} style={styles.itemRow}>
                    <span style={{ flex: 1 }}>
                      {item.parent_plugin_name && (
                        <span style={{ color: "var(--text-secondary)", marginRight: "4px" }}>
                          {item.parent_plugin_name} ›
                        </span>
                      )}
                      {item.name}
                      <TypeBadge type={item.item_type} />
                    </span>
                    <div style={{ position: "relative" }}>
                      <button
                        style={styles.smallBtn}
                        onClick={() => setInstallTargetIdx(installTargetIdx === itemKey ? null : itemKey)}
                      >
                        Install ▾
                      </button>
                      {installTargetIdx === itemKey && (
                        <TargetDropdown
                          hasProject={!!activeProject}
                          onSelect={(t) => {
                            handleInstallFromRegistry(sourceId, item, t);
                            setInstallTargetIdx(null);
                          }}
                          onClose={() => setInstallTargetIdx(null)}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
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
                      try { const u = new URL(source.url); return u.hostname + u.pathname.replace(/\.git$/, ""); }
                      catch { return source.url; }
                    })()}
                  </span>
                  <span style={{ color: "var(--text-secondary)", fontSize: "11px" }}>
                    {source.detectedItems.length} items
                    {source.updateAvailable && (
                      <span style={{ color: "var(--accent)", marginLeft: "6px" }}>● update</span>
                    )}
                  </span>
                  <button style={styles.removeBtn} onClick={() => handleRemoveSource(source.id)}>
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Empty state */}
          {isEmpty && (
            <div style={{ textAlign: "center", padding: "48px 24px", color: "var(--text-secondary)" }}>
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
    </div>
  );
}

function TypeBadge({ type }: { type: string }) {
  return (
    <span
      style={{
        fontSize: "10px",
        padding: "1px 6px",
        borderRadius: "3px",
        border: "1px solid var(--border-medium)",
        color: "var(--text-secondary)",
        marginLeft: "6px",
      }}
    >
      {type.toLowerCase()}
    </span>
  );
}

function InstalledRow({
  inst,
  sourceLabel,
  hasUpdate,
  onRemove,
  onUpdate,
}: {
  inst: Installation;
  sourceLabel: string;
  hasUpdate?: boolean;
  onRemove: () => void;
  onUpdate: () => void;
}) {
  const [hoverRemove, setHoverRemove] = useState(false);
  return (
    <div style={styles.itemRow}>
      <span style={{ flex: 1 }}>
        {inst.itemName}
        <TypeBadge type={inst.itemType} />
        {hasUpdate && (
          <span style={{ color: "var(--accent)", marginLeft: "6px", fontSize: "11px", cursor: "pointer" }} onClick={onUpdate}>
            ● update available
          </span>
        )}
      </span>
      <span style={{ color: "var(--text-secondary)", fontSize: "var(--font-size-sm)" }}>
        {sourceLabel}
      </span>
      <button
        style={{
          ...styles.removeBtn,
          color: hoverRemove ? "#f44" : "var(--text-secondary)",
          borderColor: hoverRemove ? "#f44" : "var(--border-medium)",
        }}
        onMouseEnter={() => setHoverRemove(true)}
        onMouseLeave={() => setHoverRemove(false)}
        onClick={onRemove}
      >
        Remove
      </button>
    </div>
  );
}

function ScannedRow({
  item,
  label,
  onRemove,
}: {
  item: ScannedItem;
  label: string;
  onRemove: () => void;
}) {
  const [hoverRemove, setHoverRemove] = useState(false);
  return (
    <div style={styles.itemRow}>
      <span style={{ flex: 1 }}>
        {item.name}
        <TypeBadge type={item.item_type} />
      </span>
      <span style={{ color: "var(--text-secondary)", fontSize: "var(--font-size-sm)" }}>
        {item.scope === "Global" ? "global" : "project"} · {label}
      </span>
      <button
        style={{
          ...styles.removeBtn,
          color: hoverRemove ? "#f44" : "var(--text-secondary)",
          borderColor: hoverRemove ? "#f44" : "var(--border-medium)",
        }}
        onMouseEnter={() => setHoverRemove(true)}
        onMouseLeave={() => setHoverRemove(false)}
        onClick={onRemove}
      >
        Remove
      </button>
    </div>
  );
}

function TargetDropdown({
  hasProject,
  onSelect,
  onClose,
}: {
  hasProject: boolean;
  onSelect: (target: InstallTarget) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Use mousedown to avoid race with the opening click
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{
        position: "absolute",
        right: 0,
        top: "100%",
        marginTop: "4px",
        background: "var(--bg-panel)",
        border: "1px solid var(--border-default)",
        borderRadius: "4px",
        zIndex: 10,
        minWidth: "140px",
        boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {hasProject && (
        <div
          style={{ ...styles.dropdownItem, borderBottom: "1px solid var(--border-subtle)" }}
          onClick={() => onSelect("Project")}
        >
          To this project
        </div>
      )}
      <div
        style={styles.dropdownItem}
        onClick={() => onSelect("Global")}
      >
        Global
      </div>
    </div>
  );
}

const styles = {
  backdrop: {
    position: "fixed" as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "color-mix(in srgb, var(--bg-primary) 60%, transparent)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
    animation: "skills-backdrop-in 0.15s ease-out",
  } as React.CSSProperties,
  modal: {
    width: "calc(100vw - 250px - var(--right-panel-width, 250px) - 10px)",
    maxWidth: "800px",
    maxHeight: "calc(100vh - 24px - 10px)",
    backgroundColor: "var(--bg-primary)",
    borderRadius: "8px",
    border: "1px solid var(--border-default)",
    display: "flex",
    flexDirection: "column" as const,
    overflow: "hidden",
    boxShadow: "0 8px 32px rgba(0, 0, 0, 0.5)",
    animation: "skills-modal-in 0.15s ease-out",
  } as React.CSSProperties,
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 16px",
    borderBottom: "1px solid var(--border-default)",
    backgroundColor: "var(--bg-panel)",
    flexShrink: 0,
  } as React.CSSProperties,
  closeBtn: {
    background: "none",
    border: "none",
    color: "var(--text-secondary)",
    fontSize: "18px",
    cursor: "pointer",
    padding: "4px 8px",
    lineHeight: 1,
  } as React.CSSProperties,
  body: {
    padding: "12px 16px",
    overflowY: "auto" as const,
    flex: 1,
  } as React.CSSProperties,
  fetchRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginBottom: "12px",
  } as React.CSSProperties,
  input: {
    flex: 1,
    background: "var(--bg-input)",
    border: "1px solid var(--border-default)",
    color: "var(--text-primary)",
    fontSize: "var(--font-size-sm)",
    padding: "6px 10px",
    borderRadius: "4px",
    outline: "none",
    fontFamily: "var(--font-family)",
  } as React.CSSProperties,
  actionBtn: {
    background: "transparent",
    border: "1px solid var(--border-medium)",
    color: "var(--text-primary)",
    fontSize: "var(--font-size-sm)",
    padding: "6px 14px",
    borderRadius: "4px",
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
  } as React.CSSProperties,
  accentBtn: {
    background: "var(--accent)",
    border: "none",
    color: "var(--text-on-accent)",
    fontSize: "var(--font-size-sm)",
    padding: "6px 14px",
    borderRadius: "4px",
    cursor: "pointer",
    fontWeight: 600,
    whiteSpace: "nowrap" as const,
  } as React.CSSProperties,
  smallBtn: {
    background: "transparent",
    border: "1px solid var(--border-medium)",
    color: "var(--text-primary)",
    fontSize: "11px",
    padding: "3px 10px",
    borderRadius: "3px",
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
  } as React.CSSProperties,
  removeBtn: {
    background: "none",
    border: "1px solid var(--border-medium)",
    color: "var(--text-secondary)",
    fontSize: "11px",
    padding: "2px 8px",
    borderRadius: "3px",
    cursor: "pointer",
    marginLeft: "8px",
    transition: "color 0.15s, border-color 0.15s",
  } as React.CSSProperties,
  section: {
    marginBottom: "16px",
  } as React.CSSProperties,
  sectionTitle: {
    fontSize: "11px",
    fontWeight: 600,
    textTransform: "uppercase" as const,
    color: "var(--text-secondary)",
    letterSpacing: "0.5px",
    marginBottom: "6px",
    paddingBottom: "4px",
    borderBottom: "1px solid var(--border-subtle)",
  } as React.CSSProperties,
  itemRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "5px 0",
    fontSize: "var(--font-size-sm)",
  } as React.CSSProperties,
  dropdownItem: {
    padding: "8px 14px",
    fontSize: "var(--font-size-sm)",
    cursor: "pointer",
    color: "var(--text-primary)",
  } as React.CSSProperties,
};
