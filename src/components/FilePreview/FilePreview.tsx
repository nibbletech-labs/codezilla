import { lazy, Suspense, useEffect, useState, useCallback, useRef } from "react";
import { readFile, readFileBase64, getFileDiffStat, revealInFinder, writeFile } from "../../lib/tauri";
import { normalizeExternalUrl, openExternalUrl } from "../../lib/externalLinks";
import { sanitizeHtml } from "../../lib/sanitize";
import { isEditableMarkdownFile, isMarkdownFile, renderMarkdown } from "../../lib/markdownRenderer";
import { getMimeTypeFromPath, resolveMarkdownImageCandidates } from "../../lib/localMarkdownAssets";
import { highlightWithHljs } from "../../lib/hljs";
import { useAppStore } from "../../store/appStore";
import { useGitStatus } from "../../hooks/useGitStatus";
import { resolveProjectRootForPath } from "../../lib/worktree";
import DiffView from "./DiffView";
import type { MilkdownMarkdownEditorHandle } from "./MilkdownMarkdownEditor";

const MilkdownMarkdownEditor = lazy(() => import("./MilkdownMarkdownEditor"));

interface FilePreviewProps {
  filePath: string;
  line?: number;
  initialMode?: "preview" | "edit";
  onClose: () => void;
}

type FileCategory = "text" | "image" | "native";
type ViewMode = "file" | "diff" | "rendered" | "edit";
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

