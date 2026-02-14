import { useState, useEffect, useCallback } from "react";
import { check } from "@tauri-apps/plugin-updater";

type UpdateStatus = "idle" | "checking" | "available" | "downloading" | "ready" | "error";

export function useUpdater() {
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [version, setVersion] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [update, setUpdate] = useState<Awaited<ReturnType<typeof check>> | null>(null);

  useEffect(() => {
    const timer = setTimeout(async () => {
      setStatus("checking");
      try {
        const result = await check();
        if (result) {
          setUpdate(result);
          setVersion(result.version);
          setStatus("available");
        } else {
          setStatus("idle");
        }
      } catch {
        setStatus("idle");
      }
    }, 3000);
    return () => clearTimeout(timer);
  }, []);

  const downloadAndInstall = useCallback(async () => {
    if (!update) return;
    setStatus("downloading");
    let totalBytes = 0;
    let downloadedBytes = 0;
    try {
      await update.downloadAndInstall((e) => {
        if (e.event === "Started" && e.data.contentLength) {
          totalBytes = e.data.contentLength;
        } else if (e.event === "Progress") {
          downloadedBytes += e.data.chunkLength;
          if (totalBytes > 0) {
            setProgress(Math.min(Math.round((downloadedBytes / totalBytes) * 100), 100));
          }
        }
      });
      setStatus("ready");
    } catch {
      setStatus("error");
    }
  }, [update]);

  const dismiss = useCallback(() => {
    setStatus("idle");
    setUpdate(null);
    setVersion(null);
  }, []);

  return { status, version, progress, downloadAndInstall, dismiss };
}
