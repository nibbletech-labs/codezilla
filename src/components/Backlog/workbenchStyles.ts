/**
 * The r13 mockup's treatment, ported token-for-token with an `hz-` prefix.
 *
 * One `<style>` block rather than the codebase's usual inline style objects,
 * because the mockup depends on `:hover`, `::before` epic edges, attribute-driven
 * dimming, `-webkit-line-clamp`, keyframes and per-container scrollbars — none of
 * which an inline style can express. `FilePreview.tsx` sets the precedent for a
 * component-owned `<style>` element.
 *
 * `--gc` is the epic colour, set per node; `--dw` is the detail column's width,
 * set on the root.
 */
export const WORKBENCH_CSS = `
.hz-root { position: relative; }

.hz-head { display: flex; align-items: center; gap: 12px; padding: 11px 16px 0; flex: 0 0 auto; }
.hz-h1 { font-size: calc(var(--font-size) + 1px); font-weight: 600; color: var(--text-heading); }
.hz-h1 .hz-k { color: var(--text-secondary); font-weight: 400; margin-left: 7px; font-size: var(--font-size-sm); }
.hz-search { margin-left: auto; display: flex; align-items: center; gap: 6px; background: var(--bg-panel); border: 1px solid var(--border-default); border-radius: 4px; padding: 3px 8px; width: 180px; }
.hz-search input { flex: 1; min-width: 0; background: none; border: none; outline: none; color: var(--text-primary); font: inherit; font-size: var(--font-size-sm); }
.hz-search input::placeholder { color: var(--text-hint); }
.hz-qn { font-size: 11px; color: var(--text-hint); flex: 0 0 auto; font-variant-numeric: tabular-nums; }
.hz-qx { flex: 0 0 auto; background: none; border: none; cursor: pointer; padding: 0 0 0 4px; color: var(--text-secondary); font-size: 11px; line-height: 1; }
.hz-qx:hover { color: var(--text-primary); }
.hz-refresh { background: none; border: none; color: var(--text-secondary); cursor: pointer; font-size: 13px; padding: 2px 4px; }
.hz-refresh:hover { color: var(--text-primary); }
/* Loops for as long as the class is on: a single .6s turn left the button
   spun-out whenever a read outlasted it. shouldSpin (clock-based) still
   decides when the class comes off, and the reduced-motion rule at the foot of
   this sheet still disables it. */
.hz-refresh.hz-spin { animation: hz-sp .6s linear infinite; }
@keyframes hz-sp { to { transform: rotate(360deg); } }
.hz-stamp { font-size: 11px; color: var(--text-hint); }
.hz-mode { font: inherit; font-size: 11px; background: none; cursor: pointer; border: 1px solid var(--border-default); border-radius: 3px; padding: 1px 7px; color: var(--text-secondary); }
.hz-mode:hover { color: var(--text-primary); }
.hz-mode[aria-pressed="true"] { color: var(--text-primary); border-color: var(--accent); }

.hz-tabs { display: flex; gap: 2px; padding: 10px 16px 0; flex: 0 0 auto; border-bottom: 1px solid var(--border-default); }
.hz-tab { font: inherit; font-size: var(--font-size); background: none; border: none; cursor: pointer; color: var(--text-secondary); padding: 6px 12px 8px; border-bottom: 2px solid transparent; display: flex; align-items: center; gap: 7px; }
.hz-tab:hover { color: var(--text-primary); }
.hz-tab[aria-selected="true"] { color: var(--text-heading); border-bottom-color: var(--accent); }
.hz-tab .hz-n { font-size: 11px; min-width: 19px; text-align: center; padding: 1px 5px; border-radius: 9px; background: var(--bg-elevated); color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.hz-tab[aria-selected="true"] .hz-n { color: var(--text-primary); }

.hz-workarea { flex: 1; display: flex; min-height: 0; }
.hz-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.hz-splitter { flex: 0 0 5px; cursor: col-resize; background: var(--border-subtle); border-left: 1px solid var(--border-default); transition: background-color .12s ease; }
.hz-splitter:hover, .hz-splitter.hz-drag { background: var(--accent); }
.hz-scroll { flex: 1; overflow-y: auto; padding: 6px 16px 24px; }
.hz-scroll::-webkit-scrollbar { width: 10px; }
.hz-scroll::-webkit-scrollbar-thumb { background: var(--border-default); border-radius: 5px; }

.hz-zone { display: flex; align-items: baseline; gap: 9px; padding: 16px 0 9px; font-size: var(--font-size-sm); text-transform: uppercase; letter-spacing: .6px; color: var(--text-secondary); }
.hz-zone .hz-n { color: var(--text-hint); letter-spacing: 0; }
.hz-zone .hz-hint { margin-left: auto; text-transform: none; letter-spacing: 0; color: var(--text-hint); font-size: 11px; }
.hz-empty { font-size: var(--font-size-sm); color: var(--text-hint); padding: 4px 2px 8px; }

.hz-boardwrap { overflow-x: auto; padding-bottom: 4px; }
.hz-boardwrap::-webkit-scrollbar { height: 9px; }
.hz-boardwrap::-webkit-scrollbar-thumb { background: var(--border-default); border-radius: 5px; }
.hz-board { display: grid; grid-template-columns: repeat(var(--cols, 3), minmax(196px, 1fr)); gap: 10px; align-items: start; }
.hz-col { min-width: 0; }
.hz-colhead { display: flex; align-items: center; gap: 7px; padding: 6px 2px 8px; font-size: var(--font-size-sm); color: var(--text-secondary); }
.hz-colhead .hz-dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; }
.hz-colhead .hz-n { margin-left: auto; color: var(--text-hint); }
.hz-colnote { font-size: 11px; color: var(--text-hint); padding: 0 2px 8px; margin-top: -4px; }
.hz-cards { display: flex; flex-direction: column; gap: 6px; }
.hz-cards.hz-wide { gap: 8px; }
.hz-cards.hz-wide .hz-card .hz-ct { -webkit-line-clamp: 2; font-size: 14px; }

.hz-card { position: relative; background: var(--bg-panel); border: 1px solid var(--border-default); border-radius: 5px; padding: 8px 9px 7px 12px; cursor: pointer; transition: border-color .12s ease, background-color .12s ease, opacity .12s ease; }
.hz-card::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; border-radius: 5px 0 0 5px; background: var(--gc, transparent); }
.hz-card:hover { background: var(--bg-elevated); border-color: var(--border-medium); }
.hz-card.hz-sel { border-color: var(--accent); box-shadow: inset 0 0 0 2px var(--accent), 0 0 0 3px var(--accent-selection); background: var(--bg-elevated); }
.hz-card .hz-ct { font-size: var(--font-size); color: var(--text-primary); line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.hz-card .hz-cf { display: flex; align-items: center; gap: 7px; margin-top: 7px; font-size: 11px; color: var(--text-secondary); }
.hz-ctop { display: flex; align-items: center; gap: 8px; margin-bottom: 3px; }
.hz-cref { color: var(--text-secondary); font-size: 11px; font-variant-numeric: tabular-nums; }
.hz-owner { margin-left: auto; flex: 0 0 auto; font-size: 11px; letter-spacing: .03em; }
.hz-owner.hz-ai { color: var(--accent); }
.hz-owner.hz-you { color: var(--warn); }
.hz-why { margin-top: 6px; font-size: 12px; line-height: 1.4; color: var(--text-secondary); border-left: 2px solid var(--border-default); padding-left: 8px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.hz-waits { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin-top: 7px; font-size: 11px; color: var(--text-secondary); }
.hz-wchip { border: 1px solid var(--border-default); border-radius: 3px; padding: 1px 6px; color: var(--text-primary); cursor: pointer; font-variant-numeric: tabular-nums; font: inherit; font-size: 11px; background: none; }
.hz-wchip:hover { border-color: var(--accent); }
.hz-wchip.hz-static { cursor: default; }
.hz-wchip.hz-static:hover { border-color: var(--border-default); }
.hz-clear { color: var(--ok); }

.hz-pm { display: inline-flex; align-items: flex-end; gap: 1.5px; height: 10px; flex: 0 0 auto; }
.hz-pm i { width: 2.5px; background: var(--text-hint); border-radius: 1px; display: block; }
.hz-pm i.hz-on { background: var(--text-secondary); }
.hz-pm i:nth-child(1) { height: 4px; } .hz-pm i:nth-child(2) { height: 6px; }
.hz-pm i:nth-child(3) { height: 8px; } .hz-pm i:nth-child(4) { height: 10px; }
.hz-pm.hz-top i.hz-on { background: var(--warn); }
.hz-card.hz-done .hz-ct { color: var(--text-secondary); }

.hz-tag { display: inline-flex; align-items: center; gap: 4px; max-width: 120px; color: var(--gc, var(--text-secondary)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hz-tag .hz-tdot { width: 6px; height: 6px; border-radius: 2px; background: var(--gc); flex: 0 0 auto; }
.hz-age { flex: 0 0 auto; color: var(--text-hint); }
.hz-card .hz-cf .hz-age { margin-left: auto; }
.hz-age.hz-stale { color: var(--warn); }
.hz-lnk { flex: 0 0 auto; color: var(--text-hint); }

.hz-gsec { margin-bottom: 3px; }
.hz-ghead { display: flex; align-items: center; gap: 8px; padding: 7px 4px 5px; cursor: pointer; font-size: var(--font-size-sm); color: var(--text-secondary); background: none; border: none; width: 100%; font-family: inherit; text-align: left; }
.hz-ghead .hz-gdot { width: 8px; height: 8px; border-radius: 2px; background: var(--gc); flex: 0 0 auto; }
.hz-ghead .hz-gn { color: var(--text-primary); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hz-ghead .hz-gc { color: var(--text-hint); }
.hz-ghead .hz-gcaret { font-size: 8px; opacity: .5; transition: transform .15s; display: inline-flex; }
.hz-ghead.hz-open .hz-gcaret { transform: rotate(90deg); }
.hz-grows { padding-left: 4px; }
.hz-daysep { font-size: 11px; color: var(--text-hint); text-transform: uppercase; letter-spacing: .5px; padding: 12px 4px 4px; border-bottom: 1px solid var(--border-subtle); margin-bottom: 3px; }
.hz-rtag { max-width: 112px; font-size: 11px; }
.hz-ord { margin-left: auto; display: flex; align-items: center; gap: 4px; text-transform: none; letter-spacing: 0; font-size: 11px; color: var(--text-hint); }
.hz-ob { font: inherit; font-size: 11px; background: none; cursor: pointer; border: 1px solid var(--border-default); border-radius: 3px; padding: 1px 7px; color: var(--text-secondary); }
.hz-ob:hover { color: var(--text-primary); }
.hz-ob[aria-pressed="true"] { color: var(--text-primary); border-color: var(--accent); }

.hz-row { display: flex; align-items: center; gap: 9px; padding: 4px 8px 4px 10px; border-radius: 3px; cursor: pointer; position: relative; transition: background-color .1s ease, opacity .12s ease; }
.hz-row::before { content: ""; position: absolute; left: 0; top: 3px; bottom: 3px; width: 2px; border-radius: 2px; background: var(--gc, transparent); opacity: .55; }
.hz-row:hover { background: var(--bg-hover); }
.hz-row.hz-sel { background: var(--accent-selection); box-shadow: inset 0 0 0 2px var(--accent); }
.hz-row.hz-sel .hz-rt, .hz-row.hz-sel .hz-rref { color: var(--text-heading); }
.hz-rref { flex: 0 0 auto; min-width: 56px; font-size: var(--font-size-sm); color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.hz-rt { flex: 1; min-width: 0; font-size: var(--font-size); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hz-row.hz-done .hz-rt { color: var(--text-secondary); }
.hz-tick { flex: 0 0 auto; color: var(--ok); font-size: 11px; }

.hz-wires { position: absolute; inset: 0; pointer-events: none; z-index: 5; }
.hz-wires path { fill: none; stroke: var(--accent); stroke-width: 1.4; opacity: .85; }
.hz-wires circle { fill: var(--accent); }

.hz-drawer { flex: 0 0 var(--dw, 340px); min-width: 0; background: var(--bg-panel); overflow-y: auto; padding: 14px 16px 26px; }
.hz-drawer::-webkit-scrollbar { width: 9px; }
.hz-drawer::-webkit-scrollbar-thumb { background: var(--border-default); border-radius: 5px; }
.hz-dr-top { display: flex; align-items: flex-start; gap: 8px; }
.hz-dr-ref { font-size: var(--font-size-sm); color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.hz-dr-back { background: none; border: 1px solid var(--border-default); border-radius: 3px; color: var(--text-secondary); font: inherit; font-size: 11px; padding: 1px 7px; cursor: pointer; font-variant-numeric: tabular-nums; }
.hz-dr-back:hover { border-color: var(--accent); color: var(--text-primary); }
.hz-dr-x { margin-left: auto; background: none; border: none; color: var(--text-secondary); font-size: 15px; cursor: pointer; line-height: 1; }
.hz-dr-x:hover { color: var(--text-primary); }
.hz-dr-title { font-size: 16px; font-weight: 600; color: var(--text-heading); line-height: 1.3; margin: 3px 0 10px; }
.hz-pills { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 6px; }
.hz-pill { font-size: 11px; padding: 2px 7px; border-radius: 3px; border: 1px solid var(--border-default); color: var(--text-secondary); }
.hz-pill.hz-st { border-color: currentColor; }
.hz-dr-h { font-size: 11px; text-transform: uppercase; letter-spacing: .6px; color: var(--text-hint); margin: 14px 0 4px; }
.hz-dr-p { font-size: 13px; line-height: 1.5; color: var(--text-primary); margin: 0; }
.hz-rel { display: flex; flex-wrap: wrap; gap: 5px; }
.hz-chip { font-size: 11px; padding: 2px 7px; border-radius: 3px; cursor: pointer; background: var(--bg-elevated); border: 1px solid var(--border-default); color: var(--text-primary); font-family: inherit; }
.hz-chip:hover { border-color: var(--accent); }
.hz-chip .hz-cs { color: var(--text-hint); margin-left: 4px; }
.hz-touch { font-size: 11px; color: var(--text-hint); margin: 8px 0 0; }
.hz-hood { display: flex; flex-direction: column; gap: 9px; margin-top: 4px; }
.hz-side { min-width: 0; }
.hz-sidelab { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-hint); text-transform: uppercase; letter-spacing: .5px; margin-bottom: 4px; }
.hz-siden { color: var(--text-secondary); letter-spacing: 0; }
.hz-none { font-size: 11px; color: var(--text-hint); }
.hz-seq { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; }
.hz-seq .hz-step { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--border-default); border-radius: 11px; padding: 2px 9px; font-size: 11px; color: var(--text-primary); cursor: pointer; white-space: nowrap; font-variant-numeric: tabular-nums; background: none; font-family: inherit; }
.hz-seq .hz-step:hover { border-color: var(--accent); }
.hz-seq .hz-step.hz-from { border-color: var(--accent); border-style: dashed; }
.hz-seq .hz-step.hz-from::before { content: "\\2039 "; color: var(--accent); }
.hz-seq .hz-step .hz-sl { color: var(--text-hint); }
.hz-offview { margin: 10px 0 0; padding: 7px 9px; border-radius: 4px; font-size: 12px; line-height: 1.45; background: var(--bg-elevated); border: 1px solid var(--border-default); color: var(--text-secondary); }

.hz-row:focus-visible, .hz-card:focus-visible, .hz-tab:focus-visible, .hz-ghead:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
@media (prefers-reduced-motion: reduce) { .hz-root * { animation: none !important; transition: none !important; } }
`;
