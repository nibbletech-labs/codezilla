import { useState, useEffect } from "react";
import { useAppStore } from "../../store/appStore";
import type { ThreadType, LaunchPreset } from "../../store/types";
import ThreadIcon from "../LeftPanel/ThreadIcons";

const TYPE_OPTIONS: { type: ThreadType; label: string }[] = [
  { type: "claude", label: "Claude" },
  { type: "codex", label: "Codex" },
  { type: "shell", label: "Terminal" },
];

export default function PresetsManager() {
  const closeManager = useAppStore((s) => s.closePresetsManager);
  const launchPresets = useAppStore((s) => s.launchPresets);
  const addLaunchPreset = useAppStore((s) => s.addLaunchPreset);
  const updateLaunchPreset = useAppStore((s) => s.updateLaunchPreset);
  const removeLaunchPreset = useAppStore((s) => s.removeLaunchPreset);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeManager();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [closeManager]);

  return (
    <div
      style={styles.backdrop}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeManager();
      }}
    >
      <style>{`
        @keyframes skills-backdrop-in { from { opacity: 0; } to { opacity: 1; } }
        @keyframes skills-modal-in { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }
      `}</style>
      <div style={styles.modal}>
        {/* Header */}
        <div style={styles.header}>
          <span style={{ fontSize: "var(--font-size)", fontWeight: 600, color: "var(--text-primary)" }}>
            Launch Presets
          </span>
          <button style={styles.closeBtn} onClick={closeManager}>&times;</button>
        </div>

        {/* Body */}
        <div style={styles.body}>
          {launchPresets.length === 0 && !isAdding && (
            <div style={{ color: "var(--text-secondary)", fontSize: "var(--font-size-sm)", padding: "16px 0", textAlign: "center" }}>
              No presets yet. Create one to quickly launch threads with custom arguments.
            </div>
          )}

          {launchPresets.map((preset) => (
            editingId === preset.id ? (
              <PresetEditor
                key={preset.id}
                preset={preset}
                onSave={(updates) => {
                  updateLaunchPreset(preset.id, updates);
                  setEditingId(null);
                }}
                onDelete={() => {
                  removeLaunchPreset(preset.id);
                  setEditingId(null);
                }}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <PresetRow
                key={preset.id}
                preset={preset}
                onEdit={() => {
                  setEditingId(preset.id);
                  setIsAdding(false);
                }}
              />
            )
          ))}

          {isAdding && (
            <PresetEditor
              onSave={(data) => {
                addLaunchPreset(data);
                setIsAdding(false);
              }}
              onCancel={() => setIsAdding(false)}
            />
          )}
        </div>

        {/* Footer */}
        <div style={styles.footer}>
          <button
            style={styles.addBtn}
            onClick={() => {
              setIsAdding(true);
              setEditingId(null);
            }}
            disabled={isAdding}
          >
            + Add Preset
          </button>
        </div>
      </div>
    </div>
  );
}

