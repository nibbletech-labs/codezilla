import { useEffect, useState } from "react";

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
 *
 * The drag lives in an effect keyed on `dragging` so React owns its teardown:
 * unmounting mid-drag (the detail column closes on a jump) then takes the
 * overlay and both window listeners with it.
 */
export default function Splitter({
  rootRef,
  onWidth,
}: {
  rootRef: React.RefObject<HTMLDivElement>;
  onWidth: (width: number) => void;
}) {
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    const root = rootRef.current;
    if (!root) return;

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
      if (width > 0) onWidth(width);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      overlay.remove();
      document.body.style.cursor = "";
    };
  }, [dragging, rootRef, onWidth]);

  return (
    <div
      className={dragging ? "hz-splitter hz-drag" : "hz-splitter"}
      onMouseDown={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
    />
  );
}
