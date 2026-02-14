import { useEffect, useRef } from "react";
import { useAppStore } from "../../store/appStore";
import { ask } from "@tauri-apps/plugin-dialog";

interface TitleBarDropdownProps {
  anchorRect: { x: number; y: number; width: number; height: number };
  onClose: () => void;
}

export default function TitleBarDropdown({ anchorRect, onClose }: TitleBarDropdownProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const thread = useAppStore((s) => s.getActiveThread());
  const startRenamingThread = useAppStore((s) => s.startRenamingThread);
  const removeThread = useAppStore((s) => s.removeThread);
  const info = useAppStore((s) => thread ? s.transcriptInfo[thread.id] : undefined);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!thread) return null;

  const sessionId =
    thread.type === "claude" ? thread.claudeSessionId :
    thread.type === "codex" ? thread.codexThreadId :
    thread.sessionId;

  const canCopyResume = thread.type === "claude" || thread.type === "codex";
  const resumeCmd =
    thread.type === "claude" ? `claude --resume ${thread.claudeSessionId}` :
    thread.type === "codex" ? `codex resume ${thread.codexThreadId}` : "";

  const handleRename = () => {
    onClose();
    // Small delay so the dropdown closes before the sidebar input appears
    setTimeout(() => startRenamingThread(thread.id), 50);
  };

  const handleRemove = async () => {
    if (info?.status === "working") {
      const confirmed = await ask("This thread has a running process. Close it?", {
        title: "Close Thread",
        kind: "warning",
        okLabel: "Close",
        cancelLabel: "Cancel",
      });
      if (!confirmed) {
        onClose();
        return;
      }
    }
    removeThread(thread.id);
    onClose();
  };

  const handleCopySessionId = () => {
    if (sessionId) navigator.clipboard.writeText(sessionId);
    onClose();
  };

  const handleCopyResumeCmd = () => {
    if (resumeCmd) navigator.clipboard.writeText(resumeCmd);
    onClose();
  };

  const menuStyle: React.CSSProperties = {
    position: "fixed",
    left: anchorRect.x,
    top: anchorRect.y + anchorRect.height + 4,
    zIndex: 9999,
    background: "var(--bg-panel)",
    border: "1px solid var(--border-default)",
    borderRadius: "6px",
    boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
    minWidth: "200px",
    padding: "4px 0",
  };

  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 9998 }} onClick={onClose} />
      <div ref={menuRef} style={menuStyle}>
        <MenuItem label="Rename thread..." onClick={handleRename} />
        <MenuItem label="Remove thread" onClick={handleRemove} destructive />
        <div style={{ height: 1, background: "var(--border-default)", margin: "4px 0" }} />
        <MenuItem
          label="Copy session ID"
          onClick={handleCopySessionId}
          disabled={!sessionId}
        />
        {canCopyResume && (
          <MenuItem
            label="Copy resume command"
            onClick={handleCopyResumeCmd}
            disabled={!sessionId}
          />
        )}
      </div>
    </>
  );
}

function MenuItem({ label, onClick, disabled, destructive }: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <div
      onClick={disabled ? undefined : onClick}
      style={{
        padding: "6px 14px",
        cursor: disabled ? "default" : "pointer",
        fontSize: "13px",
        color: disabled ? "var(--text-hint)" : destructive ? "#f48771" : "var(--text-primary)",
        opacity: disabled ? 0.5 : 1,
      }}
      onMouseEnter={(e) => {
        if (!disabled) (e.currentTarget as HTMLElement).style.background = "var(--accent-selection)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = "transparent";
      }}
    >
      {label}
    </div>
  );
}