function PresetRow({ preset, onEdit }: { preset: LaunchPreset; onEdit: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      style={{
        ...styles.row,
        backgroundColor: hovered ? "var(--bg-hover)" : "transparent",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span style={{ fontSize: "16px", width: "24px", textAlign: "center", flexShrink: 0 }}>
        {preset.emoji}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: "var(--text-primary)", fontSize: "var(--font-size-sm)", fontWeight: 500 }}>
          {preset.name}
        </div>
        {preset.args && (
          <div style={{
            color: "var(--text-secondary)",
            fontSize: "calc(var(--font-size-sm) - 1px)",
            fontFamily: "var(--font-mono, monospace)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}>
            {preset.args}
          </div>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "4px", flexShrink: 0 }}>
        <ThreadIcon type={preset.baseType} />
        <span style={{ color: "var(--text-secondary)", fontSize: "calc(var(--font-size-sm) - 1px)" }}>
          {preset.baseType === "claude" ? "Claude" : preset.baseType === "codex" ? "Codex" : "Terminal"}
        </span>
      </div>
      <button
        style={styles.editBtn}
        onClick={onEdit}
      >
        Edit
      </button>
    </div>
  );
}

function PresetEditor({
  preset,
  onSave,
  onDelete,
  onCancel,
}: {
  preset?: LaunchPreset;
  onSave: (data: { name: string; emoji: string; baseType: ThreadType; args: string }) => void;
  onDelete?: () => void;
  onCancel: () => void;
}) {
  const [emoji, setEmoji] = useState(preset?.emoji ?? "");
  const [name, setName] = useState(preset?.name ?? "");
  const [baseType, setBaseType] = useState<ThreadType>(preset?.baseType ?? "claude");
  const [args, setArgs] = useState(preset?.args ?? "");

  const canSave = name.trim() || args.trim();

  const handleSubmit = () => {
    if (!canSave) return;
    onSave({
      name: name.trim() || args.slice(0, 30) || "Untitled",
      emoji: emoji.trim() || "\u{1F680}",
      baseType,
      args: args.trim(),
    });
  };

  return (
    <div style={styles.editor}>
      {/* Type toggle */}
      <div style={{ display: "flex", gap: "6px" }}>
        {TYPE_OPTIONS.map(({ type, label }) => (
          <button
            key={type}
            onClick={() => setBaseType(type)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              background: baseType === type ? "var(--accent-selection)" : "transparent",
              border: `1px solid ${baseType === type ? "var(--accent)" : "var(--border-default)"}`,
              color: "var(--text-primary)",
              fontSize: "var(--font-size-sm)",
              cursor: "pointer",
              padding: "5px 12px",
              borderRadius: "4px",
              flex: 1,
              justifyContent: "center",
            }}
          >
            <ThreadIcon type={type} />
            {label}
          </button>
        ))}
      </div>

      {/* Icon + Name row */}
      <div style={{ display: "flex", gap: "8px" }}>
        <input
          value={emoji}
          onChange={(e) => {
            const val = e.target.value;
            setEmoji(val.length > 2 ? [...val].pop() ?? "" : val);
          }}
          placeholder="\u{1F680}"
          style={{ ...inputStyle, width: "40px", textAlign: "center", fontSize: "16px", padding: "4px" }}
        />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Preset name"
          style={{ ...inputStyle, flex: 1 }}
          autoFocus
        />
      </div>

      {/* Args */}
      <input
        value={args}
        onChange={(e) => setArgs(e.target.value)}
        placeholder="--model sonnet --thinking medium"
        style={{ ...inputStyle, fontFamily: "var(--font-mono, monospace)" }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && canSave) handleSubmit();
        }}
      />

      {/* Action buttons */}
      <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
        {onDelete && (
          <button
            onClick={onDelete}
            style={{
              ...btnBase,
              background: "transparent",
              border: "1px solid var(--border-default)",
              color: "#c44",
            }}
          >
            Delete
          </button>
        )}
        <button
          onClick={onCancel}
          style={{
            ...btnBase,
            background: "transparent",
            border: "1px solid var(--border-default)",
            color: "var(--text-secondary)",
          }}
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={!canSave}
          style={{
            ...btnBase,
            background: canSave ? "var(--accent)" : "var(--bg-hover)",
            color: canSave ? "#fff" : "var(--text-secondary)",
            cursor: canSave ? "pointer" : "default",
          }}
        >
          {preset ? "Save" : "Create"}
        </button>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--bg-input, var(--bg-primary))",
  border: "1px solid var(--border-default)",
  color: "var(--text-primary)",
  fontSize: "var(--font-size-sm)",
  padding: "6px 8px",
  borderRadius: "4px",
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

const btnBase: React.CSSProperties = {
  border: "none",
  fontSize: "var(--font-size-sm)",
  padding: "6px 14px",
  borderRadius: "4px",
  fontWeight: 600,
  cursor: "pointer",
};

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
    animation: "skills-backdrop-in 0.15s ease-out",
  } as React.CSSProperties,
  modal: {
    width: "calc(100vw - 250px - var(--right-panel-width, 250px) - 10px)",
    maxWidth: "440px",
    maxHeight: "calc(100vh - 24px - 10px)",
    backgroundColor: "var(--bg-primary)",
    borderRadius: "8px",
    border: "1px solid var(--border-default)",
    display: "flex",
    flexDirection: "column" as const,
    overflow: "hidden",
    boxShadow: "0 8px 32px rgba(0, 0, 0, 0.5)",
    animation: "skills-modal-in 0.15s ease-out",
  } as React.CSSProperties,
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 16px",
    borderBottom: "1px solid var(--border-default)",
    backgroundColor: "var(--bg-panel)",
    flexShrink: 0,
  } as React.CSSProperties,
  closeBtn: {
    background: "none",
    border: "none",
    color: "var(--text-secondary)",
    fontSize: "18px",
    cursor: "pointer",
    padding: "4px 8px",
    lineHeight: 1,
  } as React.CSSProperties,
  body: {
    padding: "8px 16px",
    overflowY: "auto" as const,
    flex: 1,
    display: "flex",
    flexDirection: "column" as const,
    gap: "2px",
  } as React.CSSProperties,
  footer: {
    padding: "8px 16px",
    borderTop: "1px solid var(--border-default)",
    flexShrink: 0,
  } as React.CSSProperties,
  row: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "8px 10px",
    borderRadius: "4px",
    cursor: "default",
  } as React.CSSProperties,
  editBtn: {
    background: "transparent",
    border: "1px solid var(--border-default)",
    color: "var(--text-secondary)",
    fontSize: "calc(var(--font-size-sm) - 1px)",
    padding: "3px 10px",
    borderRadius: "4px",
    cursor: "pointer",
    flexShrink: 0,
  } as React.CSSProperties,
  addBtn: {
    background: "transparent",
    border: "1px solid var(--border-default)",
    color: "var(--text-primary)",
    fontSize: "var(--font-size-sm)",
    padding: "6px 14px",
    borderRadius: "4px",
    cursor: "pointer",
    width: "100%",
    fontWeight: 500,
  } as React.CSSProperties,
  editor: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "10px",
    padding: "12px",
    borderRadius: "6px",
    border: "1px solid var(--border-default)",
    backgroundColor: "var(--bg-panel)",
    margin: "4px 0",
  } as React.CSSProperties,
};
