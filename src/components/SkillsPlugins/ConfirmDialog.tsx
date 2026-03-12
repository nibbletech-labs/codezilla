import { styles, confirmStyles } from "./styles";

export function ConfirmDialog({
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      style={confirmStyles.backdrop}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div style={confirmStyles.modal}>
        <div
          style={{
            fontSize: "var(--font-size-sm)",
            lineHeight: 1.6,
            marginBottom: "16px",
            whiteSpace: "pre-line",
            color: "var(--text-primary)",
          }}
        >
          {message}
        </div>
        <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
          <button style={styles.actionBtn} onClick={onCancel}>
            Cancel
          </button>
          <button
            style={{ ...styles.accentBtn, background: "#c44" }}
            onClick={onConfirm}
          >
            {confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
