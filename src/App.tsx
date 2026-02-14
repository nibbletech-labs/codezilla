import { useState, useEffect, useCallback, useRef } from "react";
import LeftPanel from "./components/LeftPanel/LeftPanel";
import TerminalMultiplexer from "./components/CenterPanel/Terminal";
import RightPanel from "./components/RightPanel/RightPanel";
import TitleBar from "./components/TitleBar/TitleBar";
import StatusBar from "./components/StatusBar/StatusBar";
import PanelErrorBoundary from "./components/ErrorBoundary";
import { FilePickerPopup } from "./components/FilePickerPopup";
import { usePersistence } from "./hooks/usePersistence";
import { useCloseProtection } from "./hooks/useCloseProtection";
import { useProjectHealthCheck } from "./hooks/useProjectHealthCheck";
import { useTranscriptWatcher } from "./hooks/useTranscriptWatcher";
import { useTheme } from "./hooks/useTheme";
import { useMenuEvents } from "./hooks/useMenuEvents";
import { PANEL_WIDTHS, getLeftPanelWidth } from "./lib/constants";
import { useAppStore } from "./store/appStore";

const MIN_RIGHT_WIDTH = 150;
const MAX_RIGHT_WIDTH = 600;
const SIDEBAR_TRANSITION = "220ms cubic-bezier(0.22, 1, 0.36, 1)";

function App() {
  usePersistence();
  useCloseProtection();
  useProjectHealthCheck();
  useTranscriptWatcher();
  useTheme();
  useMenuEvents();

  const [rightPanelWidth, setRightPanelWidth] = useState<number>(PANEL_WIDTHS.right);
  const isDragging = useRef(false);
  const baseFontSize = useAppStore((s) => s.baseFontSize);
  const showLeftPanel = useAppStore((s) => s.showLeftPanel);
  const showRightPanel = useAppStore((s) => s.showRightPanel);

  // Apply font size as CSS custom properties for sidebars
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--font-size", `${baseFontSize}px`);
    root.style.setProperty("--font-size-sm", `${baseFontSize - 2}px`);
  }, [baseFontSize]);

  useEffect(() => {
    document.documentElement.style.setProperty(
      "--right-panel-width",
      `${rightPanelWidth}px`,
    );
  }, [rightPanelWidth]);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;

    // Full-screen overlay to prevent terminal/iframe from stealing mouse events
    const overlay = document.createElement("div");
    overlay.id = "resize-overlay";
    overlay.style.cssText =
      "position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;cursor:col-resize;";
    document.body.appendChild(overlay);
    document.body.style.cursor = "col-resize";

    const onMouseMove = (ev: MouseEvent) => {
      const newWidth = Math.min(
        MAX_RIGHT_WIDTH,
        Math.max(MIN_RIGHT_WIDTH, window.innerWidth - ev.clientX),
      );
      setRightPanelWidth(newWidth);
    };

    const onMouseUp = () => {
      isDragging.current = false;
      document.body.style.cursor = "";
      overlay.remove();
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, []);

  const leftPanelWidth = getLeftPanelWidth(baseFontSize);
  const leftCol = showLeftPanel ? `${leftPanelWidth}px` : "0px";
  const rightCol = showRightPanel ? `${rightPanelWidth}px` : "0px";

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        display: "grid",
        gridTemplateColumns: `${leftCol} 1fr ${rightCol}`,
        transition: `grid-template-columns ${SIDEBAR_TRANSITION}`,
        gridTemplateRows: "auto 1fr 24px",
        backgroundColor: "var(--bg-primary)",
        borderTop: "var(--window-top-border, none)",
        overflow: "hidden",
      }}
    >
      <div style={{ gridRow: "1", gridColumn: "1 / -1" }}>
        <TitleBar />
      </div>
      <div style={{ gridRow: "2", gridColumn: "1", overflow: "hidden" }}>
        <div
          style={{
            width: `${leftPanelWidth}px`,
            height: "100%",
            transform: showLeftPanel ? "translateX(0)" : "translateX(-14px)",
            opacity: showLeftPanel ? 1 : 0,
            pointerEvents: showLeftPanel ? "auto" : "none",
            transition: `transform ${SIDEBAR_TRANSITION}, opacity 160ms ease`,
          }}
        >
          <PanelErrorBoundary name="Sidebar">
            <LeftPanel />
          </PanelErrorBoundary>
        </div>
      </div>
      <div style={{ gridRow: "2", gridColumn: "2", overflow: "hidden" }}>
        <PanelErrorBoundary name="Terminal">
          <TerminalMultiplexer />
        </PanelErrorBoundary>
      </div>
      <div
        style={{
          gridRow: "2",
          gridColumn: "3",
          overflow: "hidden",
          position: "relative",
        }}
      >
        {/* Drag handle on left edge of right panel */}
        <div
          onMouseDown={showRightPanel ? handleDragStart : undefined}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "4px",
            height: "100%",
            cursor: showRightPanel ? "col-resize" : "default",
            zIndex: 10,
            borderLeft: "1px solid var(--border-default)",
            opacity: showRightPanel ? 1 : 0,
            pointerEvents: showRightPanel ? "auto" : "none",
            transition: `border-color 0.15s, opacity ${SIDEBAR_TRANSITION}`,
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLDivElement).style.borderLeftColor =
              "var(--accent)";
          }}
          onMouseLeave={(e) => {
            if (!isDragging.current) {
              (e.currentTarget as HTMLDivElement).style.borderLeftColor =
                "var(--border-default)";
            }
          }}
        />
        <div
          style={{
            width: `${rightPanelWidth}px`,
            height: "100%",
            transform: showRightPanel ? "translateX(0)" : "translateX(14px)",
            opacity: showRightPanel ? 1 : 0,
            pointerEvents: showRightPanel ? "auto" : "none",
            transition: `transform ${SIDEBAR_TRANSITION}, opacity 160ms ease`,
          }}
        >
          <PanelErrorBoundary name="File Tree">
            <RightPanel />
          </PanelErrorBoundary>
        </div>
      </div>
      <div style={{ gridRow: "3", gridColumn: "1 / -1" }}>
        <StatusBar />
      </div>
      <FilePickerPopup />
    </div>
  );
}

export default App;
