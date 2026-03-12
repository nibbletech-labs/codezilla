import { invoke } from "@tauri-apps/api/core";
import type {
  DetectedItem,
  FetchResult,
  Installation,
  ItemType,
  InstallTarget,
  MarketplaceInfo,
  ScannedItem,
  UpdateCheckResult,
} from "../store/skillsPluginsTypes";

// Installation result from Rust (snake_case — serde default)
interface RustInstallation {
  id: string;
  source_id: string;
  item_repo_path: string;
  item_type: ItemType;
  item_name: string;
  item_description: string;
  target: InstallTarget;
  project_path: string | null;
  install_path: string;
  installed_at: number;
  updated_at: number | null;
  installed_commit_sha: string;
  parent_plugin_name: string | null;
  marketplace_url: string | null;
}

/** Convert Rust snake_case Installation to frontend camelCase Installation */
export function toInstallation(r: RustInstallation): Installation {
  return {
    id: r.id,
    sourceId: r.source_id,
    itemRepoPath: r.item_repo_path,
    itemType: r.item_type,
    itemName: r.item_name,
    itemDescription: r.item_description,
    target: r.target,
    projectPath: r.project_path ?? undefined,
    installPath: r.install_path,
    installedAt: r.installed_at,
    updatedAt: r.updated_at ?? undefined,
    installedCommitSha: r.installed_commit_sha,
    parentPluginName: r.parent_plugin_name ?? undefined,
    marketplaceUrl: r.marketplace_url ?? undefined,
  };
}

export function fetchGitRepo(url: string): Promise<FetchResult> {
  return invoke("fetch_git_repo", { url });
}

export function detectInstallableItems(repoPath: string): Promise<DetectedItem[]> {
  return invoke("detect_installable_items", { repoPath });
}

export function checkForUpdates(
  sources: { source_id: string; url: string; current_sha: string }[],
): Promise<UpdateCheckResult[]> {
  return invoke("check_for_updates", { sources });
}

export function installItem(
  sourceUrl: string,
  repoPath: string,
  itemType: string,
  itemName: string,
  target: string,
  projectPath?: string,
  tempPath?: string,
): Promise<RustInstallation> {
  return invoke("install_item", {
    sourceUrl,
    repoPath,
    itemType,
    itemName,
    target,
    projectPath,
    tempPath,
  });
}

export function removeItem(installPath: string, itemType: string): Promise<void> {
  return invoke("remove_item", { installPath, itemType });
}

export function scanInstalledItems(projectPath?: string): Promise<ScannedItem[]> {
  return invoke("scan_installed_items", { projectPath });
}

export function cleanupFetch(tempPath: string): Promise<void> {
  return invoke("cleanup_fetch", { tempPath });
}

export function registerMarketplace(url: string): Promise<void> {
  return invoke("register_marketplace", { url });
}

export function installPlugin(name: string, marketplace: string, scope: string): Promise<void> {
  return invoke("install_plugin", { name, marketplace, scope });
}

export function uninstallPlugin(name: string, scope: string): Promise<void> {
  return invoke("uninstall_plugin", { name, scope });
}

export function hashFile(path: string): Promise<string> {
  return invoke("hash_file", { path });
}

export function hashFileInTemp(path: string): Promise<string> {
  return invoke("hash_file_in_temp", { path });
}

export function checkInstallPathExists(
  itemType: string,
  itemName: string,
  target: string,
  projectPath?: string,
): Promise<{ exists: boolean; path: string }> {
  return invoke("check_install_path_exists", { itemType, itemName, target, projectPath });
}

export function moveItem(
  installPath: string,
  itemType: string,
  fromTarget: string,
  toTarget: string,
  projectPath?: string,
): Promise<string> {
  return invoke("move_item", { installPath, itemType, fromTarget, toTarget, projectPath });
}

export function listMarketplaces(): Promise<MarketplaceInfo[]> {
  return invoke("list_marketplaces");
}
