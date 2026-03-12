import type { DetectedItem } from "../../store/skillsPluginsTypes";

export function deriveMarketplaceName(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\.git$/, "");
    const parts = path.split("/").filter(Boolean);
    return parts[parts.length - 1] || "";
  } catch {
    return "";
  }
}

export interface RegistryGroup {
  sourceId: string;
  plugin?: DetectedItem;
  subItems: DetectedItem[];
}

export function groupRegistryItems(
  items: { sourceId: string; item: DetectedItem }[],
): RegistryGroup[] {
  const pluginGroups = new Map<string, RegistryGroup>();
  const result: RegistryGroup[] = [];

  for (const { sourceId, item } of items) {
    if (item.item_type === "Plugin") {
      const key = `${sourceId}:${item.name}`;
      const existing = pluginGroups.get(key);
      if (existing) {
        existing.plugin = item;
      } else {
        const group: RegistryGroup = { sourceId, plugin: item, subItems: [] };
        pluginGroups.set(key, group);
        result.push(group);
      }
    } else if (item.parent_plugin_name) {
      const key = `${sourceId}:${item.parent_plugin_name}`;
      const existing = pluginGroups.get(key);
      if (existing) {
        existing.subItems.push(item);
      } else {
        const group: RegistryGroup = { sourceId, subItems: [item] };
        pluginGroups.set(key, group);
        result.push(group);
      }
    } else {
      result.push({ sourceId, subItems: [item] });
    }
  }
  return result;
}

export interface FetchGroup {
  pluginIdx?: number;
  plugin?: DetectedItem;
  subItems: { idx: number; item: DetectedItem }[];
}

export function groupFetchedItems(items: DetectedItem[]): FetchGroup[] {
  const pluginGroups = new Map<string, FetchGroup>();
  const result: FetchGroup[] = [];

  items.forEach((item, idx) => {
    if (item.item_type === "Plugin") {
      const existing = pluginGroups.get(item.name);
      if (existing) {
        existing.pluginIdx = idx;
        existing.plugin = item;
      } else {
        const group: FetchGroup = { pluginIdx: idx, plugin: item, subItems: [] };
        pluginGroups.set(item.name, group);
        result.push(group);
      }
    } else if (item.parent_plugin_name) {
      const existing = pluginGroups.get(item.parent_plugin_name);
      if (existing) {
        existing.subItems.push({ idx, item });
      } else {
        const group: FetchGroup = { subItems: [{ idx, item }] };
        pluginGroups.set(item.parent_plugin_name, group);
        result.push(group);
      }
    } else {
      result.push({ subItems: [{ idx, item }] });
    }
  });
  return result;
}
