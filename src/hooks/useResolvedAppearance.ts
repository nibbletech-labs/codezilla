import { useEffect, useState } from "react";
import { useAppStore } from "../store/appStore";

export function useResolvedAppearance(): "dark" | "light" {
  const appearanceMode = useAppStore((s) => s.appearanceMode);
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    if (appearanceMode !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [appearanceMode]);

  if (appearanceMode === "dark") return "dark";
  if (appearanceMode === "light") return "light";
  return systemDark ? "dark" : "light";
}
