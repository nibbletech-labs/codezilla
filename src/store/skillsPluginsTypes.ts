export type ItemType = "Skill" | "Agent" | "Command" | "Plugin";
export type InstallTarget = "Project" | "Global";

export interface DetectedItem {
  item_type: ItemType;
  name: string;
  description: string;
  repo_path: string;
  parent_plugin_name?: string;
}

export interface RegistrySource {
  id: string;
  url: string;
  lastFetchedAt: number;
  lastCheckedAt: number;
  latestCommitSha: string;
  updateAvailable: boolean;
  detectedItems: DetectedItem[];
}

export interface Installation {
  id: string;
  sourceId: string;
  itemRepoPath: string;
  itemType: ItemType;
  itemName: string;
  itemDescription: string;
  target: InstallTarget;
  projectPath?: string;
  installPath: string;
  installedAt: number;
  updatedAt?: number;
  installedCommitSha: string;
  parentPluginName?: string;
  marketplaceUrl?: string;
}

export interface ScannedItem {
  path: string;
  item_type: ItemType;
  name: string;
  scope: InstallTarget;
  managed: boolean;
}

export interface FetchResult {
  temp_path: string;
  commit_sha: string;
}

export interface UpdateCheckResult {
  source_id: string;
  remote_sha: string;
  update_available: boolean;
}

export interface SkillsPluginsRegistry {
  sources: Record<string, RegistrySource>;
  installations: Record<string, Installation>;
}
