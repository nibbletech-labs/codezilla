import { createContext, useContext } from "react";
import type { HavenView } from "../../lib/havenTypes";

/**
 * What every card, row and chip needs and nothing that changes on selection —
 * `Card` and `Row` are memoised, and a context value that carried `current`
 * would re-render all ~170 nodes on every jump. Selection is passed as a prop
 * instead, so a jump re-renders two nodes.
 *
 * `now` moves once a minute, which is exactly when the age chips and day labels
 * should be redrawn.
 */
export interface WorkbenchCtx {
  view: HavenView;
  theme: "dark" | "light";
  accentHue: number;
  now: number;
  /** A direct click: select without moving the tab or the scroll. */
  select: (ref: string) => void;
  /** Follow a link: switch tab if needed, reveal, select and scroll. */
  goTo: (ref: string) => void;
}

export const WorkbenchContext = createContext<WorkbenchCtx | null>(null);

export function useWorkbench(): WorkbenchCtx {
  const ctx = useContext(WorkbenchContext);
  if (!ctx) throw new Error("useWorkbench outside a WorkbenchShell");
  return ctx;
}
