import type React from "react";

/**
 * Shared modal styles used by overlay panels (Skills & Plugins Manager,
 * Launch Presets Manager, Job Creation Form, etc.).
 *
 * Use getBackdropStyle() to centre the modal over the terminal area
 * (accounting for visible sidebars), or modalStyles.backdrop for a
 * simple full-viewport centre.
 */

/** Returns a backdrop style that centres its child over the content area. */
export function getBackdropStyle(leftPanelWidth: number, rightPanelWidth: number): React.CSSProperties {
  return {
    ...baseBackdrop,
    paddingLeft: leftPanelWidth,
    paddingRight: rightPanelWidth,
  };
}

const baseBackdrop: React.CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: "rgba(0, 0, 0, 0.55)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
  animation: "modal-backdrop-in 0.15s ease-out",
  boxSizing: "border-box",
};

export const modalStyles = {
  backdrop: baseBackdrop,

  modal: {
    width: "90vw",
    maxWidth: "800px",
    maxHeight: "calc(100vh - 80px)",
    backgroundColor: "var(--bg-primary)",
    borderRadius: "8px",
    border: "1px solid var(--border-default)",
    display: "flex",
    flexDirection: "column" as const,
    overflow: "hidden",
    boxShadow: "0 8px 32px rgba(0, 0, 0, 0.5)",
    animation: "modal-content-in 0.15s ease-out",
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
    padding: "12px 16px",
    overflowY: "auto" as const,
    flex: 1,
  } as React.CSSProperties,

  footer: {
    padding: "8px 16px",
    borderTop: "1px solid var(--border-default)",
    flexShrink: 0,
  } as React.CSSProperties,
};

export const modalKeyframes = `
  @keyframes modal-backdrop-in { from { opacity: 0; } to { opacity: 1; } }
  @keyframes modal-content-in { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }
`;
