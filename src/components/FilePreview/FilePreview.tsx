import { useEffect, useState, useCallback, useRef } from "react";
import { readFile, readFileBase64, getFileDiffStat } from "../../lib/tauri";
import { sanitizeHtml } from "../../lib/sanitize";
import { useShiki } from "../../hooks/useShiki";
import { useAppStore } from "../../store/appStore";
import { useGitStatus } from "../../hooks/useGitStatus";
import { useResolvedAppearance } from "../../hooks/useResolvedAppearance";
import DiffView from "./DiffView";

interface FilePreviewProps {
  filePath: string;
  line?: number;
  onClose: () => void;
}

type FileCategory = "text" | "image" | "native";
type ViewMode = "file" | "diff";
type DiffLayout = "unified" | "side-by-side";

const IMAGE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "tiff", "tif",
]);

const NATIVE_EXTS = new Set([
  // Video
  "mp4", "webm", "mov", "avi", "mkv", "m4v",
  // Audio
  "mp3", "wav", "aac", "flac", "ogg", "m4a",
  // Documents
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  // Archives
  "zip", "tar", "gz", "bz2", "7z", "rar",
  // Other binary
  "exe", "dmg", "app", "wasm", "o", "dylib", "so",
]);

function getFileCategory(filePath: string): FileCategory {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (!ext) return "text";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (NATIVE_EXTS.has(ext)) return "native";
  return "text";
}

const MIME_MAP: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  tiff: "image/tiff",
  tif: "image/tiff",
};

function getMimeType(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return MIME_MAP[ext] ?? "application/octet-stream";
}

