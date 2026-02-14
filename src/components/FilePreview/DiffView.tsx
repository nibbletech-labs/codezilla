import { useEffect, useState } from "react";
import { html as diff2htmlHtml } from "diff2html";
import { getGitDiff } from "../../lib/tauri";
import { sanitizeHtml } from "../../lib/sanitize";
import { useAppStore } from "../../store/appStore";

interface DiffViewProps {
  filePath: string;
  layout: "unified" | "side-by-side";
}

export default function DiffView({ filePath, layout }: DiffViewProps) {
  const [diffHtml, setDiffHtml] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeProject = useAppStore((s) => s.getActiveProject());
  const projectPath = activeProject?.path ?? null;

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
      <style>{DIFF_DARK_CSS}</style>
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

// Dark theme overrides for diff2html
const DIFF_DARK_CSS = `
  .d2h-wrapper {
    background: transparent !important;
  }
  .d2h-file-header {
    display: none !important;
  }
  .d2h-file-wrapper {
    border: none !important;
    margin: 0 !important;
  }
  .d2h-code-wrapper {
    background: transparent !important;
  }
  .d2h-code-line,
  .d2h-code-side-line {
    background: var(--bg-primary) !important;
    color: var(--text-primary) !important;
    padding-left: 8px !important;
  }
  .d2h-code-line-ctn {
    color: var(--text-primary) !important;
  }
  .d2h-ins .d2h-code-line,
  .d2h-ins .d2h-code-side-line,
  .d2h-ins.d2h-code-side-line {
    background: rgba(35, 134, 54, 0.2) !important;
  }
  .d2h-ins .d2h-code-line-ctn {
    background: rgba(35, 134, 54, 0.2) !important;
  }
  .d2h-del .d2h-code-line,
  .d2h-del .d2h-code-side-line,
  .d2h-del.d2h-code-side-line {
    background: rgba(248, 81, 73, 0.2) !important;
  }
  .d2h-del .d2h-code-line-ctn {
    background: rgba(248, 81, 73, 0.2) !important;
  }
  .d2h-code-linenumber {
    background: var(--bg-panel) !important;
    color: var(--text-hint) !important;
    border-right: 1px solid var(--border-default) !important;
  }
  .d2h-code-side-linenumber {
    background: var(--bg-panel) !important;
    color: var(--text-hint) !important;
    border-right: 1px solid var(--border-default) !important;
  }
  .d2h-diff-table {
    border-collapse: collapse;
    width: 100%;
  }
  .d2h-diff-tbody > tr {
    border: none !important;
  }
  .d2h-info {
    background: var(--bg-panel) !important;
    color: var(--diff-info-color) !important;
    border: none !important;
  }
  .d2h-emptyplaceholder {
    background: var(--bg-empty-placeholder) !important;
    border: none !important;
  }
  .d2h-tag {
    display: none !important;
  }
  /* Word-level highlights */
  .d2h-ins ins,
  .d2h-ins .d2h-change {
    background: rgba(35, 134, 54, 0.4) !important;
    color: var(--text-primary) !important;
    text-decoration: none !important;
  }
  .d2h-del del,
  .d2h-del .d2h-change {
    background: rgba(248, 81, 73, 0.4) !important;
    color: var(--text-primary) !important;
    text-decoration: none !important;
  }
`;
