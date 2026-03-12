import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "../store/appStore";
import { revealInFinder, openInDefaultApp } from "../lib/tauri";

export function FileLinkMenu() {
  const menu = useAppStore((s) => s.fileLinkMenu);
  const closeMenu = useAppStore((s) => s.closeFileLinkMenu);
  const openPreview = useAppStore((s) => s.openPreview);
  const selectFileInTree = useAppStore((s) => s.selectFileInTree);
  const activeProject = useAppStore((s) => s.getActiveProject());
  const projectPath = activeProject?.path ?? undefined;
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu, closeMenu]);

  if (!menu) return null;

  const { path, position, line } = menu;

  const items = [
    {
      label: "Preview",
      icon: (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 2c-3.5 0-6.4 2.2-7.8 5.5a.5.5 0 0 0 0 .4C1.6 11.3 4.5 13.5 8 13.5s6.4-2.2 7.8-5.5a.5.5 0 0 0 0-.4C14.4 4.2 11.5 2 8 2zm0 9.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" />
        </svg>
      ),
      action: () => {
        selectFileInTree(path);
        openPreview(path, line);
        closeMenu();
      },
    },
    {
      label: "Open",
      icon: (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8.636 3.5a.5.5 0 0 0-.5-.5H1.5A1.5 1.5 0 0 0 0 4.5v10A1.5 1.5 0 0 0 1.5 16h10a1.5 1.5 0 0 0 1.5-1.5V7.864a.5.5 0 0 0-1 0V14.5a.5.5 0 0 1-.5.5h-10a.5.5 0 0 1-.5-.5v-10a.5.5 0 0 1 .5-.5h6.636a.5.5 0 0 0 .5-.5z" />
          <path d="M16 .5a.5.5 0 0 0-.5-.5h-5a.5.5 0 0 0 0 1h3.793L6.146 9.146a.5.5 0 1 0 .708.708L15 1.707V5.5a.5.5 0 0 0 1 0v-5z" />
        </svg>
      ),
      action: () => {
        openInDefaultApp(path, projectPath);
        closeMenu();
      },
    },
    {
      label: "Reveal in Finder",
      icon: (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M1.5 2A1.5 1.5 0 0 0 0 3.5v9A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5V5.5A1.5 1.5 0 0 0 14.5 4H8.21l-1.6-1.6A1.5 1.5 0 0 0 5.55 2H1.5z" />
        </svg>
      ),
      action: () => {
        revealInFinder(path, projectPath);
        closeMenu();
      },
    },
    {
      label: "Copy Path",
      icon: (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25v-7.5z" />
          <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25v-7.5zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25h-7.5z" />
        </svg>
      ),
      action: () => {
        navigator.clipboard.writeText(path);
        closeMenu();
      },
    },
  ];

  const menuHeight = items.length * 32 + 8;
  const menuWidth = 180;

  return createPortal(
    <>
      <div
        style={{ position: "fixed", inset: 0, zIndex: 9998 }}
        onClick={closeMenu}
      />
      <div
        ref={menuRef}
        style={{
          position: "fixed",
          left: Math.min(position.x, window.innerWidth - menuWidth),
          top: Math.min(position.y, window.innerHeight - menuHeight),
          zIndex: 9999,
          backgroundColor: "var(--bg-panel)",
          border: "1px solid var(--border-default)",
          borderRadius: "6px",
          padding: "4px 0",
          boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
          minWidth: `${menuWidth}px`,
        }}
      >
        {items.map((item) => (
          <div
            key={item.label}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              padding: "6px 12px",
              fontSize: "var(--font-size)",
              color: "var(--text-primary)",
              cursor: "pointer",
            }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.backgroundColor = "var(--bg-hover)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.backgroundColor = "transparent")
            }
            onClick={item.action}
          >
            {item.icon}
            {item.label}
          </div>
        ))}
      </div>
    </>,
    document.body,
  );
}
