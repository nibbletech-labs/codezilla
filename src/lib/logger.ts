import { attachConsole } from "@tauri-apps/plugin-log";

let detach: (() => void) | null = null;

export async function initLogger() {
  if (detach) return;
  try {
    detach = await attachConsole();
  } catch {
    // Log plugin not available (e.g. in browser-only dev mode)
  }
}
