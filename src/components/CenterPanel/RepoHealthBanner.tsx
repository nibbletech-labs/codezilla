import { useEffect, useState } from "react";
import { useAppStore, SLOW_GIT_MS } from "../../store/appStore";
import { diagnoseRepoHealth } from "../../lib/tauri";

// Re-warn after a dismissal only if git gets meaningfully worse than it was
// when the user dismissed — otherwise the banner would nag forever.
const REWARN_FACTOR = 2;

// Paths diagnosed this session (including failed attempts) — the deep scan
// runs at most once per project per session.
const diagnosed = new Set<string>();

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

export default function RepoHealthBanner() {
  const projectPath = useAppStore(
    (s) => s.projects.find((p) => p.id === s.activeProjectId)?.path ?? null,
  );
  const flagged = useAppStore(
    (s) => (projectPath ? !!s.repoHealthFlagged[projectPath] : false),
  );
  const health = useAppStore(
    (s) => (projectPath ? s.repoHealth[projectPath] : undefined),
  );
  const dismissal = useAppStore(
    (s) => (projectPath ? s.repoHealthDismissals[projectPath] : undefined),
  );
  const setRepoHealth = useAppStore((s) => s.setRepoHealth);
  const dismissRepoHealth = useAppStore((s) => s.dismissRepoHealth);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!flagged || !projectPath || diagnosed.has(projectPath)) return;
    diagnosed.add(projectPath);
    diagnoseRepoHealth(projectPath)
      .then((h) => setRepoHealth(projectPath, h))
      .catch((e) => console.error("Repo health diagnosis failed:", e));
  }, [flagged, projectPath, setRepoHealth]);

  if (!projectPath || !flagged || !health) return null;
  // The slow streak can trip during transient system-wide load; trust the
  // controlled re-measurement and stand down if nothing is actually wrong.
  if (health.status_duration_ms < SLOW_GIT_MS && health.suspicious.length === 0) {
    return null;
  }
  if (dismissal && health.status_duration_ms <= dismissal.statusDurationMs * REWARN_FACTOR) {
    return null;
  }

  const suspiciousTotal = health.suspicious.reduce((sum, s) => sum + s.count, 0);
  const fixCommands =
    health.suspicious.length > 0
      ? [
          ...health.suspicious.map((s) => `echo '${s.dir}/' >> .gitignore`),
          `git rm -r --cached ${health.suspicious.map((s) => `'${s.dir}'`).join(" ")}`,
        ].join("\n")
      : null;

  const copyFix = () => {
    if (!fixCommands) return;
    navigator.clipboard.writeText(fixCommands).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div style={styles.banner}>
      <span style={styles.icon}>⚠️</span>
      <div style={styles.body}>
        <div style={styles.title}>Git in this project is slowing Codezilla down</div>
        <div style={styles.detail}>
          {`git status took ${formatDuration(health.status_duration_ms)} (${health.dirty_count.toLocaleString()} uncommitted files).`}
          {health.suspicious.length > 0 && (
            <>
              {" "}
              {`${suspiciousTotal.toLocaleString()} tracked files look like build output or dependencies (${health.suspicious.map((s) => s.dir).join(", ")}) — adding them to .gitignore and untracking them will fix this.`}
            </>
          )}
        </div>
      </div>
      <div style={styles.actions}>
        {fixCommands && (
          <button style={styles.button} onClick={copyFix}>
            {copied ? "Copied!" : "Copy fix"}
          </button>
        )}
        <button style={styles.button} onClick={() => dismissRepoHealth(projectPath)}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  banner: {
    position: "absolute",
    top: 8,
    left: 12,
    right: 12,
    zIndex: 20,
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: "10px 12px",
    borderRadius: 8,
    backgroundColor: "var(--bg-secondary)",
    border: "1px solid var(--border-default)",
    borderLeft: "3px solid #e5a50a",
    boxShadow: "0 4px 16px rgba(0, 0, 0, 0.3)",
    fontSize: "var(--font-size-sm)",
    color: "var(--text-primary)",
  },
  icon: {
    flexShrink: 0,
    lineHeight: "1.4",
  },
  body: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontWeight: 600,
    marginBottom: 2,
  },
  detail: {
    color: "var(--text-secondary)",
    lineHeight: 1.45,
  },
  actions: {
    display: "flex",
    gap: 6,
    flexShrink: 0,
  },
  button: {
    padding: "4px 10px",
    borderRadius: 5,
    border: "1px solid var(--border-default)",
    backgroundColor: "transparent",
    color: "var(--text-primary)",
    fontSize: "var(--font-size-sm)",
    cursor: "pointer",
  },
};
