import type { HavenItem } from "../../lib/havenTypes";
import {
  DONE_ZONE,
  EMPTY_LINES,
  type BacklogOrder,
  type BacklogZone,
  type OrderedTabs,
  type StartOfDay,
  epicColour,
  filterList,
  groupByDay,
  groupByEpic,
} from "../../lib/havenWorkbench";
import { groupKey } from "../../lib/havenNav";
import { Card } from "./Card";
import { Row } from "./Row";
import { useWorkbench } from "./WorkbenchContext";

/** The tab's own voice when it holds nothing at all (§5). */
export function EmptyLine({ tab }: { tab: keyof typeof EMPTY_LINES }) {
  return <div className="hz-empty">{EMPTY_LINES[tab]}</div>;
}

function Zone({
  label,
  note,
  hint,
  children,
}: {
  label: string;
  note?: React.ReactNode;
  hint?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="hz-zone">
      {label}
      {note != null && <span className="hz-n">{note}</span>}
      {children}
      {hint && <span className="hz-hint">{hint}</span>}
    </div>
  );
}

// ------------------------------------------------------------- In flight ----

function Column({
  label,
  colour,
  note,
  list,
  count,
  current,
  reason,
}: {
  label: string;
  colour: string;
  note: string;
  list: HavenItem[];
  /**
   * What the column holds, before the filter. The zone counts elsewhere (and
   * the mockup) report the tab's contents, not the search result, so a column
   * heading must not shrink while you type.
   */
  count: number;
  current: string | null;
  reason?: boolean;
}) {
  return (
    <div className="hz-col">
      <div className="hz-colhead">
        <span className="hz-dot" style={{ background: colour }} />
        {label}
        <span className="hz-n">{count}</span>
      </div>
      <div className="hz-colnote">{note}</div>
      <div className="hz-cards">
        {list.map((i) => (
          <Card key={i.ref} item={i} selected={current === i.ref} reason={reason} />
        ))}
      </div>
    </div>
  );
}

export function InFlightBoard({
  lists,
  query,
  current,
}: {
  lists: OrderedTabs;
  query: string;
  current: string | null;
}) {
  const { view } = useWorkbench();
  const total =
    lists.flight.moving.length + lists.flight.you.length + lists.flight.stuck.length;
  if (total === 0) return <EmptyLine tab="flight" />;
  return (
    <div className="hz-boardwrap">
      <div className="hz-board" style={{ "--cols": 3 } as React.CSSProperties}>
        <Column
          label="In progress"
          colour="var(--accent)"
          note="claimed and moving"
          list={filterList(view, lists.flight.moving, query)}
          count={lists.flight.moving.length}
          current={current}
        />
        <Column
          label="On you"
          colour="var(--warn)"
          note="your review or decision"
          list={filterList(view, lists.flight.you, query)}
          count={lists.flight.you.length}
          current={current}
          reason
        />
        <Column
          label="Stuck"
          colour="var(--bad)"
          note="picked up, hit a wall"
          list={filterList(view, lists.flight.stuck, query)}
          count={lists.flight.stuck.length}
          current={current}
          reason
        />
      </div>
    </div>
  );
}

// --------------------------------------------------------------- Blocked ----

export function BlockedTab({
  lists,
  query,
  current,
}: {
  lists: OrderedTabs;
  query: string;
  current: string | null;
}) {
  const { view } = useWorkbench();
  if (lists.blocked.length === 0) return <EmptyLine tab="blocked" />;
  const shown = filterList(view, lists.blocked, query);
  return (
    <>
      <Zone
        label="Parked"
        note={lists.blocked.length}
        hint="nobody owns these — each was set aside for a stated reason"
      />
      <div className="hz-cards hz-wide">
        {shown.map((i) => (
          <Card key={i.ref} item={i} selected={current === i.ref} reason />
        ))}
      </div>
    </>
  );
}

// --------------------------------------------------------------- Backlog ----

function EpicGroup({
  zone,
  root,
  name,
  items,
  open,
  current,
  onToggle,
}: {
  zone: BacklogZone;
  root: string | null;
  name: string;
  items: HavenItem[];
  open: boolean;
  current: string | null;
  onToggle: (zone: BacklogZone, root: string | null) => void;
}) {
  const { theme, accentHue } = useWorkbench();
  return (
    <div className="hz-gsec">
      <button
        type="button"
        className={open ? "hz-ghead hz-open" : "hz-ghead"}
        style={{ "--gc": epicColour(root, theme, accentHue) } as React.CSSProperties}
        aria-expanded={open}
        onClick={() => onToggle(zone, root)}
      >
        <span className="hz-gcaret">▶</span>
        <span className="hz-gdot" />
        <span className="hz-gn">{name}</span>
        <span className="hz-gc">{items.length}</span>
      </button>
      {open && (
        <div className="hz-grows">
          {items.map((i) => (
            <Row key={i.ref} item={i} selected={current === i.ref} />
          ))}
        </div>
      )}
    </div>
  );
}

