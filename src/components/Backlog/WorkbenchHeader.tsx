import { useEffect, useState } from "react";
import { readStamp } from "../../lib/havenWorkbench";

/**
 * `read 12s ago`. Ticks on its own ten-second timer so the rest of the workbench
 * is not re-rendered for a stamp, and says `never read` rather than inventing a
 * time for a read that has not happened.
 */
function ReadStamp({ readAt }: { readAt: number | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 10_000);
    return () => window.clearInterval(id);
  }, []);
  return <span className="hz-stamp">{readStamp(readAt, Date.now())}</span>;
}

export interface WorkbenchHeaderProps {
  name: string;
  /** The ref prefix from the read, falling back to the bound project key. */
  prefix: string;
  query: string;
  onQuery: (query: string) => void;
  hits: number;
  total: number;
  hoverMode: "tag" | "wire";
  onHoverMode: (mode: "tag" | "wire") => void;
  onRefresh: () => void;
  reading: boolean;
  readAt: number | null;
}

export default function WorkbenchHeader({
  name,
  prefix,
  query,
  onQuery,
  hits,
  total,
  hoverMode,
  onHoverMode,
  onRefresh,
  reading,
  readAt,
}: WorkbenchHeaderProps) {
  // A short spin on click even when the read comes back instantly.
  const [pulse, setPulse] = useState(false);
  const spinning = reading || pulse;
  return (
    <div className="hz-head">
      <span className="hz-h1">
        Backlog
        <span className="hz-k">
          {name} · {prefix}
        </span>
      </span>
      <span className="hz-search">
        🔍
        <input
          value={query}
          placeholder="Filter this tab"
          onChange={(e) => onQuery(e.target.value)}
        />
        <span className="hz-qn">{query.trim() ? `${hits} of ${total}` : ""}</span>
        {query !== "" && (
          <button className="hz-qx" title="Clear filter" onClick={() => onQuery("")}>
            ✕
          </button>
        )}
      </span>
      {/* The mockup keeps this on the page chrome; the app has no such chrome. */}
      <button
        className="hz-mode"
        aria-pressed={hoverMode === "tag"}
        title="Hover a card to light up the rest of its epic"
        onClick={() => onHoverMode("tag")}
      >
        epic
      </button>
      <button
        className="hz-mode"
        aria-pressed={hoverMode === "wire"}
        title="Hover a card to draw its dependencies"
        onClick={() => onHoverMode("wire")}
      >
        wires
      </button>
      <button
        className={spinning ? "hz-refresh hz-spin" : "hz-refresh"}
        title="Read from Haven"
        onClick={() => {
          setPulse(true);
          onRefresh();
        }}
        onAnimationEnd={() => setPulse(false)}
      >
        ↻
      </button>
      <ReadStamp readAt={readAt} />
    </div>
  );
}
