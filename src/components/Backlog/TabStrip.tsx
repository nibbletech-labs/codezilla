import type { HavenTabCounts } from "../../lib/havenTypes";
import type { NavTab } from "../../lib/havenNav";

export type RealTab = Exclude<NavTab, "linked">;

const TABS: { key: RealTab; label: string; count: keyof HavenTabCounts }[] = [
  { key: "flight", label: "In flight", count: "inFlight" },
  { key: "blocked", label: "Blocked", count: "blocked" },
  { key: "backlog", label: "Backlog", count: "backlog" },
  { key: "done", label: "Done", count: "done" },
];

/**
 * The four tabs. While the transient Linked-item view is showing, no tab is
 * selected — the item is on none of them, and saying otherwise would be a lie.
 */
export default function TabStrip({
  active,
  counts,
  onSelect,
}: {
  active: NavTab;
  counts: HavenTabCounts | null;
  onSelect: (tab: RealTab) => void;
}) {
  return (
    <div className="hz-tabs" role="tablist">
      {TABS.map((t) => (
        <button
          key={t.key}
          className="hz-tab"
          role="tab"
          aria-selected={t.key === active}
          onClick={() => onSelect(t.key)}
        >
          {t.label}
          <span className="hz-n">{counts ? counts[t.count] : "—"}</span>
        </button>
      ))}
    </div>
  );
}