export default function FilePreview({ filePath, line, initialMode = "preview", onClose }: FilePreviewProps) {
  const [content, setContent] = useState<string | null>(null);
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isMarkdown = isMarkdownFile(filePath);
  const canEditMarkdown = isEditableMarkdownFile(filePath);
  const [viewMode, setViewMode] = useState<ViewMode>(
    initialMode === "edit" && canEditMarkdown ? "edit" : isMarkdown ? "rendered" : "file",
  );
  const [diffLayout, setDiffLayout] = useState<DiffLayout>("unified");
  const [editBaseContent, setEditBaseContent] = useState<string | null>(null);
  const [editDirty, setEditDirty] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editMessage, setEditMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isReloading, setIsReloading] = useState(false);
  const [editSessionId, setEditSessionId] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MilkdownMarkdownEditorHandle>(null);

  const fileName = filePath.split("/").pop() ?? filePath;
  const category = getFileCategory(filePath);

  // Git status for badge — scoped to the selected environment so the badge
  // reflects the chosen worktree when one is selected.
  const activeProject = useAppStore((s) => s.getActiveProject());
  const selectedEnvPath = useAppStore((s) => s.selectedEnvPath);
  const worktrees = useAppStore((s) => s.worktrees);
  const projectPath = resolveProjectRootForPath(
    filePath,
    activeProject?.path ?? null,
    selectedEnvPath,
    worktrees,
  );
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

  // Reset view mode when file changes
  useEffect(() => {
    setViewMode(initialMode === "edit" && canEditMarkdown ? "edit" : isMarkdown ? "rendered" : "file");
    setEditBaseContent(null);
    setEditDirty(false);
    setEditError(null);
    setEditMessage(null);
    setIsSaving(false);
    setIsReloading(false);
    setEditSessionId((id) => id + 1);
  }, [filePath, initialMode, isMarkdown, canEditMarkdown]);

  useEffect(() => {
    setContent(null);
    setImageDataUrl(null);
    setError(null);

    if (!projectPath) {
      setError("No active project");
      return;
    }

    if (category === "text") {
      readFile(filePath, projectPath)
        .then(setContent)
        .catch((err) => setError(String(err)));
    } else if (category === "image") {
      readFileBase64(filePath, projectPath)
        .then((b64) => {
          const mime = getMimeTypeFromPath(filePath);
          setImageDataUrl(`data:${mime};base64,${b64}`);
        })
        .catch((err) => setError(String(err)));
    }
  }, [filePath, category, projectPath]);

  useEffect(() => {
    if (viewMode !== "edit" || content === null || editBaseContent !== null) return;
    setEditBaseContent(content);
    setEditDirty(false);
    setEditError(null);
    setEditMessage(null);
    setEditSessionId((id) => id + 1);
  }, [viewMode, content, editBaseContent]);

  const enterEditMode = useCallback(() => {
    if (!canEditMarkdown || content === null) return;
    setEditBaseContent(content);
    setEditDirty(false);
    setEditError(null);
    setEditMessage(null);
    setEditSessionId((id) => id + 1);
    setViewMode("edit");
  }, [canEditMarkdown, content]);

  const cancelEditMode = useCallback(() => {
    setEditBaseContent(null);
    setEditDirty(false);
    setEditError(null);
    setEditMessage(null);
    setViewMode(isMarkdown ? "rendered" : "file");
  }, [isMarkdown]);

  const reloadEditContent = useCallback(async () => {
    if (!projectPath) return;
    setIsReloading(true);
    setEditError(null);
    setEditMessage(null);
    try {
      const latest = await readFile(filePath, projectPath);
      setContent(latest);
      setEditBaseContent(latest);
      setEditDirty(false);
      setEditSessionId((id) => id + 1);
      setEditMessage("Reloaded latest file");
    } catch (err) {
      setEditError(String(err));
    } finally {
      setIsReloading(false);
    }
  }, [filePath, projectPath]);

  const saveEditContent = useCallback(async () => {
    if (!projectPath || !canEditMarkdown || content === null) return;
    const baseContent = editBaseContent ?? content;
    const nextContent = editorRef.current?.getMarkdown() ?? baseContent;

    setIsSaving(true);
    setEditError(null);
    setEditMessage(null);
    try {
      const diskContent = await readFile(filePath, projectPath);
      if (diskContent !== baseContent) {
        setEditError("This file changed on disk. Reload before saving to avoid overwriting newer changes.");
        return;
      }

      await writeFile(filePath, projectPath, nextContent);
      setContent(nextContent);
      setEditBaseContent(nextContent);
      setEditDirty(false);
      setEditMessage("Saved");
      setViewMode("rendered");
    } catch (err) {
      setEditError(String(err));
    } finally {
      setIsSaving(false);
    }
  }, [canEditMarkdown, content, editBaseContent, filePath, projectPath]);

  const requestClose = useCallback(() => {
    if (viewMode === "edit" && editDirty) {
      setEditError("Save or Cancel before closing this editor.");
      return;
    }
    onClose();
  }, [editDirty, onClose, viewMode]);

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
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const isTextInput =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        Boolean(target?.closest("[contenteditable='true'], .milkdown"));

      if (viewMode === "edit") {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          e.stopPropagation();
          saveEditContent();
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          if (editDirty) {
            setEditError("Save or Cancel before closing this editor.");
          } else {
            cancelEditMode();
          }
          return;
        }
        return;
      }

      if (e.key === "Escape" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        requestClose();
        return;
      }
      // Swallow Backspace/Delete so they don't leak through to the terminal behind the preview
      if (e.key === "Backspace" || e.key === "Delete") {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // D toggles diff view
      if (e.key === "d" || e.key === "D") {
        if (isTextInput) return;
        e.preventDefault();
        setViewMode((v) => {
          if (v === "diff") return isMarkdown ? "rendered" : "file";
          return "diff";
        });
        return;
      }
      // M toggles rendered/raw for markdown files
      if (e.key === "m" || e.key === "M") {
        if (isTextInput) return;
        if (!isMarkdown) return;
        e.preventDefault();
        setViewMode((v) => (v === "rendered" ? "file" : "rendered"));
        return;
      }
      // S toggles diff layout (only in diff mode)
      if (e.key === "s" || e.key === "S") {
        if (isTextInput) return;
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
  }, [cancelEditMode, editDirty, isMarkdown, requestClose, saveEditContent, viewMode]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) requestClose();
    },
    [requestClose],
  );

  const handleMarkdownClick = useCallback((e: React.MouseEvent) => {
    const anchor = (e.target as HTMLElement).closest("a");
    if (!anchor) return;
    e.preventDefault();
    const href = anchor.getAttribute("href");
    if (!href) return;
    if (href.startsWith("#")) {
      // Internal anchor — scroll within the preview body
      const target = bodyRef.current?.querySelector(decodeURIComponent(href));
      if (target) target.scrollIntoView({ behavior: "smooth" });
    } else if (normalizeExternalUrl(href)) {
      openExternalUrl(href, e);
    }
  }, []);

  let renderedMarkdownHtml: string | null = null;
  if (isMarkdown && content && viewMode === "rendered") {
    renderedMarkdownHtml = renderMarkdown(content);
  }

  useEffect(() => {
    if (viewMode !== "rendered" || !renderedMarkdownHtml || !projectPath || !bodyRef.current) return;

    const previewBody = bodyRef.current;
    let cancelled = false;

    const resolveImages = async () => {
      const images = Array.from(previewBody.querySelectorAll<HTMLImageElement>(".md-rendered img[src]"));

      await Promise.all(images.map(async (img) => {
        const src = img.getAttribute("src");
        if (!src) return;

        const candidates = resolveMarkdownImageCandidates(src, filePath, projectPath);
        if (candidates.length === 0) return;

        for (const candidate of candidates) {
          try {
            const b64 = await readFileBase64(candidate, projectPath);
            if (cancelled || !previewBody.contains(img)) return;

            img.dataset.codezillaResolvedSrc = candidate;
            img.src = `data:${getMimeTypeFromPath(candidate)};base64,${b64}`;
            return;
          } catch {
            // Try the next candidate. Root-relative site assets commonly live
            // in either /public or the project root depending on framework.
          }
        }
      }));
    };

    resolveImages();

    return () => {
      cancelled = true;
    };
  }, [filePath, projectPath, renderedMarkdownHtml, viewMode]);

  const lang = getLangFromPath(filePath);

  // Use hljs for code highlighting — Shiki uses inline style="" attributes
  // which are blocked by Tauri's CSP (nonce-based policy overrides unsafe-inline).
  // hljs uses CSS classes instead, which work with external stylesheets.
  let highlightedHtml: string | null = null;
  if (content && lang) {
    const fallback = highlightWithHljs(content, lang);
    if (fallback) highlightedHtml = sanitizeHtml(fallback);
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

    if (viewMode === "edit" && canEditMarkdown && content !== null) {
      const editorContent = editBaseContent ?? content;
      return (
        <div style={styles.editorShell}>
          {(editError || editMessage) && (
            <div
              style={{
                ...styles.editBanner,
                ...(editError ? styles.editBannerError : styles.editBannerInfo),
              }}
            >
              <span>{editError ?? editMessage}</span>
              {editError?.includes("changed on disk") && (
                <button
                  style={styles.inlineButton}
                  onClick={reloadEditContent}
                  disabled={isReloading || isSaving}
                >
                  {isReloading ? "Reloading..." : "Reload"}
                </button>
              )}
            </div>
          )}
          <Suspense fallback={<div style={styles.loading}>Loading editor...</div>}>
            <MilkdownMarkdownEditor
              key={editSessionId}
              ref={editorRef}
              value={editorContent}
              onChange={(markdown) => {
                setEditDirty(markdown !== editorContent);
                if (editError && !editError.includes("changed on disk")) setEditError(null);
                if (editMessage) setEditMessage(null);
              }}
            />
          </Suspense>
        </div>
      );
    }

    if (viewMode === "rendered" && renderedMarkdownHtml) {
      return (
        <div className="file-preview-markdown" style={styles.markdownBody} onClick={handleMarkdownClick}>
          <div
            className="md-rendered"
            dangerouslySetInnerHTML={{ __html: renderedMarkdownHtml }}
          />
        </div>
      );
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
          <div
            className="shiki-wrap"
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
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
            {viewMode !== "diff" && fileDiffStat && (
              <span style={{ fontSize: "11px", whiteSpace: "nowrap" }}>
                <span style={{ color: "#89d185" }}>+{fileDiffStat[0]}</span>
                {" "}
                <span style={{ color: "#f48771" }}>-{fileDiffStat[1]}</span>
              </span>
            )}
          </div>
          <div style={styles.headerRight}>
            <span style={styles.hint}>
              {viewMode === "edit" ? (
                <>
                  {editDirty ? "Unsaved changes" : isSaving ? "Saving..." : "Editing"}
                </>
              ) : viewMode === "diff" ? (
                <>
                  <kbd style={styles.kbd}>D</kbd> File
                  {" "}
                  <kbd style={styles.kbd}>S</kbd> {diffLayout === "unified" ? "Split" : "Unified"}
                  {isMarkdown && <>{" "}<kbd style={styles.kbd}>M</kbd> Rendered</>}
                </>
              ) : viewMode === "rendered" ? (
                <>
                  <kbd style={styles.kbd}>M</kbd> Raw
                  {" "}
                  <kbd style={styles.kbd}>D</kbd> Diff
                </>
              ) : (
                <>
                  <kbd style={styles.kbd}>D</kbd> Diff
                  {isMarkdown && <>{" "}<kbd style={styles.kbd}>M</kbd> Rendered</>}
                </>
              )}
            </span>
            {viewMode === "edit" ? (
              <>
                <button
                  style={styles.secondaryButton}
                  onClick={cancelEditMode}
                  disabled={isSaving || isReloading}
                >
                  Cancel
                </button>
                <button
                  style={{
                    ...styles.primaryButton,
                    ...(!editDirty || isSaving || isReloading ? styles.primaryButtonDisabled : {}),
                  }}
                  onClick={saveEditContent}
                  disabled={!editDirty || isSaving || isReloading}
                  title="Save Markdown"
                >
                  {isSaving ? "Saving..." : "Save"}
                </button>
              </>
            ) : (
              canEditMarkdown && content !== null && (
                <button style={styles.secondaryButton} onClick={enterEditMode}>
                  Edit
                </button>
              )
            )}
            <button
              style={styles.closeButton}
              onClick={() => projectPath && revealInFinder(filePath, projectPath)}
              title="Reveal in Finder"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <path d="M1.5 2A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5V5.5A1.5 1.5 0 0 0 14.5 4H8.21l-1.6-1.6A1.5 1.5 0 0 0 5.55 2H1.5z" />
              </svg>
            </button>
            <button style={styles.closeButton} onClick={requestClose}>
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
    jsonc: "json",
    json5: "json",
    html: "html",
    htm: "html",
    css: "css",
    md: "markdown",
    markdown: "markdown",
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
  secondaryButton: {
    background: "var(--bg-hover)",
    border: "1px solid var(--border-default)",
    color: "var(--text-primary)",
    fontSize: "12px",
    cursor: "pointer",
    padding: "3px 9px",
    borderRadius: "4px",
    lineHeight: "16px",
  } as React.CSSProperties,
  primaryButton: {
    background: "var(--accent)",
    border: "1px solid var(--accent)",
    color: "#fff",
    fontSize: "12px",
    cursor: "pointer",
    padding: "3px 10px",
    borderRadius: "4px",
    lineHeight: "16px",
    fontWeight: 600,
  } as React.CSSProperties,
  primaryButtonDisabled: {
    opacity: 0.55,
    cursor: "default",
  } as React.CSSProperties,
  body: {
    flex: 1,
    overflowY: "auto" as const,
    overflowX: "hidden" as const,
    padding: 0,
    position: "relative" as const,
  } as React.CSSProperties,
  editorShell: {
    height: "100%",
    display: "flex",
    flexDirection: "column" as const,
    background: "var(--bg-primary)",
  } as React.CSSProperties,
  editBanner: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "12px",
    padding: "8px 16px",
    borderBottom: "1px solid var(--border-default)",
    fontSize: "12px",
    flexShrink: 0,
  } as React.CSSProperties,
  editBannerError: {
    color: "#f48771",
    background: "rgba(244, 135, 113, 0.08)",
  } as React.CSSProperties,
  editBannerInfo: {
    color: "var(--text-secondary)",
    background: "var(--bg-panel)",
  } as React.CSSProperties,
  inlineButton: {
    background: "var(--bg-hover)",
    border: "1px solid var(--border-default)",
    color: "var(--text-primary)",
    fontSize: "12px",
    cursor: "pointer",
    padding: "3px 8px",
    borderRadius: "4px",
    lineHeight: "16px",
    flexShrink: 0,
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
  markdownBody: {
    overflowWrap: "break-word" as const,
    wordBreak: "break-word" as const,
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
