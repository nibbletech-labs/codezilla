import { open as shellOpen } from "@tauri-apps/plugin-shell";

type LinkActivationEvent = {
  preventDefault?: () => void;
  stopPropagation?: () => void;
  stopImmediatePropagation?: () => void;
};

const SUPPORTED_EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);

export function normalizeExternalUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    if (!SUPPORTED_EXTERNAL_PROTOCOLS.has(url.protocol)) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function openExternalUrl(rawUrl: string, event?: LinkActivationEvent): void {
  event?.preventDefault?.();
  event?.stopPropagation?.();
  event?.stopImmediatePropagation?.();

  const url = normalizeExternalUrl(rawUrl);
  if (!url) {
    console.warn("[external-link] ignored unsupported URL:", rawUrl);
    return;
  }

  shellOpen(url).catch((err) => {
    console.error(`[external-link] failed to open ${url}:`, err);
  });
}
