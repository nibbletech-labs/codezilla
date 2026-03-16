import { useEffect, useCallback } from "react";
import { useAppStore } from "../store/appStore";
import type { BetaFeatures } from "../store/types";
import { modalStyles, modalKeyframes } from "../styles/modal";
import { useModalBackdrop } from "../hooks/useModalBackdrop";
import { removeLaunchdEntry } from "../lib/tauri";
import { syncLaunchdEntries } from "../lib/launchdSync";

const FEATURES: { key: keyof BetaFeatures; label: string; description: string }[] = [
  { key: "codexThreads", label: "Codex Threads", description: "Enable Codex (OpenAI) thread type" },
  { key: "skillsPlugins", label: "Skills & Plugins", description: "Browse and install skills and plugins" },
  { key: "scheduledJobs", label: "Scheduled Jobs", description: "Run tasks on a schedule via launchd" },
];

export default function BetaFeaturesManager() {
  const close = useAppStore((s) => s.closeBetaFeatures);
  const betaFeatures = useAppStore((s) => s.betaFeatures);
  const setBetaFeature = useAppStore((s) => s.setBetaFeature);
  const backdropStyle = useModalBackdrop();

  const handleToggle = useCallback((key: keyof BetaFeatures, checked: boolean) => {
    const state = useAppStore.getState();

    if (key === "scheduledJobs" && !checked) {
      // Disable: remove launchd entries for all enabled jobs before updating state
      const enabledJobs = state.scheduledJobs.filter((j) => j.enabled);
      for (const job of enabledJobs) {
        removeLaunchdEntry(job.id).catch(console.error);
      }
    }

    setBetaFeature(key, checked);

    if (key === "scheduledJobs" && checked) {
      // Re-enable: sync launchd with updated state
      const updated = useAppStore.getState();
      syncLaunchdEntries(updated.scheduledJobs, updated.projects).catch(console.error);
    }
  }, [setBetaFeature]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [close]);

  return (
    <div
      style={backdropStyle}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <style>{modalKeyframes}</style>
      <div style={{ ...modalStyles.modal, maxWidth: "480px" }}>
        <div style={modalStyles.header}>
          <span style={{ fontSize: "var(--font-size)", fontWeight: 600, color: "var(--text-primary)" }}>
            Beta Features
          </span>
          <button style={modalStyles.closeBtn} onClick={close}>&times;</button>
        </div>

        <div style={modalStyles.body}>
          <div style={{ color: "var(--text-secondary)", fontSize: "var(--font-size-sm)", marginBottom: "16px" }}>
            These features are still being tested. Toggle them on or off as needed.
          </div>

          {FEATURES.map(({ key, label, description }) => (
            <div
              key={key}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "12px 0",
                borderBottom: "1px solid var(--border-subtle, var(--border-default))",
              }}
            >
              <div style={{ flex: 1, marginRight: "16px" }}>
                <div style={{ color: "var(--text-primary)", fontSize: "var(--font-size)", fontWeight: 500 }}>
                  {label}
                </div>
                <div style={{ color: "var(--text-secondary)", fontSize: "var(--font-size-sm)", marginTop: "2px" }}>
                  {description}
                </div>
              </div>
              <ToggleSwitch
                checked={betaFeatures[key]}
                onChange={(checked) => handleToggle(key, checked)}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      style={{
        position: "relative",
        width: "36px",
        height: "20px",
        borderRadius: "10px",
        border: "none",
        backgroundColor: checked ? "var(--accent)" : "var(--bg-hover)",
        cursor: "pointer",
        padding: 0,
        flexShrink: 0,
        transition: "background-color 0.15s ease",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: "2px",
          left: checked ? "18px" : "2px",
          width: "16px",
          height: "16px",
          borderRadius: "50%",
          backgroundColor: checked ? "var(--text-on-accent)" : "var(--text-secondary)",
          transition: "left 0.15s ease, background-color 0.15s ease",
        }}
      />
    </button>
  );
}
