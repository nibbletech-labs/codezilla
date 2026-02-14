import { useRef, useState } from "react";

interface FilterInputProps {
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
}

export default function FilterInput({ value, onChange, onKeyDown }: FilterInputProps) {
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div style={styles.wrapper}>
      <input
        ref={inputRef}
        type="text"
        placeholder="Filter files..."
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={onKeyDown}
        style={{
          ...styles.input,
          borderColor: focused ? "var(--accent)" : "var(--border-default)",
        }}
      />
      {value && (
        <button
          onClick={() => {
            onChange("");
            inputRef.current?.focus();
          }}
          style={styles.clear}
        >
          ×
        </button>
      )}
    </div>
  );
}

const styles = {
  wrapper: {
    position: "relative" as const,
    padding: "6px 8px",
  },
  input: {
    width: "100%",
    background: "var(--bg-input)",
    border: "1px solid var(--border-default)",
    color: "var(--text-primary)",
    fontSize: "var(--font-size)",
    padding: "4px 22px 4px 6px",
    borderRadius: "2px",
    outline: "none",
    boxSizing: "border-box" as const,
  },
  clear: {
    position: "absolute" as const,
    right: "12px",
    top: "50%",
    transform: "translateY(-50%)",
    background: "none",
    border: "none",
    color: "var(--text-secondary)",
    fontSize: "14px",
    cursor: "pointer",
    padding: "0 2px",
    lineHeight: 1,
  },
};
