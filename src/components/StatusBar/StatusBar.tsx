import { useState, useEffect } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useAppStore } from "../../store/appStore";
import { getThreadSubtitle } from "../../lib/threadRuntime";
import { useUpdater } from "../../hooks/useUpdater";

export default function StatusBar() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => { getVersion().then(setVersion).catch(() => {}); }, []);
  const activeThreadId = useAppStore((s) => s.activeThreadId);
  const activeThread = useAppStore((s) =>
    s.threads.find((t) => t.id === s.activeThreadId),
  );
  const info = useAppStore((s) =>
    activeThreadId ? s.transcriptInfo[activeThreadId] ?? null : null,
  );

  const subtitle = activeThread ? getThreadSubtitle(activeThread, info) : null;
  const costUsd = info?.costUsd ?? null;
  const { status, version: updateVersion, progress, downloadAndInstall, dismiss } =
    useUpdater();

  return (
    <div
      style={{
        height: "24px",
        backgroundColor: "var(--accent)",
        display: "flex",
        alignItems: "center",
        padding: "0 12px",
        fontSize: "var(--font-size-sm)",
        color: "var(--text-on-accent)",
      }}
    >
      <span>Codezilla{version ? ` v${version}` : ""}</span>
      {activeThread && subtitle && (
        <span style={{ marginLeft: "16px", opacity: 0.85 }}>
          {activeThread.name}: {subtitle}
        </span>
      )}
      <span style={{ flex: 1 }} />
      {status === "available" && updateVersion && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span
            role="button"
            tabIndex={0}
            onClick={downloadAndInstall}
            onKeyDown={(e) => e.key === "Enter" && downloadAndInstall()}
            style={{
              cursor: "pointer",
              textDecoration: "underline",
              textUnderlineOffset: "2px",
            }}
          >
            Update v{updateVersion}
          </span>
          <span
            role="button"
            tabIndex={0}
            onClick={dismiss}
            onKeyDown={(e) => e.key === "Enter" && dismiss()}
            style={{ cursor: "pointer", opacity: 0.7, marginLeft: 2 }}
            title="Dismiss"
          >
            ✕
          </span>
        </span>
      )}
      {status === "downloading" && (
        <span style={{ opacity: 0.85 }}>
          Downloading…{progress != null ? ` ${progress}%` : ""}
        </span>
      )}
      {status === "ready" && (
        <span style={{ opacity: 0.85 }}>
          Update ready — restart to apply
        </span>
      )}
      {status === "error" && (
        <span style={{ opacity: 0.7 }}>Update failed</span>
      )}
      {costUsd != null && (
        <span style={{ marginLeft: status !== "idle" && status !== "checking" ? 12 : 0 }}>
          ${costUsd.toFixed(2)}
        </span>
      )}
    </div>
  );
}
