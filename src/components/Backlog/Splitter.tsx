import { useCallback, useState } from "react";

const MIN_DRAWER = 240;
const MIN_MAIN = 260;

/**
 * Drag to resize the detail column, following `App.tsx`'s pattern: a fixed
 * full-screen overlay so the terminal underneath cannot steal the mouse, window
 * listeners rather than element ones, and `col-resize` on the body.
 *
 * `--dw` is written straight onto the root during the drag and committed to
 * React state on mouseup — sixty state updates a second would re-render every
 * visible card for a value only CSS reads.
 */
export default function Splitter({
  rootRef,
  onWidth,
}: {
  rootRef: React.RefObject<HTMLDivElement>;
  onWidth: (width: number) => void;
}) {
  const [dragging, setDragging] = useState(false);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const root = rootRef.current;
      if (!root) return;
      setDragging(true);

      const overlay = document.createElement("div");
      overlay.id = "resize-overlay";
      overlay.style.cssText =
        "position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;cursor:col-resize;";
      document.body.appendChild(overlay);
      document.body.style.cursor = "col-resize";

      let width = 0;
      const onMouseMove = (ev: MouseEvent) => {
        const box = root.getBoundingClientRect();
        width = Math.min(
          Math.max(box.right - ev.clientX, MIN_DRAWER),
          Math.max(box.width - MIN_MAIN, MIN_MAIN),
        );
        root.style.setProperty("--dw", `${width}px`);
      };
      const onMouseUp = () => {
        setDragging(false);
        document.body.style.cursor = "";
        overlay.remove();
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
        if (width > 0) onWidth(width);
      };
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [rootRef, onWidth],
  );

  return (
    <div
      className={dragging ? "hz-splitter hz-drag" : "hz-splitter"}
      onMouseDown={onMouseDown}
    />
  );
}
