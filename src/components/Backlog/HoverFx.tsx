import { useEffect, useRef, useState } from "react";
import { useWorkbench } from "./WorkbenchContext";

interface Wire {
  d: string;
  cx: number;
  cy: number;
}

/** Refs and roots reach CSS selectors, so anything unusual is skipped, not escaped. */
const SAFE = /^[A-Za-z0-9_-]+$/;

/**
 * Hover highlighting without re-rendering a single card.
 *
 * Hovering ~170 nodes through React state would redraw the whole tab twice per
 * mouse move. Instead one rule set is written into a `<style>` element that React
 * renders **childless** — React owns an empty element and its rules are inserted
 * imperatively through the CSSOM — and `data-fx` is toggled on the workbench
 * root, which React never renders, so the two never fight over the attribute.
 *
 * Both of the mockup's guards are kept: an ungrouped item dims nothing in epic
 * mode, and an item with no tracked dependencies dims nothing in wire mode.
 */
export default function HoverFx({
  rootRef,
  mode,
  tab,
}: {
  rootRef: React.RefObject<HTMLDivElement>;
  mode: "tag" | "wire";
  tab: string;
}) {
  const { view } = useWorkbench();
  const styleRef = useRef<HTMLStyleElement>(null);
  const [wires, setWires] = useState<Wire[]>([]);

  // The view is read on hover, never rendered from, so it rides in a ref: a
  // background read landing mid-hover would otherwise tear the listeners down
  // and clear the highlight under the pointer.
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  useEffect(() => {
    const root = rootRef.current;
    const style = styleRef.current;
    if (!root || !style) return;

    // Rules are inserted through the CSSOM, never written as text children.
    // Tauri stamps a nonce into the packaged app's `style-src`, and a nonce
    // source makes the CSP ignore `'unsafe-inline'`, so a `<style>` element
    // carrying text is blocked in a build. `insertRule` is not governed by
    // `style-src`, so the element stays childless and the rules still apply.
    // Every ref and root reaching a selector is `SAFE`-checked first, so a rule
    // can never be malformed.
    const write = (rules: string[]) => {
      const sheet = style.sheet;
      if (!sheet) return;
      while (sheet.cssRules.length) sheet.deleteRule(0);
      for (const rule of rules) sheet.insertRule(rule, sheet.cssRules.length);
    };

    const clear = () => {
      root.removeAttribute("data-fx");
      write([]);
      setWires([]);
    };

    const onOver = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const el = target?.closest?.("[data-ref]") as HTMLElement | null;
      if (!el) return;
      const ref = el.dataset.ref ?? "";
      const root_ = el.dataset.root ?? "";
      if (!SAFE.test(ref)) return clear();

      if (mode === "tag") {
        // The mockup early-returns on an empty root: an ungrouped item has no
        // siblings to light up, so dimming everything else would say nothing.
        if (!root_ || !SAFE.test(root_)) return clear();
        write([
          `[data-fx] [data-ref] { opacity: .26 }`,
          `[data-fx] [data-root="${root_}"], [data-fx] [data-ref="${ref}"], [data-fx] .hz-sel { opacity: 1 }`,
          `[data-fx="tag"] .hz-card[data-root="${root_}"] { border-color: var(--gc) }`,
        ]);
        setWires([]);
        root.setAttribute("data-fx", "tag");
        return;
      }

      const current = viewRef.current;
      const related = [
        ...(current.dependsOn.get(ref) ?? []),
        ...(current.requiredBy.get(ref) ?? []),
      ].filter((r) => SAFE.test(r));
      // Nothing related means nothing to draw, so nothing is dimmed either.
      if (related.length === 0) return clear();

      const box = root.getBoundingClientRect();
      const a = el.getBoundingClientRect();
      const ax = a.right - box.left;
      const ay = a.top - box.top + a.height / 2;
      const drawn: Wire[] = [];
      const lit: string[] = [];
      for (const r of related) {
        const other = root.querySelector(`[data-ref="${r}"]`);
        if (!other) continue;
        lit.push(r);
        const b = other.getBoundingClientRect();
        const bx = b.left - box.left;
        const by = b.top - box.top + b.height / 2;
        const mid = (ax + bx) / 2;
        drawn.push({ d: `M${ax} ${ay} C${mid} ${ay} ${mid} ${by} ${bx} ${by}`, cx: bx, cy: by });
      }
      const keep = [ref, ...lit].map((r) => `[data-fx] [data-ref="${r}"]`).join(", ");
      const bordered = [ref, ...lit]
        .map((r) => `[data-fx="wire"] .hz-card[data-ref="${r}"]`)
        .join(", ");
      write([
        `[data-fx] [data-ref] { opacity: .26 }`,
        `${keep}, [data-fx] .hz-sel { opacity: 1 }`,
        `${bordered} { border-color: var(--accent) }`,
      ]);
      setWires(drawn);
      root.setAttribute("data-fx", "wire");
    };

    root.addEventListener("mouseover", onOver);
    root.addEventListener("mouseleave", clear);
    return () => {
      root.removeEventListener("mouseover", onOver);
      root.removeEventListener("mouseleave", clear);
      clear();
    };
    // Re-attaching on a tab or mode change is also what clears a stale rule.
  }, [rootRef, mode, tab]);

  return (
    <>
      <style ref={styleRef} />
      <svg className="hz-wires">
        {wires.map((w, n) => (
          <g key={n}>
            <path d={w.d} />
            <circle cx={w.cx} cy={w.cy} r={2.5} />
          </g>
        ))}
      </svg>
    </>
  );
}
