import { useEffect, useRef } from "react";
import { useAppStore } from "../store/appStore";

export function FilePickerPopup() {
  const filePicker = useAppStore((s) => s.filePicker);
  const closeFilePicker = useAppStore((s) => s.closeFilePicker);
  const openPreview = useAppStore((s) => s.openPreview);
  const selectFileInTree = useAppStore((s) => s.selectFileInTree);
  const activeProject = useAppStore((s) => s.getActiveProject());
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    if (!filePicker) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeFilePicker();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filePicker, closeFilePicker]);

  if (!filePicker) return null;

  const { candidates, position, line } = filePicker;
  const root = activeProject?.path
    ? activeProject.path.endsWith("/")
      ? activeProject.path
      : activeProject.path + "/"
    : null;

  // Position the menu, clamping to viewport
  const menuStyle: React.CSSProperties = {
    position: "fixed",
    left: Math.min(position.x, window.innerWidth - 320),
    top: Math.min(position.y, window.innerHeight - Math.min(candidates.length * 30 + 8, 208)),
    zIndex: 9999,
    background: "var(--bg-panel)",
    border: "1px solid var(--border-default)",
    borderRadius: "4px",
    boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
    maxHeight: "200px",
    overflowY: "auto",
    minWidth: "200px",
    maxWidth: "400px",
    padding: "4px 0",
  };

  return (
    <>
      <div
        style={{ position: "fixed", inset: 0, zIndex: 9998 }}
        onClick={closeFilePicker}
      />
      <div ref={menuRef} style={menuStyle}>
        {candidates.map((path) => {
          const display = root && path.startsWith(root) ? path.slice(root.length) : path;
          return (
            <FilePickerItem
              key={path}
              display={display}
              onClick={() => {
                selectFileInTree(path);
                openPreview(path, line);
                closeFilePicker();
              }}
            />
          );
        })}
      </div>
    </>
  );
}

function FilePickerItem({ display, onClick }: { display: string; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: "4px 12px",
        cursor: "pointer",
        fontSize: "13px",
        color: "var(--text-primary)",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background = "var(--accent-selection)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = "transparent";
      }}
    >
      {display}
    </div>
  );
}
