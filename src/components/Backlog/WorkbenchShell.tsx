import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useAppStore } from "../../store/appStore";
import { useResolvedAppearance } from "../../hooks/useResolvedAppearance";
import { getAccentColor } from "../../lib/themes";
import type { HavenViewResult } from "../../hooks/useHavenView";
import type { BacklogOrder, BacklogZone, StartOfDay } from "../../lib/havenWorkbench";
import {
  hexToHue,
  orderedTabs,
  searchCount,
  tabIndex,
  tabNodes,
  tabOf,
  zoneIndex,
  zoneOf,
} from "../../lib/havenWorkbench";
import { type NavCtx, initialNav, navReduce } from "../../lib/havenNav";
import { WorkbenchContext, type WorkbenchCtx } from "./WorkbenchContext";
import { WORKBENCH_CSS } from "./workbenchStyles";
import WorkbenchHeader from "./WorkbenchHeader";
import TabStrip, { type RealTab } from "./TabStrip";
import DetailColumn from "./DetailColumn";
import Splitter from "./Splitter";
import HoverFx from "./HoverFx";
import { BacklogTab, BlockedTab, DoneLog, InFlightBoard, LinkedItemView } from "./tabs";

const DEFAULT_DRAWER_WIDTH = 340;
const MINUTE_MS = 60_000;

/** Local midnight, and the zone that produced it — the day labels use both. */
const localStartOfDay: StartOfDay = (ms) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * State 3 of the workbench: the board itself (spec §5–§9).
 *
 * Everything session-scoped lives here — the navigation reducer (tab, selection,
 * trail, filter, collapsed groups), the Backlog order switch, the hover mode and
 * the detail column's width — and none of it is persisted. Nothing here derives
 * data: the lists come from `orderedTabs` over CZ-46's buckets, and every string
 * comes from `havenWorkbench`.
 */
