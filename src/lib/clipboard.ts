import { writeText } from "@tauri-apps/plugin-clipboard-manager";

/** Single entry point for every clipboard write in the app.
 *
 *  We go through the Tauri clipboard plugin (native NSPasteboard via Rust)
 *  rather than `navigator.clipboard`.  The webview API is gated on WebKit's
 *  secure-context rules, which the packaged app — served from the
 *  `tauri://localhost` custom scheme rather than dev's http://localhost:1420 —
 *  does not reliably satisfy.  A macOS update can therefore silently kill every
 *  copy button in a build that never changed.  The native path has no such
 *  dependency.
 *
 *  Returns whether the write actually landed, so callers can show a real
 *  failure instead of a "Copied!" that isn't true. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await writeText(text);
    return true;
  } catch (err) {
    console.error("Clipboard write failed", err);
    return false;
  }
}
