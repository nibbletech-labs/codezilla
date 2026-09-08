/**
 * The liveness mechanism behind the workbench (spec §10): when to re-read the
 * graph, and which responses are allowed to paint.
 *
 * Everything here is pure — the clock and every I/O port are injected — so the
 * debounce, the ceiling and the request tagging are all assertable under plain
 * node with no timers, no Tauri and no store (tests/haven-live.test.ts).
 *
 * Rust's watcher only coalesces the several filesystem events of a single
 * SQLite write; the schedule below is the one the spec pins.
 */

/** Workbench on screen: refresh after 500 ms of quiet, never later than 2 s. */
export const VISIBLE_TIMING: Timing = { quietMs: 500, ceilingMs: 2000 };
/**
 * Workbench hidden: only the sidebar count depends on this, and §10.5 relaxes
 * the ceiling to 5 s. The quiet period relaxes with it, so a lone background
 * write costs one read ~2 s later rather than one every half second.
 */
export const HIDDEN_TIMING: Timing = { quietMs: 2000, ceilingMs: 5000 };

export interface Timing {
  quietMs: number;
  ceilingMs: number;
}

/** Just enough of the platform to be replaceable by a fake in tests. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Trailing debounce with a ceiling (§10.2). A pure quiet-period debounce would
 * postpone the refresh indefinitely while an orchestrator writes continuously;
 * the ceiling bounds staleness regardless.
 *
 * A ceiling fire deliberately leaves the quiet timer armed, so the burst still
 * gets one final read once it really stops — that is what makes "the board is
 * correct 2 s after the last write" true even when the ceiling read raced the
 * last write. A quiet fire cancels everything.
 */
export class RefreshScheduler {
  private quietHandle: unknown = null;
  private ceilingHandle: unknown = null;
  /** When the current burst began, or null when there is no burst. */
  private burstStart: number | null = null;
  private lastChange = 0;
  private disposed = false;
  private readonly onFire: () => void;
  private readonly clock: Clock;
  private timing: Timing;

  // Written out rather than declared as constructor parameter properties:
  // node's --experimental-strip-types cannot erase those, and these modules
  // are run directly by the node test runner.
  constructor(onFire: () => void, clock: Clock, timing: Timing) {
    this.onFire = onFire;
    this.clock = clock;
    this.timing = timing;
  }

  notifyChange(): void {
    if (this.disposed) return;
    const now = this.clock.now();
    this.lastChange = now;
    if (this.burstStart === null) {
      this.burstStart = now;
      this.armCeiling();
    }
    this.armQuiet();
  }

  /** Swap timings when the project becomes visible or hidden. */
  setTiming(timing: Timing): void {
    if (this.timing === timing || this.disposed) return;
    this.timing = timing;
    // Re-arm both deadlines against the burst that is already running, so
    // becoming visible mid-burst pulls the ceiling in rather than pushing it out.
    if (this.burstStart !== null) this.armCeiling();
    if (this.quietHandle !== null) this.armQuiet();
  }

  /** Refresh now: the ↻ button, and refresh-on-show. */
  flush(): void {
    if (this.disposed) return;
    this.fire();
  }

  dispose(): void {
    this.disposed = true;
    this.clearQuiet();
    this.clearCeiling();
    this.burstStart = null;
  }

  private armQuiet(): void {
    this.clearQuiet();
    const due = this.lastChange + this.timing.quietMs - this.clock.now();
    this.quietHandle = this.clock.setTimeout(() => {
      this.quietHandle = null;
      this.fire();
    }, Math.max(0, due));
  }

  private armCeiling(): void {
    this.clearCeiling();
    const due = (this.burstStart ?? this.clock.now()) + this.timing.ceilingMs - this.clock.now();
    this.ceilingHandle = this.clock.setTimeout(() => {
      this.ceilingHandle = null;
      // Keep the quiet timer: the burst may still be running.
      this.burstStart = null;
      this.onFire();
    }, Math.max(0, due));
  }

  private clearQuiet(): void {
    if (this.quietHandle !== null) {
      this.clock.clearTimeout(this.quietHandle);
      this.quietHandle = null;
    }
  }

  private clearCeiling(): void {
    if (this.ceilingHandle !== null) {
      this.clock.clearTimeout(this.ceilingHandle);
      this.ceilingHandle = null;
    }
  }

  private fire(): void {
    this.clearQuiet();
    this.clearCeiling();
    this.burstStart = null;
    this.onFire();
  }
}

export type GraphReadResult<G> = { graph: G } | { error: string };

interface CoordinatorPorts<G> {
  read(key: string): Promise<G>;
  onResult(key: string, result: GraphReadResult<G>): void;
  onReading?(key: string, reading: boolean): void;
}

interface KeyState {
  /** The newest request issued for this key. */
  latest: number;
  /** The token of the read currently running, or null when idle. */
  inFlight: number | null;
}

/**
 * One in-flight read per project, tagged (§10.3). A response whose token has
 * been superseded — or whose project has been unlinked — is discarded, never
 * applied late over fresher data. Nothing here knows about React or the store.
 */
export class GraphReadCoordinator<G> {
  private readonly keys = new Map<string, KeyState>();
  private readonly ports: CoordinatorPorts<G>;

