import { useEffect } from "react";
import { useAppStore } from "../store/appStore";
import {
  DARK_PALETTE,
  LIGHT_PALETTE,
  applyTheme,
  getAccentColor,
} from "../lib/themes";

export function useTheme() {
  const accentColorId = useAppStore((s) => s.accentColorId);
  const appearanceMode = useAppStore((s) => s.appearanceMode);

  useEffect(() => {
    const accent = getAccentColor(accentColorId);

    const apply = (prefersDark: boolean) => {
      const isDark =
        appearanceMode === "dark" ||
        (appearanceMode === "system" && prefersDark);
      const palette = isDark ? DARK_PALETTE : LIGHT_PALETTE;
      applyTheme(palette, accent, isDark);
      document.body.style.backgroundColor = palette.bgPrimary;
      document.body.style.color = palette.textPrimary;
    };

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    apply(mq.matches);

    if (appearanceMode === "system") {
      const handler = (e: MediaQueryListEvent) => apply(e.matches);
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
  }, [accentColorId, appearanceMode]);
}