function BacklogZoneBody({
  zone,
  list,
  order,
  query,
  current,
  collapsed,
  onToggle,
}: {
  zone: BacklogZone;
  list: HavenItem[];
  order: BacklogOrder;
  query: string;
  current: string | null;
  collapsed: Set<string>;
  onToggle: (zone: BacklogZone, root: string | null) => void;
}) {
  const { view } = useWorkbench();
  // Filtering runs before grouping, so an epic whose rows all filter out simply
  // is not there — no empty heading to hide afterwards.
  const shown = filterList(view, list, query);
  if (order === "priority") {
    return (
      <>
        {shown.map((i) => (
          <Row key={i.ref} item={i} selected={current === i.ref} tag />
        ))}
      </>
    );
  }
  return (
    <>
      {groupByEpic(shown).map((g) => (
        <EpicGroup
          key={g.key}
          zone={zone}
          root={g.root}
          name={g.name}
          items={g.items}
          open={!collapsed.has(groupKey(zone, g.root))}
          current={current}
          onToggle={onToggle}
        />
      ))}
    </>
  );
}

export function BacklogTab({
  lists,
  order,
  query,
  current,
  collapsed,
  onOrder,
  onToggle,
}: {
  lists: OrderedTabs;
  order: BacklogOrder;
  query: string;
  current: string | null;
  collapsed: Set<string>;
  onOrder: (order: BacklogOrder) => void;
  onToggle: (zone: BacklogZone, root: string | null) => void;
}) {
  const { ready, needsDef } = lists.backlog;
  if (ready.length + needsDef.length === 0) return <EmptyLine tab="backlog" />;
  return (
    <>
      <Zone label="Ready" note={ready.length}>
        {/* The structure or the queue, never both at once (§5). */}
        <span className="hz-ord">
          Order
          <button
            type="button"
            className="hz-ob"
            aria-pressed={order === "epic"}
            onClick={() => onOrder("epic")}
          >
            by epic
          </button>
          <button
            type="button"
            className="hz-ob"
            aria-pressed={order === "priority"}
            onClick={() => onOrder("priority")}
          >
            by priority
          </button>
        </span>
      </Zone>
      <BacklogZoneBody
        zone="ready"
        list={ready}
        order={order}
        query={query}
        current={current}
        collapsed={collapsed}
        onToggle={onToggle}
      />
      <Zone
        label="Needs definition"
        note={needsDef.length}
        hint="committed, but not ready yet — no acceptance written"
      />
      <BacklogZoneBody
        zone="needsDef"
        list={needsDef}
        order={order}
        query={query}
        current={current}
        collapsed={collapsed}
        onToggle={onToggle}
      />
    </>
  );
}

// ------------------------------------------------------------------ Done ----

export function DoneLog({
  lists,
  query,
  current,
  startOfDay,
  timeZone,
}: {
  lists: OrderedTabs;
  query: string;
  current: string | null;
  startOfDay: StartOfDay;
  timeZone: string;
}) {
  const { view, now } = useWorkbench();
  if (lists.done.length === 0) return <EmptyLine tab="done" />;
  const groups = groupByDay(filterList(view, lists.done, query), now, startOfDay, timeZone);
  return (
    <>
      <Zone label={DONE_ZONE.label} note={DONE_ZONE.note} hint={DONE_ZONE.hint} />
      {groups.map((g) => (
        <div key={g.key}>
          <div className="hz-daysep">{g.label}</div>
          {g.items.map((i) => (
            <Row key={i.ref} item={i} selected={current === i.ref} done tag />
          ))}
        </div>
      ))}
    </>
  );
}

// ----------------------------------------------------------- Linked item ----

/**
 * A one-card landing for work no tab lists — completed more than a fortnight
 * ago, archived, or still in the icebox — so every jump arrives somewhere
 * visible (§5).
 */
export function LinkedItemView({
  linkedRef,
  current,
}: {
  linkedRef: string;
  current: string | null;
}) {
  const { view } = useWorkbench();
  const item = view.byRef.get(linkedRef);
  return (
    <>
      <Zone
        label="Linked item"
        note={linkedRef}
        hint="reached from a dependency — not listed on any tab"
      />
      {item && (
        <div className="hz-cards hz-wide">
          <Card item={item} selected={current === item.ref} reason />
        </div>
      )}
    </>
  );
}