  constructor(ports: CoordinatorPorts<G>) {
    this.ports = ports;
  }

  request(key: string): void {
    const state = this.keys.get(key) ?? { latest: 0, inFlight: null };
    state.latest += 1;
    this.keys.set(key, state);
    // One read at a time per key: a second request while one is running is
    // issued when that one settles, so a burst costs at most one wasted read.
    if (state.inFlight === null) this.issue(key, state);
  }

  /** The project is no longer linked: forget it and discard anything in flight. */
  drop(key: string): void {
    this.keys.delete(key);
  }

  private issue(key: string, state: KeyState): void {
    const token = state.latest;
    state.inFlight = token;
    this.ports.onReading?.(key, true);
    this.ports
      .read(key)
      .then((graph) => this.settle(key, token, { graph }))
      .catch((e) => this.settle(key, token, { error: errorText(e) }));
  }

  private settle(key: string, token: number, result: GraphReadResult<G>): void {
    const state = this.keys.get(key);
    if (!state || state.inFlight !== token) return; // unlinked, or already replaced
    state.inFlight = null;
    if (token === state.latest) {
      this.ports.onReading?.(key, false);
      this.ports.onResult(key, result);
      return;
    }
    // Superseded while it ran: throw it away and read again for the newer request.
    this.issue(key, state);
  }
}

function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}

export interface LivePorts<G> {
  /** Subscribe to the backend's store-change signal; resolves to an unsubscribe. */
  listen(onStoreChanged: () => void): Promise<() => void>;
  statusDbPath(): Promise<string>;
  watchStore(dbPath: string): Promise<void>;
  read(key: string): Promise<G>;
  onResult(key: string, result: GraphReadResult<G>): void;
  onReading(key: string, reading: boolean): void;
}

/**
 * Owns one scheduler per linked Haven project and the single read coordinator.
 *
 * `start()` sequences listen → watch → read: §10.1 requires the watcher to be
 * registered before the initial read, or a write landing in between is lost.
 */
export class HavenLiveController<G> {
  private readonly coordinator: GraphReadCoordinator<G>;
  private readonly schedulers = new Map<string, RefreshScheduler>();
  private unlisten: (() => void) | null = null;
  private started = false;
  private disposed = false;
  private visibleKey: string | null = null;
  private readonly ports: LivePorts<G>;
  private readonly clock: Clock;

  constructor(ports: LivePorts<G>, clock: Clock = realClock) {
    this.ports = ports;
    this.clock = clock;
    this.coordinator = new GraphReadCoordinator<G>({
      read: (key) => this.ports.read(key),
      onResult: (key, result) => this.ports.onResult(key, result),
      onReading: (key, reading) => this.ports.onReading(key, reading),
    });
  }

  async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.unlisten = await this.ports.listen(() => this.onStoreChanged());
    if (this.disposed) {
      this.unlisten();
      this.unlisten = null;
      return;
    }
    // Best-effort: with no watcher the view simply degrades to refresh-on-show
    // (§10 degradation), so a failure here must not cost us the initial read.
    try {
      const dbPath = await this.ports.statusDbPath();
      await this.ports.watchStore(dbPath);
    } catch (e) {
      console.warn("haven: store watcher unavailable, falling back to refresh on show", e);
    }
    if (this.disposed) return;
    this.started = true;
    for (const key of this.schedulers.keys()) this.coordinator.request(key);
  }

  /** The unique Haven keys the open projects are bound to. */
  setLinkedKeys(keys: string[]): void {
    if (this.disposed) return;
    const wanted = new Set(keys);
    for (const [key, scheduler] of this.schedulers) {
      if (wanted.has(key)) continue;
      scheduler.dispose();
      this.schedulers.delete(key);
      this.coordinator.drop(key);
    }
    for (const key of wanted) {
      if (this.schedulers.has(key)) continue;
      this.schedulers.set(
        key,
        new RefreshScheduler(
          () => this.coordinator.request(key),
          this.clock,
          this.timingFor(key),
        ),
      );
      if (this.started) this.coordinator.request(key);
    }
  }

  /**
   * Which project is on screen: it gets the tight timing and everything else
   * the relaxed one. Newly shown means an immediate refresh (§10.6).
   */
  setVisibleKey(key: string | null): void {
    if (this.disposed || key === this.visibleKey) return;
    this.visibleKey = key;
    for (const [k, scheduler] of this.schedulers) scheduler.setTiming(this.timingFor(k));
    if (key !== null) this.schedulers.get(key)?.flush();
  }

  /** The ↻ button. */
  refresh(key: string): void {
    if (this.disposed) return;
    const scheduler = this.schedulers.get(key);
    if (scheduler) scheduler.flush();
    else this.coordinator.request(key);
  }

  dispose(): void {
    this.disposed = true;
    this.started = false;
    for (const [key, scheduler] of this.schedulers) {
      scheduler.dispose();
      this.coordinator.drop(key);
    }
    this.schedulers.clear();
    this.unlisten?.();
    this.unlisten = null;
  }

  private timingFor(key: string): Timing {
    return key === this.visibleKey ? VISIBLE_TIMING : HIDDEN_TIMING;
  }

  private onStoreChanged(): void {
    if (this.disposed) return;
    for (const scheduler of this.schedulers.values()) scheduler.notifyChange();
  }
}
