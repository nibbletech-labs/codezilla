import { useState, useEffect, useRef, useCallback } from "react";
import type { LucideIcon } from "lucide-react";
import { EmojiPicker } from "frimousse";
import { ICON_COLORS, ICON_CATEGORIES } from "../../lib/iconConstants";
import { LUCIDE_MAP } from "../ProjectIcon";
import type { ProjectIcon } from "../../store/types";

type Tab = "icons" | "emoji";

interface IconPickerProps {
  anchor: { x: number; y: number };
  currentIcon?: ProjectIcon;
  onSelect: (icon: ProjectIcon) => void;
  onRemove: () => void;
  onClose: () => void;
}

const PICKER_W = 300;
const PICKER_H = 380;

export default function IconPicker({ anchor, currentIcon, onSelect, onRemove, onClose }: IconPickerProps) {
  const [tab, setTab] = useState<Tab>("icons");
  const [search, setSearch] = useState("");
  const [selectedColor, setSelectedColor] = useState(
    currentIcon?.type === "lucide" ? currentIcon.color : ICON_COLORS[0].value,
  );
  const containerRef = useRef<HTMLDivElement>(null);

  // Clamp position to viewport
  const left = Math.min(anchor.x, window.innerWidth - PICKER_W - 8);
  const top = Math.min(anchor.y, window.innerHeight - PICKER_H - 8);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleIconSelect = useCallback((name: string) => {
    onSelect({ type: "lucide", name, color: selectedColor });
  }, [onSelect, selectedColor]);

  const handleEmojiSelect = useCallback((emoji: { emoji: string }) => {
    onSelect({ type: "emoji", value: emoji.emoji });
  }, [onSelect]);

  // Filter icons by search term
  const lowerSearch = search.toLowerCase();
  const filteredCategories = search
    ? ICON_CATEGORIES.map((cat) => ({
        ...cat,
        icons: cat.icons.filter((name) => name.toLowerCase().includes(lowerSearch)),
      })).filter((cat) => cat.icons.length > 0)
    : ICON_CATEGORIES;

  return (
    <>
      {/* Invisible backdrop */}
      <div style={{ position: "fixed", inset: 0, zIndex: 9998 }} onClick={onClose} />

      <div
        ref={containerRef}
        style={{
          position: "fixed",
          left,
          top,
          width: PICKER_W,
          maxHeight: PICKER_H,
          zIndex: 9999,
          backgroundColor: "var(--bg-panel)",
          border: "1px solid var(--border-default)",
          borderRadius: 6,
          boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Tabs */}
        <div style={{ display: "flex", borderBottom: "1px solid var(--border-subtle)", flexShrink: 0 }}>
          <TabButton label="Icons" active={tab === "icons"} onClick={() => { setTab("icons"); setSearch(""); }} />
          <TabButton label="Emoji" active={tab === "emoji"} onClick={() => { setTab("emoji"); setSearch(""); }} />
        </div>

        {tab === "icons" ? (
          <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
            {/* Search */}
            <div style={{ padding: "8px 10px 4px" }}>
              <input
                type="text"
                placeholder="Search icons..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoFocus
                style={{
                  width: "100%",
                  boxSizing: "border-box",
                  padding: "5px 8px",
                  fontSize: "12px",
                  background: "var(--bg-input)",
                  border: "1px solid var(--border-default)",
                  borderRadius: 4,
                  color: "var(--text-primary)",
                  outline: "none",
                }}
              />
            </div>

            {/* Color swatches */}
            <div style={{ display: "flex", gap: 4, padding: "6px 10px", flexShrink: 0 }}>
              {ICON_COLORS.map((c) => (
                <button
                  key={c.id}
                  title={c.label}
                  onClick={() => {
                    setSelectedColor(c.value);
                    // Only apply color to lucide icons (or default Folder); don't override emoji
                    if (currentIcon?.type !== "emoji") {
                      const iconName = currentIcon?.type === "lucide" ? currentIcon.name : "Folder";
                      onSelect({ type: "lucide", name: iconName, color: c.value });
                    }
                  }}
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: "50%",
                    background: c.value,
                    border: selectedColor === c.value ? "2px solid var(--text-primary)" : "2px solid transparent",
                    cursor: "pointer",
                    padding: 0,
                    flexShrink: 0,
                  }}
                />
              ))}
            </div>

            {/* Icon grid */}
            <div style={{ flex: 1, overflowY: "auto", padding: "0 10px 8px" }}>
              {filteredCategories.map((cat) => (
                <div key={cat.label}>
                  <div style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: "var(--text-secondary)",
                    textTransform: "uppercase",
                    letterSpacing: "0.5px",
                    padding: "6px 0 4px",
                  }}>
                    {cat.label}
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 2 }}>
                    {cat.icons.map((name) => {
                      const Icon = LUCIDE_MAP[name];
                      if (!Icon) return null;
                      const isSelected = currentIcon?.type === "lucide" && currentIcon.name === name;
                      return (
                        <IconGridButton
                          key={name}
                          name={name}
                          Icon={Icon}
                          color={selectedColor}
                          isSelected={isSelected}
                          onClick={() => handleIconSelect(name)}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
              {filteredCategories.length === 0 && (
                <div style={{ color: "var(--text-secondary)", fontSize: 12, padding: "16px 0", textAlign: "center" }}>
                  No icons found
                </div>
              )}
            </div>
          </div>
        ) : (
          /* Emoji tab */
          <div style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
            <EmojiPicker.Root
              onEmojiSelect={handleEmojiSelect}
              columns={8}
              style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}
            >
              <div style={{ padding: "8px 10px 4px" }}>
                <EmojiPicker.Search
                  autoFocus
                  placeholder="Search emoji..."
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    padding: "5px 8px",
                    fontSize: "12px",
                    background: "var(--bg-input)",
                    border: "1px solid var(--border-default)",
                    borderRadius: 4,
                    color: "var(--text-primary)",
                    outline: "none",
                  }}
                />
              </div>
              <EmojiPicker.Viewport style={{ flex: 1, overflow: "auto", padding: "4px 10px 8px" }}>
                <EmojiPicker.Loading>
                  <span style={{ color: "var(--text-secondary)", fontSize: 12, padding: 16 }}>Loading...</span>
                </EmojiPicker.Loading>
                <EmojiPicker.Empty>
                  <span style={{ color: "var(--text-secondary)", fontSize: 12, padding: 16 }}>No emoji found</span>
                </EmojiPicker.Empty>
                <EmojiPicker.List
                  components={{
                    CategoryHeader: ({ category, ...props }) => (
                      <div
                        {...props}
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          color: "var(--text-secondary)",
                          textTransform: "uppercase",
                          letterSpacing: "0.5px",
                          padding: "6px 0 4px",
                          ...(props.style || {}),
                        }}
                      >
                        {category.label}
                      </div>
                    ),
                    Row: ({ children, ...props }) => (
                      <div {...props} style={{ display: "flex", ...(props.style || {}) }}>
                        {children}
                      </div>
                    ),
                    Emoji: ({ emoji, ...props }) => (
                      <button
                        {...props}
                        style={{
                          all: "unset",
                          width: 30,
                          height: 30,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 18,
                          cursor: "pointer",
                          borderRadius: 4,
                          background: emoji.isActive ? "var(--bg-hover)" : "transparent",
                          ...(props.style || {}),
                        }}
                      >
                        {emoji.emoji}
                      </button>
                    ),
                  }}
                />
              </EmojiPicker.Viewport>
            </EmojiPicker.Root>
          </div>
        )}

        {/* Remove icon button */}
        {currentIcon && (
          <button
            onClick={() => { onRemove(); onClose(); }}
            style={{
              background: "none",
              border: "none",
              borderTop: "1px solid var(--border-subtle)",
              color: "var(--text-secondary)",
              fontSize: 12,
              padding: "8px",
              cursor: "pointer",
              textAlign: "center",
              width: "100%",
              flexShrink: 0,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-primary)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-secondary)"; e.currentTarget.style.background = "none"; }}
          >
            Remove icon
          </button>
        )}
      </div>
    </>
  );
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        background: "none",
        border: "none",
        borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
        color: active ? "var(--text-primary)" : "var(--text-secondary)",
        fontSize: 12,
        fontWeight: 500,
        padding: "8px 0",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function IconGridButton({
  name, Icon, color, isSelected, onClick,
}: {
  name: string;
  Icon: LucideIcon;
  color: string;
  isSelected: boolean;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      title={name}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        all: "unset",
        width: 34,
        height: 34,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        borderRadius: 4,
        background: isSelected
          ? "var(--accent-selection)"
          : hovered
            ? "var(--bg-hover)"
            : "transparent",
      }}
    >
      <Icon size={18} color={color} strokeWidth={2} />
    </button>
  );
}
