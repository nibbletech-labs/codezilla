import { useEffect, useState } from "react";
import { html as diff2htmlHtml } from "diff2html";
import { getGitDiff } from "../../lib/tauri";
import { sanitizeHtml } from "../../lib/sanitize";
import { useAppStore } from "../../store/appStore";
import { resolveProjectRootForPath } from "../../lib/worktree";
import "../../styles/diffView.css";

interface DiffViewProps {
  filePath: string;
  layout: "unified" | "side-by-side";
}

export default function DiffView({ filePath, layout }: DiffViewProps) {
  const [diffHtml, setDiffHtml] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeProject = useAppStore((s) => s.getActiveProject());
  const selectedEnvPath = useAppStore((s) => s.selectedEnvPath);
  const worktrees = useAppStore((s) => s.worktrees);
  const projectPath = resolveProjectRootForPath(
    filePath,
    activeProject?.path ?? null,
    selectedEnvPath,
    worktrees,
  );

  useEffect(() => {
    setDiffHtml(null);
    setEmpty(false);
    setError(null);

    if (!projectPath) return;

    const root = projectPath.endsWith("/") ? projectPath : projectPath + "/";
    const relPath = filePath.startsWith(root) ? filePath.slice(root.length) : filePath;

    getGitDiff(projectPath, relPath)
      .then((diffText) => {
        if (!diffText.trim()) {
          setEmpty(true);
          return;
        }
        const rendered = diff2htmlHtml(diffText, {
          drawFileList: false,
          matching: "lines",
          outputFormat: layout === "side-by-side" ? "side-by-side" : "line-by-line",
        });
        setDiffHtml(rendered);
      })
      .catch((err) => setError(String(err)));
  }, [filePath, projectPath, layout]);

  if (error) {
    return <div style={styles.message}>{error}</div>;
  }
  if (empty) {
    return <div style={styles.message}>No uncommitted changes</div>;
  }
  if (diffHtml === null) {
    return <div style={styles.message}>Loading diff...</div>;
  }

  return (
    <div style={styles.container}>
      <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(diffHtml) }} />
    </div>
  );
}

const styles = {
  container: {
    fontSize: "13px",
    lineHeight: "1.5",
    fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
    padding: "0",
    overflowX: "auto" as const,
  },
  message: {
    padding: "24px",
    textAlign: "center" as const,
    color: "var(--text-secondary)",
    fontSize: "13px",
  },
};
