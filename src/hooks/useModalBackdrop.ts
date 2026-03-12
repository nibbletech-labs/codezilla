import { useAppStore } from "../store/appStore";
import { getLeftPanelWidth } from "../lib/constants";
import { getBackdropStyle } from "../styles/modal";

/** Returns a backdrop style that centres the modal over the terminal/content area. */
export function useModalBackdrop() {
  const showLeft = useAppStore((s) => s.showLeftPanel);
  const showRight = useAppStore((s) => s.showRightPanel);
  const baseFontSize = useAppStore((s) => s.baseFontSize);

  const leftWidth = showLeft ? getLeftPanelWidth(baseFontSize) : 0;

  let rightWidth = 0;
  if (showRight) {
    const val = getComputedStyle(document.documentElement).getPropertyValue("--right-panel-width");
    rightWidth = parseInt(val, 10) || 0;
  }

  return getBackdropStyle(leftWidth, rightWidth);
}
