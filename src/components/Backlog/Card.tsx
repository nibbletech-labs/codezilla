import React from "react";
import type { HavenItem } from "../../lib/havenTypes";
import {
  ageText,
  epicColour,
  epicShortName,
  isStale,
  meterFill,
  ownerLabel,
  statusWord,
  untouchedText,
  waitsOf,
} from "../../lib/havenWorkbench";
import { useWorkbench } from "./WorkbenchContext";

/** The four-slot priority meter (§6.1). Filled count is `4 − priority`. */
export function PriorityMeter({ priority }: { priority: number | null }) {
  const m = meterFill(priority);
  return (
    <span className={m.top ? "hz-pm hz-top" : "hz-pm"} title={m.title}>
      {[1, 2, 3, 4].map((n) => (
        <i key={n} className={n <= m.on ? "hz-on" : undefined} />
      ))}
    </span>
  );
}

export function OwnerTag({ item }: { item: HavenItem }) {
  const label = ownerLabel(item);
  if (!label) return null;
  return (
    <span className={label === "AI" ? "hz-owner hz-ai" : "hz-owner hz-you"}>{label}</span>
  );
}

/**
 * What the item is waiting on: unmet dependencies as clickable chips, or the
 * cleared-blocker flag. Never rendered when there is nothing true to say.
 */
export function Waits({ item }: { item: HavenItem }) {
  const { view, goTo } = useWorkbench();
  const waits = waitsOf(view, item.ref);
  if (waits.kind === "none") return null;
  if (waits.kind === "cleared") {
    return (
      <div className="hz-waits">
        <span className="hz-clear">✓ {waits.text}</span>
      </div>
    );
  }
  return (
    <div className="hz-waits">
      waiting on
      {waits.refs.map((ref) => {
        const target = view.byRef.get(ref);
        return (
          <button
            key={ref}
            className="hz-wchip"
            onClick={(e) => {
              e.stopPropagation();
              goTo(ref);
            }}
          >
            {target ? `${ref} · ${statusWord(target.status)}` : ref}
          </button>
        );
      })}
      {waits.external && <span className="hz-wchip hz-static">external</span>}
    </div>
  );
}

export interface CardProps {
  item: HavenItem;
  selected: boolean;
  /** The Done treatment: tick, dimmed title, no owner or meter. */
  done?: boolean;
  /** Show the reason and the waiting-on chips (On you, Stuck, Blocked, Linked). */
  reason?: boolean;
}

/**
 * Memoised: a jump changes `selected` on two nodes, and nothing else in the
 * board needs to re-render for it.
 */
export const Card = React.memo(function Card({ item, selected, done, reason }: CardProps) {
  const { theme, accentHue, now, select } = useWorkbench();
  const colour = epicColour(item.root, theme, accentHue);
  const stale = !done && isStale(item.upd, now);
  return (
    <div
      className={`hz-card${done ? " hz-done" : ""}${selected ? " hz-sel" : ""}`}
      tabIndex={0}
      data-ref={item.ref}
      data-root={item.root ?? ""}
      style={{ "--gc": colour } as React.CSSProperties}
      onClick={() => select(item.ref)}
    >
      <div className="hz-ctop">
        <span className="hz-cref">
          {item.ref}
          {done && <span className="hz-tick"> ✓</span>}
        </span>
        {!done && <PriorityMeter priority={item.priority} />}
        {!done && <OwnerTag item={item} />}
      </div>
      <div className="hz-ct">{item.title}</div>
      {reason && item.why && <div className="hz-why">{item.why}</div>}
      {reason && <Waits item={item} />}
      <div className="hz-cf">
        <span className="hz-tag">
          <span className="hz-tdot" />
          {epicShortName(item.rt)}
        </span>
        <span className={stale ? "hz-age hz-stale" : "hz-age"}>
          {done ? ageText(item.upd, now) : untouchedText(item.upd, now)}
        </span>
      </div>
    </div>
  );
});
