import { lazy, Suspense, useEffect, useState, useCallback, useRef } from "react";
import { readFile, readFileBase64, getFileDiffStat, revealInFinder, writeFile } from "../../lib/tauri";
import { normalizeExternalUrl, openExternalUrl } from "../../lib/externalLinks";
import { sanitizeHtml } from "../../lib/sanitize";
import { isMarkdownFile, renderMarkdown } from "../../lib/markdownRenderer";
import { getMimeTypeFromPath, resolveMarkdownImageCandidates } from "../../lib/localMarkdownAssets";
import { highlightWithHljs } from "../../lib/hljs";
import { useAppStore } from "../../store/appStore";
import { useResolvedAppearance } from "../../hooks/useResolvedAppearance";
import { useGitStatus } from "../../hooks/useGitStatus";
import { resolveProjectRootForPath } from "../../lib/worktree";
import DiffView from "./DiffView";
import type { MarkdownSourceEditorHandle } from "./MarkdownSourceEditor";

const MarkdownSourceEditor = lazy(() => import("./MarkdownSourceEditor"));

interface FilePreviewProps {
  filePath: string;
  line?: number;
  initialMode?: "preview" | "edit";
  onClose: () => void;
}

type FileCategory = "text" | "image" | "native";
// "rendered" = read-only rich-text preview; "source" = editable raw markdown;
// "file" = read-only highlighted source for non-markdown text files.
type ViewMode = "file" | "diff" | "rendered" | "source";
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
  // All markdown files are editable now — raw source editing has none of the
  // round-trip fragility that previously limited editing to plain `.md`.
  const canEditMarkdown = isMarkdown;
  const [viewMode, setViewMode] = useState<ViewMode>(
    initialMode === "edit" && canEditMarkdown ? "source" : isMarkdown ? "rendered" : "file",
  );
  const [diffLayout, setDiffLayout] = useState<DiffLayout>("unified");
  // Live editor buffer. Null until the source view has been opened for this
  // file; once set it is the source of truth for the rendered preview too.
  const [draft, setDraft] = useState<string | null>(null);
  const [editDirty, setEditDirty] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editMessage, setEditMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isReloading, setIsReloading] = useState(false);
  const [editSessionId, setEditSessionId] = useState(0);
  // When set, a switch/close was requested while there were unsaved edits; the
  // pending destination is held until the user resolves the prompt.
  const [pendingExit, setPendingExit] = useState<{ kind: "close" } | { kind: "view"; target: ViewMode } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MarkdownSourceEditorHandle>(null);
  const appearance = useResolvedAppearance();

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

  // Fetch the per-file +/- diff stat. Exposed as a callback so a save can
  // refresh it immediately rather than waiting on the next git-status poll
  // (which never fires the effect below when the status stays "Modified").
  const refreshDiffStat = useCallback(async () => {
    if (!projectPath) {
      setFileDiffStat(null);
      return;
    }
    const root = projectPath.endsWith("/") ? projectPath : projectPath + "/";
    const relPath = filePath.startsWith(root) ? filePath.slice(root.length) : filePath;
    try {
      const stat = await getFileDiffStat(projectPath, relPath);
      setFileDiffStat(stat[0] > 0 || stat[1] > 0 ? stat : null);
    } catch {
      // Leave the previous value in place on a transient git failure.
    }
  }, [filePath, projectPath]);

  // Fetch per-file diff stats when the file or its git status changes
  useEffect(() => {
    setFileDiffStat(null);
    if (!projectPath || !fileGitStatus) return;
    refreshDiffStat();
  }, [filePath, projectPath, fileGitStatus, refreshDiffStat]);

  // Reset view mode when file changes
  useEffect(() => {
    setViewMode(initialMode === "edit" && canEditMarkdown ? "source" : isMarkdown ? "rendered" : "file");
    setDraft(null);
    setEditDirty(false);
    setEditError(null);
    setEditMessage(null);
    setIsSaving(false);
    setIsReloading(false);
    setEditSessionId((id) => id + 1);
    setPendingExit(null);
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

  // Seed the editor buffer the first time the source view opens for a file.
  useEffect(() => {
    if (viewMode !== "source" || content === null || draft !== null) return;
    setDraft(content);
    setEditDirty(false);
    setEditError(null);
    setEditMessage(null);
    setEditSessionId((id) => id + 1);
  }, [viewMode, content, draft]);

  const openSourceView = useCallback(() => {
    if (!canEditMarkdown || content === null) return;
    setDraft((d) => (d === null ? content : d));
    setEditError(null);
    setEditMessage(null);
    setViewMode("source");
  }, [canEditMarkdown, content]);

  // Throw away unsaved edits, resetting the buffer to the saved content. Stays
  // in the current view.
  const revertEdits = useCallback(() => {
    if (content === null) return;
    setDraft(content);
    setEditDirty(false);
    setEditError(null);
    setEditMessage(null);
    setEditSessionId((id) => id + 1);
  }, [content]);

  // Free movement between views. Switching out of the source view keeps the
  // draft intact (the rendered view previews it live), so no prompt is needed
  // here — unsaved work is only ever at risk when the file itself closes.
  const switchView = useCallback(
    (target: ViewMode) => {
      if (target === viewMode) return;
      if (target === "source") {
        openSourceView();
        return;
      }
      setViewMode(target);
    },
    [viewMode, openSourceView],
  );

  const reloadEditContent = useCallback(async () => {
    if (!projectPath) return;
    setIsReloading(true);
    setEditError(null);
    setEditMessage(null);
    try {
      const latest = await readFile(filePath, projectPath);
      setContent(latest);
      setDraft(latest);
      setEditDirty(false);
      setEditSessionId((id) => id + 1);
      setEditMessage("Reloaded latest file");
    } catch (err) {
      setEditError(String(err));
    } finally {
      setIsReloading(false);
    }
  }, [filePath, projectPath]);

  const saveEditContent = useCallback(async (): Promise<boolean> => {
    if (!projectPath || !canEditMarkdown || content === null) return false;
    const nextContent = editorRef.current?.getMarkdown() ?? draft ?? content;

    setIsSaving(true);
    setEditError(null);
    setEditMessage(null);
    try {
      const diskContent = await readFile(filePath, projectPath);
      if (diskContent !== content) {
        setEditError("This file changed on disk. Reload before saving to avoid overwriting newer changes.");
        return false;
      }

      await writeFile(filePath, projectPath, nextContent);
      setContent(nextContent);
      setDraft(nextContent);
      setEditDirty(false);
      // No "Saved" banner — it would insert a row and shift the editor down.
      // The Save button already reflects the saved state.
      // Reflect the new line counts immediately instead of waiting on the poll.
      refreshDiffStat();
      return true;
    } catch (err) {
      setEditError(String(err));
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [canEditMarkdown, content, draft, filePath, projectPath, refreshDiffStat]);

  const requestClose = useCallback(() => {
    if (editDirty) {
      setPendingExit({ kind: "close" });
      return;
    }
    onClose();
  }, [editDirty, onClose]);

  // Resolve the unsaved-changes prompt. "save" persists then continues to the
  // pending destination; "discard" drops the draft and continues.
  const resolvePendingExit = useCallback(
    async (choice: "save" | "discard") => {
      const exit = pendingExit;
      if (!exit) return;
      if (choice === "save") {
        const ok = await saveEditContent();
        if (!ok) return; // keep the prompt open so the error is visible
      }
      setPendingExit(null);
      if (choice === "discard") {
        setDraft(content);
        setEditDirty(false);
        setEditSessionId((id) => id + 1);
      }
      if (exit.kind === "close") {
        onClose();
      } else {
        setViewMode(exit.target);
      }
    },
    [pendingExit, saveEditContent, content, onClose],
  );

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
        Boolean(target?.closest("[contenteditable='true'], .cm-editor"));

      if (viewMode === "source") {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          e.stopPropagation();
          saveEditContent();
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          requestClose();
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
        switchView(viewMode === "diff" ? (isMarkdown ? "rendered" : "file") : "diff");
        return;
      }
      // M toggles between the rendered preview and the editable source view
      if (e.key === "m" || e.key === "M") {
        if (isTextInput) return;
        if (!isMarkdown) return;
        e.preventDefault();
        switchView(viewMode === "rendered" ? "source" : "rendered");
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
  }, [switchView, isMarkdown, requestClose, saveEditContent, viewMode]);

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

  // Preview the live buffer when it exists so unsaved edits show in the
  // rendered view; fall back to the saved content otherwise.
  const previewSource = draft ?? content;
  let renderedMarkdownHtml: string | null = null;
  if (isMarkdown && previewSource && viewMode === "rendered") {
    renderedMarkdownHtml = renderMarkdown(previewSource);
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

    if (viewMode === "source" && canEditMarkdown && content !== null) {
      const editorContent = draft ?? content;
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
            <MarkdownSourceEditor
              key={editSessionId}
              ref={editorRef}
              value={editorContent}
              appearance={appearance}
              onChange={(markdown) => {
                setDraft(markdown);
                setEditDirty(markdown !== content);
                if (editError && !editError.includes("changed on disk")) setEditError(null);
                if (editMessage) setEditMessage(null);
              }}
              onSave={saveEditContent}
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

  // The always-available view switcher. Markdown gets all three surfaces;
  // other text files get source + diff; binary/media gets none.
  const viewSegments: Array<[ViewMode, string]> = isMarkdown
    ? [["rendered", "Rendered"], ["source", "Markdown"], ["diff", "Diff"]]
    : category === "text"
      ? [["file", "File"], ["diff", "Diff"]]
      : [];

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
          <div style={styles.headerCenter}>
            {viewSegments.length > 0 && (
              <div style={styles.segmented} role="tablist">
                {viewSegments.map(([mode, label]) => {
                  const active = viewMode === mode;
                  const showDirty = mode === "source" && editDirty;
                  return (
                    <button
                      key={mode}
                      role="tab"
                      aria-selected={active}
                      style={{
                        ...styles.segmentedBtn,
                        ...(active ? styles.segmentedBtnActive : {}),
                      }}
                      onClick={() => switchView(mode)}
                    >
                      {label}
                      {showDirty && <span style={styles.dirtyDot} aria-label="unsaved changes" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div style={styles.headerRight}>
            {viewMode === "diff" && (
              <span style={styles.hint}>
                <kbd style={styles.kbd}>S</kbd> {diffLayout === "unified" ? "Split" : "Unified"}
              </span>
            )}
            {viewMode === "source" && (
              <>
                {editDirty && (
                  <button
                    style={styles.secondaryButton}
                    onClick={revertEdits}
                    disabled={isSaving || isReloading}
                  >
                    Revert
                  </button>
                )}
                <button
                  style={{
                    ...styles.primaryButton,
                    ...(!editDirty || isSaving || isReloading ? styles.primaryButtonDisabled : {}),
                  }}
                  onClick={() => saveEditContent()}
                  disabled={!editDirty || isSaving || isReloading}
                  title="Save Markdown"
                >
                  {isSaving ? "Saving..." : editDirty ? "Save" : "Saved"}
                </button>
              </>
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

        {pendingExit && (
          <div style={styles.confirmOverlay} onClick={() => setPendingExit(null)}>
            <div style={styles.confirmCard} onClick={(e) => e.stopPropagation()}>
              <div style={styles.confirmTitle}>Unsaved changes</div>
              <div style={styles.confirmBody}>
                You have unsaved edits to <strong>{fileName}</strong>.
                {pendingExit.kind === "close"
                  ? " Save them before closing?"
                  : " Save them before switching view?"}
              </div>
              {editError && <div style={styles.confirmError}>{editError}</div>}
              <div style={styles.confirmButtons}>
                <button
                  style={styles.secondaryButton}
                  onClick={() => setPendingExit(null)}
                  disabled={isSaving}
                >
                  Cancel
                </button>
                <button
                  style={styles.secondaryButton}
                  onClick={() => resolvePendingExit("discard")}
                  disabled={isSaving}
                >
                  Discard
                </button>
                <button
                  style={{
                    ...styles.primaryButton,
                    ...(isSaving ? styles.primaryButtonDisabled : {}),
                  }}
                  onClick={() => resolvePendingExit("save")}
                  disabled={isSaving}
                >
                  {isSaving ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          </div>
        )}
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
    display: "grid",
    gridTemplateColumns: "1fr auto 1fr",
    alignItems: "center",
    gap: "12px",
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
  headerCenter: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  } as React.CSSProperties,
  headerRight: {
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: "12px",
    minWidth: 0,
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
    color: "var(--text-on-accent)",
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
  segmented: {
    display: "inline-flex",
    background: "var(--bg-panel)",
    border: "1px solid var(--border-default)",
    borderRadius: "6px",
    padding: "2px",
    gap: "2px",
  } as React.CSSProperties,
  segmentedBtn: {
    position: "relative" as const,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: "74px",
    background: "transparent",
    border: "none",
    color: "var(--text-secondary)",
    fontSize: "12px",
    cursor: "pointer",
    padding: "3px 14px",
    borderRadius: "4px",
    lineHeight: "16px",
  } as React.CSSProperties,
  segmentedBtnActive: {
    background: "var(--bg-hover)",
    color: "var(--text-primary)",
  } as React.CSSProperties,
  dirtyDot: {
    position: "absolute" as const,
    right: "6px",
    top: "50%",
    transform: "translateY(-50%)",
    width: "6px",
    height: "6px",
    borderRadius: "50%",
    background: "var(--accent)",
    display: "inline-block",
  } as React.CSSProperties,
  confirmOverlay: {
    position: "absolute" as const,
    inset: 0,
    background: "rgba(0, 0, 0, 0.45)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10,
  } as React.CSSProperties,
  confirmCard: {
    width: "min(420px, 80%)",
    background: "var(--bg-elevated)",
    border: "1px solid var(--border-default)",
    borderRadius: "10px",
    padding: "20px",
    boxShadow: "0 12px 40px rgba(0, 0, 0, 0.4)",
  } as React.CSSProperties,
  confirmTitle: {
    fontSize: "14px",
    fontWeight: 600,
    color: "var(--text-primary)",
    marginBottom: "8px",
  } as React.CSSProperties,
  confirmBody: {
    fontSize: "13px",
    color: "var(--text-secondary)",
    lineHeight: 1.5,
  } as React.CSSProperties,
  confirmError: {
    fontSize: "12px",
    color: "#f48771",
    marginTop: "10px",
  } as React.CSSProperties,
  confirmButtons: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "8px",
    marginTop: "18px",
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