export default function FilePreview({ filePath, line, onClose }: FilePreviewProps) {
  const [content, setContent] = useState<string | null>(null);
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("file");
  const [diffLayout, setDiffLayout] = useState<DiffLayout>("unified");
  const highlighter = useShiki();
  const resolvedAppearance = useResolvedAppearance();
  const bodyRef = useRef<HTMLDivElement>(null);

  const fileName = filePath.split("/").pop() ?? filePath;
  const category = getFileCategory(filePath);

  // Git status for badge
  const activeProject = useAppStore((s) => s.getActiveProject());
  const projectPath = activeProject?.path ?? null;
  const gitStatus = useGitStatus(projectPath);
  const fileGitStatus = gitStatus.get(filePath);
  const [fileDiffStat, setFileDiffStat] = useState<[number, number] | null>(null);

  // Fetch per-file diff stats
  useEffect(() => {
    setFileDiffStat(null);
    if (!projectPath || !fileGitStatus) return;
    // Get relative path for git
    const root = projectPath.endsWith("/") ? projectPath : projectPath + "/";
    const relPath = filePath.startsWith(root) ? filePath.slice(root.length) : filePath;
    getFileDiffStat(projectPath, relPath)
      .then((stat) => {
        if (stat[0] > 0 || stat[1] > 0) setFileDiffStat(stat);
      })
      .catch(() => {});
  }, [filePath, projectPath, fileGitStatus]);

  useEffect(() => {
    setContent(null);
    setImageDataUrl(null);
    setError(null);

    if (category === "text") {
      readFile(filePath, projectPath ?? undefined)
        .then(setContent)
        .catch((err) => setError(String(err)));
    } else if (category === "image") {
      readFileBase64(filePath, projectPath ?? undefined)
        .then((b64) => {
          const mime = getMimeType(filePath);
          setImageDataUrl(`data:${mime};base64,${b64}`);
        })
        .catch((err) => setError(String(err)));
    }
  }, [filePath, category, projectPath]);

  // Scroll to target line after content renders
  useEffect(() => {
    if (!line || !bodyRef.current || viewMode !== "file") return;
    // Small delay to let shiki rendering settle
    const timer = setTimeout(() => {
      if (!bodyRef.current) return;
      const lineEl = bodyRef.current.querySelector(
        `.shiki .line:nth-child(${line})`
      );
      if (lineEl) {
        lineEl.scrollIntoView({ block: "center" });
        lineEl.classList.add("highlight-line");
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [line, content, viewMode]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      // D toggles diff view
      if (e.key === "d" || e.key === "D") {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        setViewMode((v) => (v === "file" ? "diff" : "file"));
        return;
      }
      // S toggles diff layout (only in diff mode)
      if (e.key === "s" || e.key === "S") {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        e.preventDefault();
        setViewMode((current) => {
          if (current === "diff") {
            setDiffLayout((l) => (l === "unified" ? "side-by-side" : "unified"));
          }
          return current;
        });
        return;
      }
    };
    // Use capture phase so we intercept before xterm's handler sends keys to PTY
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  const lang = getLangFromPath(filePath);

  let highlightedHtml: string | null = null;
  if (highlighter && content && lang) {
    try {
      highlightedHtml = highlighter.codeToHtml(content, {
        lang,
        theme: resolvedAppearance === "dark" ? "vitesse-dark" : "vitesse-light",
      });
    } catch {
      // Language not loaded — fall back to plain text
    }
  }

  const isLoading =
    (category === "text" && content === null && !error) ||
    (category === "image" && imageDataUrl === null && !error);

  const renderBody = () => {
    if (viewMode === "diff") {
      return <DiffView filePath={filePath} layout={diffLayout} />;
    }

    if (error) {
      return <div style={styles.error}>{error}</div>;
    }
    if (isLoading) {
      return <div style={styles.loading}>Loading...</div>;
    }

    if (category === "image" && imageDataUrl) {
      return (
        <div style={styles.mediaContainer}>
          <img src={imageDataUrl} alt={fileName} style={styles.image} />
        </div>
      );
    }

    if (highlightedHtml) {
      return (
        <div style={styles.code}>
          <style>{LINE_NUMBER_CSS}</style>
          <div
            className="shiki-wrap"
            dangerouslySetInnerHTML={{ __html: sanitizeHtml(highlightedHtml) }}
          />
        </div>
      );
    }

    return <pre style={styles.plainText}>{content}</pre>;
  };

  // Git status badge
  const gitBadge = fileGitStatus
    ? fileGitStatus === "Untracked"
      ? { label: "New", color: "#89d185" }
      : fileGitStatus === "Modified"
        ? { label: "Modified", color: "#e2c08d" }
        : fileGitStatus === "Added"
          ? { label: "Added", color: "#89d185" }
          : fileGitStatus === "Deleted"
            ? { label: "Deleted", color: "#f48771" }
            : { label: fileGitStatus, color: "#ccc" }
    : null;

  return (
    <div style={styles.backdrop} onClick={handleBackdropClick}>
      <style>{`
        @keyframes preview-backdrop-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes preview-modal-in {
          from { opacity: 0; transform: scale(0.96); }
          to { opacity: 1; transform: scale(1); }
        }
        @keyframes highlight-fade {
          0% { background-color: rgba(255, 213, 79, 0.3); }
          100% { background-color: transparent; }
        }
        .highlight-line {
          animation: highlight-fade 2s ease-out forwards;
        }
      `}</style>
      <div style={styles.modal}>
        <div style={styles.header}>
          <div style={styles.headerLeft}>
            <span style={styles.fileName}>{fileName}</span>
            {gitBadge && (
              <span style={{ ...styles.badge, color: gitBadge.color, borderColor: gitBadge.color }}>
                {gitBadge.label}
              </span>
            )}
            {viewMode === "file" && fileDiffStat && (
              <span style={{ fontSize: "11px", whiteSpace: "nowrap" }}>
                <span style={{ color: "#89d185" }}>+{fileDiffStat[0]}</span>
                {" "}
                <span style={{ color: "#f48771" }}>-{fileDiffStat[1]}</span>
              </span>
            )}
          </div>
          <div style={styles.headerRight}>
            <span style={styles.hint}>
              {viewMode === "diff" ? (
                <>
                  <kbd style={styles.kbd}>D</kbd> File
                  {" "}
                  <kbd style={styles.kbd}>S</kbd> {diffLayout === "unified" ? "Split" : "Unified"}
                </>
              ) : (
                <>
                  <kbd style={styles.kbd}>D</kbd> Diff
                </>
              )}
            </span>
            <button style={styles.closeButton} onClick={onClose}>
              &times;
            </button>
          </div>
        </div>

        <div ref={bodyRef} style={styles.body}>{renderBody()}</div>
      </div>
    </div>
  );
}

/** Returns true if this file should use native macOS Quick Look instead of in-app preview */
export function shouldUseNativePreview(filePath: string): boolean {
  return getFileCategory(filePath) === "native";
}

function getLangFromPath(filePath: string): string | null {
  const ext = filePath.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    ts: "typescript",
    tsx: "tsx",
    jsx: "jsx",
    json: "json",
    html: "html",
    htm: "html",
    css: "css",
    md: "markdown",
    mdx: "markdown",
    rs: "rust",
    py: "python",
    go: "go",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    sql: "sql",
    c: "c",
    h: "c",
    cpp: "cpp",
    hpp: "cpp",
  };
  return ext ? map[ext] ?? null : null;
}

const LINE_NUMBER_CSS = `
  .shiki-wrap pre { white-space: pre-wrap !important; word-break: break-word !important; overflow-x: hidden !important; }
  .shiki code { counter-reset: line; }
  .shiki .line::before {
    counter-increment: line;
    content: counter(line);
    display: inline-block;
    width: 3em;
    text-align: right;
    margin-right: 1em;
    color: var(--text-hint);
    user-select: none;
  }
`;

const styles = {
  backdrop: {
    position: "fixed" as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "color-mix(in srgb, var(--bg-primary) 60%, transparent)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
    animation: "preview-backdrop-in 0.15s ease-out",
  } as React.CSSProperties,
  modal: {
    width: "calc(100vw - 250px - var(--right-panel-width, 250px) - 10px)",
    height: "calc(100vh - 24px - 10px)",
    backgroundColor: "var(--bg-primary)",
    borderRadius: "8px",
    border: "1px solid var(--border-default)",
    display: "flex",
    flexDirection: "column" as const,
    overflow: "hidden",
    boxShadow: "0 8px 32px rgba(0, 0, 0, 0.5)",
    animation: "preview-modal-in 0.15s ease-out",
  } as React.CSSProperties,
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "6px 16px",
    borderBottom: "1px solid var(--border-default)",
    backgroundColor: "var(--bg-panel)",
    flexShrink: 0,
  } as React.CSSProperties,
  headerLeft: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    overflow: "hidden",
    minWidth: 0,
  } as React.CSSProperties,
  headerRight: {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    flexShrink: 0,
  } as React.CSSProperties,
  fileName: {
    color: "var(--text-primary)",
    fontSize: "13px",
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  } as React.CSSProperties,
  badge: {
    fontSize: "10px",
    padding: "1px 6px",
    borderRadius: "3px",
    border: "1px solid",
    whiteSpace: "nowrap" as const,
  } as React.CSSProperties,
  hint: {
    color: "var(--text-hint)",
    fontSize: "11px",
    whiteSpace: "nowrap" as const,
  } as React.CSSProperties,
  kbd: {
    display: "inline-block",
    background: "var(--kbd-bg)",
    color: "var(--kbd-text)",
    padding: "0 4px",
    borderRadius: "3px",
    fontSize: "10px",
    lineHeight: "16px",
    border: "1px solid var(--kbd-border)",
    fontFamily: "inherit",
  } as React.CSSProperties,
  closeButton: {
    background: "none",
    border: "none",
    color: "var(--text-secondary)",
    fontSize: "18px",
    cursor: "pointer",
    padding: "0 4px",
    lineHeight: 1,
  } as React.CSSProperties,
  body: {
    flex: 1,
    overflowY: "auto" as const,
    overflowX: "hidden" as const,
    padding: 0,
    position: "relative" as const,
  } as React.CSSProperties,
  mediaContainer: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    height: "100%",
    padding: "8px",
    boxSizing: "border-box" as const,
  } as React.CSSProperties,
  image: {
    maxWidth: "100%",
    maxHeight: "100%",
    objectFit: "contain" as const,
  } as React.CSSProperties,
  code: {
    fontSize: "13px",
    lineHeight: "1.5",
    fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
    overflowWrap: "break-word" as const,
    wordBreak: "break-word" as const,
    padding: "12px 16px",
  } as React.CSSProperties,
  plainText: {
    color: "var(--text-primary)",
    fontSize: "13px",
    lineHeight: "1.5",
    fontFamily: "'SF Mono', 'Menlo', 'Monaco', 'Courier New', monospace",
    margin: 0,
    padding: "12px 16px",
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
  } as React.CSSProperties,
  loading: {
    padding: "24px",
    textAlign: "center" as const,
    color: "var(--text-secondary)",
    fontSize: "12px",
  } as React.CSSProperties,
  placeholder: {
    padding: "24px",
    textAlign: "center" as const,
    color: "var(--text-secondary)",
    fontSize: "13px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
  } as React.CSSProperties,
  error: {
    padding: "24px",
    textAlign: "center" as const,
    color: "#f44747",
    fontSize: "12px",
  } as React.CSSProperties,
};