export default function WorkbenchShell({
  name,
  projectKey,
  result,
  onRefresh,
  errorLine,
}: {
  name: string;
  projectKey: string;
  result: HavenViewResult;
  onRefresh: () => void;
  /** A failed re-read keeps the last good board; this line says so. */
  errorLine?: React.ReactNode;
}) {
  const theme = useResolvedAppearance();
  const accentColorId = useAppStore((s) => s.accentColorId);
  const accentHue = useMemo(
    () => hexToHue(getAccentColor(accentColorId).value),
    [accentColorId],
  );

  const view = result.view!;
  const buckets = result.buckets!;
  const lists = useMemo(() => orderedTabs(buckets), [buckets]);
  const idx = useMemo(() => tabIndex(lists), [lists]);
  const zones = useMemo(() => zoneIndex(lists), [lists]);

  const ctx = useMemo<NavCtx>(
    () => ({
      tabOf: (ref) => tabOf(idx, ref),
      has: (ref) => view.byRef.has(ref),
      rootOf: (ref) => view.byRef.get(ref)?.root ?? null,
      zoneOf: (ref) => zoneOf(zones, ref),
    }),
    [idx, zones, view],
  );
  const reduce = useCallback(
    (state: Parameters<typeof navReduce>[0], action: Parameters<typeof navReduce>[1]) =>
      navReduce(state, action, ctx),
    [ctx],
  );
  const [nav, dispatch] = useReducer(reduce, undefined, initialNav);

  const [order, setOrder] = useState<BacklogOrder>("epic");
  const [hoverMode, setHoverMode] = useState<"tag" | "wire">("tag");
  const [dw, setDw] = useState(DEFAULT_DRAWER_WIDTH);

  // Age chips and day labels are relative; nothing else moves on the tick, and
  // tab membership is fixed at read time, not by the clock.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => window.clearInterval(id);
  }, []);

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const select = useCallback((ref: string) => dispatch({ type: "select", ref }), []);
  const goTo = useCallback((ref: string) => dispatch({ type: "goTo", ref }), []);

  const contextValue = useMemo<WorkbenchCtx>(
    () => ({ view, theme, accentHue, now, select, goTo }),
    [view, theme, accentHue, now, select, goTo],
  );

  // Every jump lands visible: the reducer has already cleared the filter and
  // expanded the target's group, so the node is in the DOM by the time this runs.
  useEffect(() => {
    if (nav.scrollNonce === 0 || !nav.current) return;
    const container = scrollRef.current;
    if (!container) return;
    const target = container.querySelector(`[data-ref="${CSS.escape(nav.current)}"]`);
    target?.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
  }, [nav.scrollNonce, nav.current]);

  const nodes = useMemo(() => tabNodes(lists, nav.tab), [lists, nav.tab]);
  const counted = useMemo(
    () => searchCount(view, nodes, nav.query),
    [view, nodes, nav.query],
  );

  const onToggle = useCallback(
    (zone: BacklogZone, root: string | null) =>
      dispatch({ type: "toggleGroup", zone, root }),
    [],
  );
  const onOrder = useCallback((next: BacklogOrder) => {
    setOrder(next);
    // The mockup rebuilds the tab body on this switch, reopening every group.
    dispatch({ type: "resetGroups" });
  }, []);

  return (
    <div
      ref={rootRef}
      className="hz-root"
      style={{ ...containerStyle, "--dw": `${dw}px` } as React.CSSProperties}
    >
      <style>{WORKBENCH_CSS}</style>
      <WorkbenchContext.Provider value={contextValue}>
        <WorkbenchHeader
          name={name}
          prefix={view.prefix ?? projectKey}
          query={nav.query}
          onQuery={(query) => dispatch({ type: "setQuery", query })}
          hits={counted.hits}
          total={counted.total}
          hoverMode={hoverMode}
          onHoverMode={setHoverMode}
          onRefresh={onRefresh}
          reading={result.entry.reading}
          readAt={result.entry.readAt ?? null}
        />
        {errorLine}
        <TabStrip
          active={nav.tab}
          counts={result.counts}
          onSelect={(tab: RealTab) => dispatch({ type: "showTab", tab })}
        />
        <div className="hz-workarea">
          <div className="hz-main">
            <div className="hz-scroll" ref={scrollRef}>
              {nav.tab === "flight" && (
                <InFlightBoard lists={lists} query={nav.query} current={nav.current} />
              )}
              {nav.tab === "blocked" && (
                <BlockedTab lists={lists} query={nav.query} current={nav.current} />
              )}
              {nav.tab === "backlog" && (
                <BacklogTab
                  lists={lists}
                  order={order}
                  query={nav.query}
                  current={nav.current}
                  collapsed={nav.collapsed}
                  onOrder={onOrder}
                  onToggle={onToggle}
                />
              )}
              {nav.tab === "done" && (
                <DoneLog
                  lists={lists}
                  query={nav.query}
                  current={nav.current}
                  startOfDay={localStartOfDay}
                  timeZone={LOCAL_ZONE}
                />
              )}
              {nav.tab === "linked" && nav.linkedRef && (
                <LinkedItemView linkedRef={nav.linkedRef} current={nav.current} />
              )}
            </div>
          </div>
          {nav.current && <Splitter rootRef={rootRef} onWidth={setDw} />}
          {nav.current && (
            <DetailColumn
              current={nav.current}
              cameFrom={nav.cameFrom}
              back={nav.trail.length ? nav.trail[nav.trail.length - 1] : null}
              idx={idx}
              onBack={() => dispatch({ type: "back" })}
              onClose={() => dispatch({ type: "close" })}
            />
          )}
        </div>
        <HoverFx rootRef={rootRef} mode={hoverMode} tab={nav.tab} />
      </WorkbenchContext.Provider>
    </div>
  );
}

const containerStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 15,
  background: "var(--bg-primary)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};
