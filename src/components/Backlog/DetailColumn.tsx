import type { NeighbourPill, WorkbenchTab } from "../../lib/havenWorkbench";
import {
  epicColour,
  lastTouchedLine,
  neighbourhood,
  offViewNote,
  ownerLabel,
  partOf,
  priorityWord,
  sideText,
  statusColour,
  statusWord,
} from "../../lib/havenWorkbench";
import { useWorkbench } from "./WorkbenchContext";

/**
 * One side of the dependency neighbourhood. Both sides are always drawn in full
 * once the item has any tracked dependency at all: the graph is a DAG and 104 of
 * RetroStack's linked items branch, so anything that assumes a line lies at a
 * fork.
 */
function Side({
  arrow,
  label,
  list,
  onGoTo,
}: {
  arrow: string;
  label: string;
  list: NeighbourPill[];
  onGoTo: (ref: string) => void;
}) {
  const empty = sideText(list);
  return (
    <div className="hz-side">
      <span className="hz-sidelab">
        {arrow} {label}
        <span className="hz-siden">{list.length}</span>
      </span>
      <div className="hz-seq">
        {empty ? (
          <span className="hz-none">{empty}</span>
        ) : (
          list.map((p) => (
            <button
              key={p.ref}
              type="button"
              className={p.from ? "hz-step hz-from" : "hz-step"}
              title={p.from ? "you came from here" : undefined}
              onClick={() => onGoTo(p.ref)}
            >
              {p.ref}
              {p.status && <span className="hz-sl">{p.status}</span>}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

export interface DetailColumnProps {
  current: string;
  cameFrom: string | null;
  /** The top of the trail, drawn as the `‹ RS-184` back control. */
  back: string | null;
  idx: Map<string, WorkbenchTab>;
  onBack: () => void;
  onClose: () => void;
}

/**
 * The detail column (§9). It is a column, not an overlay, and it deliberately
 * carries no list-node ref attribute: hover highlighting, the wire endpoints and
 * the selection ring all walk the nodes that carry one, and the column is not a
 * list node.
 */
export default function DetailColumn({
  current,
  cameFrom,
  back,
  idx,
  onBack,
  onClose,
}: DetailColumnProps) {
  const { view, theme, accentHue, now, goTo } = useWorkbench();
  const item = view.byRef.get(current);

  if (!item) {
    return (
      <div className="hz-drawer">
        <div className="hz-dr-top">
          <span className="hz-dr-ref">{current}</span>
          <button className="hz-dr-x" title="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="hz-dr-p" style={{ marginTop: 10, color: "var(--text-secondary)" }}>
          Not in the current read.
        </p>
      </div>
    );
  }

  const owner = ownerLabel(item);
  const chips = partOf(view, current);
  const hood = neighbourhood(view, current, cameFrom);
  const note = offViewNote(idx, item, now);

  return (
    <div className="hz-drawer">
      <div className="hz-dr-top">
        {back && (
          <button className="hz-dr-back" title={`Back to ${back}`} onClick={onBack}>
            ‹ {back}
          </button>
        )}
        <span className="hz-dr-ref">{item.ref}</span>
        {owner && (
          <span className={owner === "AI" ? "hz-owner hz-ai" : "hz-owner hz-you"}>
            {owner}
          </span>
        )}
        <button className="hz-dr-x" title="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="hz-dr-title">{item.title}</div>
      <div className="hz-pills">
        <span className="hz-pill hz-st" style={{ color: statusColour(item.status) }}>
          {statusWord(item.status)}
        </span>
        {item.type && <span className="hz-pill">{item.type}</span>}
        <span className="hz-pill">priority {priorityWord(item.priority)}</span>
        {item.wait && (
          <span className="hz-pill">waiting {String(item.wait).replace("on_", "on ")}</span>
        )}
      </div>
      {/* `updated_at` moves on any edit — the line says so rather than implying
          a state change Haven does not record. */}
      <p className="hz-touch">{lastTouchedLine(item.upd, now)}</p>
      {chips.length > 0 && (
        <>
          <div className="hz-dr-h">Part of</div>
          <div className="hz-rel">
            {chips.map((c) =>
              c.primary ? (
                <button
                  key={c.ref}
                  type="button"
                  className="hz-chip"
                  style={{ borderColor: epicColour(c.ref, theme, accentHue) }}
                  onClick={() => goTo(c.ref)}
                >
                  {c.label}
                </button>
              ) : (
                <button
                  key={c.ref}
                  type="button"
                  className="hz-chip"
                  onClick={() => goTo(c.ref)}
                >
                  {c.ref}
                  <span className="hz-cs">{c.label}</span>
                </button>
              ),
            )}
          </div>
        </>
      )}
      {item.why && (
        <>
          <div className="hz-dr-h">Why</div>
          <p className="hz-dr-p">{item.why}</p>
        </>
      )}
      {item.dll && (
        <>
          <div className="hz-dr-h">Done looks like</div>
          <p className="hz-dr-p">{item.dll}</p>
        </>
      )}
      {note && <div className="hz-offview">{note}</div>}
      {hood.any && (
        <>
          <div className="hz-dr-h">Dependencies</div>
          <div className="hz-hood">
            <Side arrow="←" label="must finish first" list={hood.before} onGoTo={goTo} />
            <Side arrow="→" label="this unlocks" list={hood.after} onGoTo={goTo} />
          </div>
        </>
      )}
    </div>
  );
}
