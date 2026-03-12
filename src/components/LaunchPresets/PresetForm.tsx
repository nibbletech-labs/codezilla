import { useState, useEffect, useRef } from "react";
import { useAppStore } from "../../store/appStore";
import type { ThreadType, LaunchPreset } from "../../store/types";
import ThreadIcon from "../LeftPanel/ThreadIcons";

const FORM_WIDTH = 320;
const FORM_MAX_HEIGHT = 400;

interface PresetFormProps {
  anchor: { x: number; y: number };
  onClose: () => void;
  editPreset?: LaunchPreset;
}

const TYPE_OPTIONS: { type: ThreadType; label: string }[] = [
  { type: "claude", label: "Claude" },
  { type: "codex", label: "Codex" },
  { type: "shell", label: "Terminal" },
];

export default function PresetForm({ anchor, onClose, editPreset }: PresetFormProps) {
  const addLaunchPreset = useAppStore((s) => s.addLaunchPreset);
  const updateLaunchPreset = useAppStore((s) => s.updateLaunchPreset);
  const removeLaunchPreset = useAppStore((s) => s.removeLaunchPreset);
  const formRef = useRef<HTMLDivElement>(null);

  const [emoji, setEmoji] = useState(editPreset?.emoji ?? "");
  const [name, setName] = useState(editPreset?.name ?? "");
  const [baseType, setBaseType] = useState<ThreadType>(editPreset?.baseType ?? "claude");
  const [args, setArgs] = useState(editPreset?.args ?? "");

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleSubmit = () => {
    const presetName = name.trim() || args.slice(0, 30) || "Untitled";
    const presetEmoji = emoji.trim() || "🚀";

    if (editPreset) {
      updateLaunchPreset(editPreset.id, {
        name: presetName,
        emoji: presetEmoji,
        baseType,
        args: args.trim(),
      });
    } else {
      addLaunchPreset({
        name: presetName,
        emoji: presetEmoji,
        baseType,
        args: args.trim(),
      });
    }
    onClose();
  };

  const handleDelete = () => {
    if (editPreset) {
      removeLaunchPreset(editPreset.id);
    }
    onClose();
  };

  const canSave = name.trim() || args.trim();

  const left = Math.min(anchor.x, window.innerWidth - FORM_WIDTH - 8);
  const top = Math.min(anchor.y, window.innerHeight - FORM_MAX_HEIGHT - 8);

  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 9998 }} onClick={onClose} />

      <div
        ref={formRef}
        style={{
          position: "fixed",
          left,
          top,
          width: FORM_WIDTH,
          maxHeight: FORM_MAX_HEIGHT,
          zIndex: 9999,
          backgroundColor: "var(--bg-panel)",
          border: "1px solid var(--border-default)",
          borderRadius: 6,
          boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
          padding: "16px",
          display: "flex",
          flexDirection: "column",
          gap: "14px",
          overflow: "auto",
        }}
      >
        <div style={{ color: "var(--text-primary)", fontSize: "var(--font-size)", fontWeight: 600 }}>
          {editPreset ? "Edit Preset" : "New Preset"}
        </div>

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
                padding: "6px 14px",
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
              // Keep only the last entered character/emoji
              const val = e.target.value;
              setEmoji(val.length > 2 ? [...val].pop() ?? "" : val);
            }}
            placeholder="🚀"
            style={{ ...inputStyle, width: "44px", textAlign: "center", fontSize: "18px", padding: "4px" }}
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
        />

        {/* Buttons */}
        <div style={{ display: "flex", gap: "8px" }}>
          {editPreset && (
            <button
              onClick={handleDelete}
              style={{
                ...btnStyle,
                background: "transparent",
                border: "1px solid var(--border-default)",
                color: "var(--text-secondary)",
                cursor: "pointer",
              }}
            >
              Delete
            </button>
          )}
          <button
            onClick={handleSubmit}
            disabled={!canSave}
            style={{
              ...btnStyle,
              flex: 1,
              background: canSave ? "var(--accent)" : "var(--bg-hover)",
              color: canSave ? "#fff" : "var(--text-secondary)",
              cursor: canSave ? "pointer" : "default",
            }}
          >
            {editPreset ? "Save" : "Create"}
          </button>
        </div>
      </div>
    </>
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

const btnStyle: React.CSSProperties = {
  border: "none",
  fontSize: "var(--font-size-sm)",
  padding: "8px 16px",
  borderRadius: "4px",
  fontWeight: 600,
};
