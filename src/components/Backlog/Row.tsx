import React from "react";
import type { HavenItem } from "../../lib/havenTypes";
import {
  epicColour,
  epicShortName,
  touchedText,
  unmetCount,
} from "../../lib/havenWorkbench";
import { PriorityMeter } from "./Card";
import { useWorkbench } from "./WorkbenchContext";

export interface RowProps {
  item: HavenItem;
  selected: boolean;
  /** Done rows: tick and `touched 3d` instead of the priority meter. */
  done?: boolean;
  /** The epic tag rides along in flat order and on Done; the group head carries it otherwise. */
  tag?: boolean;
}

/** Memoised for the same reason as `Card` — Done lists 168 of these. */
export const Row = React.memo(function Row({ item, selected, done, tag }: RowProps) {
  const { view, theme, accentHue, now, select } = useWorkbench();
  const colour = epicColour(item.root, theme, accentHue);
  const unmet = done ? 0 : unmetCount(view, item.ref);
  const activate = () => select(item.ref);
  return (
    <div
      className={`hz-row${done ? " hz-done" : ""}${selected ? " hz-sel" : ""}`}
      role="button"
      tabIndex={0}
      data-ref={item.ref}
      data-root={item.root ?? ""}
      style={{ "--gc": colour } as React.CSSProperties}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        // Space would scroll the list out from under the row otherwise.
        e.preventDefault();
        activate();
      }}
    >
      <span className="hz-rref">{item.ref}</span>
      <span className="hz-rt">{item.title}</span>
      {tag && (
        <span className="hz-tag hz-rtag">
          <span className="hz-tdot" />
          {epicShortName(item.rt)}
        </span>
      )}
      {unmet > 0 && <span className="hz-lnk">waiting on {unmet}</span>}
      {done ? (
        <>
          <span className="hz-tick">✓</span>
          <span className="hz-age">{touchedText(item.upd, now)}</span>
        </>
      ) : (
        <PriorityMeter priority={item.priority} />
      )}
    </div>
  );
});
