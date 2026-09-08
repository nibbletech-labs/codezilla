import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GraphReadCoordinator,
  HavenLiveController,
  HIDDEN_TIMING,
  RefreshScheduler,
  VISIBLE_TIMING,
  type Clock,
} from "../src/lib/havenLive.ts";

/** A clock whose timers only run when the test advances it. */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: Clock = {
    now: () => now,
    setTimeout(fn: () => void, ms: number) {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(handle: unknown) {
      timers.delete(handle as number);
    },
  };
  return {
    clock,
    nowMs: () => now,
    pending: () => timers.size,
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        let nextId: number | null = null;
        let nextAt = Infinity;
        for (const [id, t] of timers) {
          if (t.at <= target && (t.at < nextAt || (t.at === nextAt && id < (nextId ?? Infinity)))) {
            nextId = id;
            nextAt = t.at;
          }
        }
        if (nextId === null) break;
        const t = timers.get(nextId)!;
        timers.delete(nextId);
        now = t.at;
        t.fn();
      }
      now = target;
    },
  };
}

/** Let every already-resolved promise callback run. */
const flush = () => new Promise<void>((r) => setImmediate(r));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------- scheduler

test("one change fires after 500 ms of quiet", () => {
  const c = fakeClock();
  const fires: number[] = [];
  const s = new RefreshScheduler(() => fires.push(c.nowMs()), c.clock, VISIBLE_TIMING);
  s.notifyChange();
  c.advance(499);
  assert.deepEqual(fires, []);
  c.advance(1);
  assert.deepEqual(fires, [500]);
  // Nothing else is left armed — the ceiling was cancelled by the fire.
  c.advance(5000);
  assert.deepEqual(fires, [500]);
  assert.equal(c.pending(), 0);
  s.dispose();
});

test("changes at 0/400/800 fire once at 1300", () => {
  const c = fakeClock();
  const fires: number[] = [];
  const s = new RefreshScheduler(() => fires.push(c.nowMs()), c.clock, VISIBLE_TIMING);
  s.notifyChange();
  c.advance(400);
  s.notifyChange();
  c.advance(400);
  s.notifyChange();
  c.advance(2000);
  assert.deepEqual(fires, [1300]);
  s.dispose();
});

test("20 changes at 100 ms intervals over 2 s fire at most twice", () => {
  const c = fakeClock();
  const fires: number[] = [];
  const s = new RefreshScheduler(() => fires.push(c.nowMs()), c.clock, VISIBLE_TIMING);
  s.notifyChange(); // t = 0
  for (let n = 1; n < 20; n++) {
    c.advance(100);
    s.notifyChange(); // t = 100 .. 1900
  }
  c.advance(3000);
  // The ceiling bounds staleness at 2 s; the trailing quiet period then lands
  // one final read 500 ms after the last write.
  assert.deepEqual(fires, [2000, 2400]);
  assert.ok(fires.length <= 2);
  assert.ok(fires.every((t) => t >= 2000));
  s.dispose();
});

test("the ceiling runs from the first change of a burst, and a fire starts a new one", () => {
  const c = fakeClock();
  const fires: number[] = [];
  const s = new RefreshScheduler(() => fires.push(c.nowMs()), c.clock, VISIBLE_TIMING);
  // A burst kept alive past the ceiling: quiet never expires before 2000.
  s.notifyChange();
  for (let n = 0; n < 5; n++) {
    c.advance(400);
    s.notifyChange();
  }
  c.advance(100); // t = 2100
  assert.deepEqual(fires, [2000]);
  // The trailing quiet from the last change (t = 2000) still lands.
  c.advance(1000);
  assert.deepEqual(fires, [2000, 2500]);
  // A new change starts a fresh burst, so its ceiling is 2 s from *it*.
  c.advance(1000); // t = 4100
  s.notifyChange();
  for (let n = 0; n < 6; n++) {
    c.advance(400);
    s.notifyChange();
  }
  c.advance(50);
  assert.deepEqual(fires, [2000, 2500, 6100]);
  s.dispose();
});

test("hidden timing relaxes the quiet period and the ceiling", () => {
  const c = fakeClock();
  const fires: number[] = [];
  const s = new RefreshScheduler(() => fires.push(c.nowMs()), c.clock, HIDDEN_TIMING);
  s.notifyChange();
  c.advance(1999);
  assert.deepEqual(fires, []);
  c.advance(1);
  assert.deepEqual(fires, [2000]);
  s.dispose();

  // A continuous burst is bounded by the 5 s hidden ceiling.
  const c2 = fakeClock();
  const fires2: number[] = [];
  const s2 = new RefreshScheduler(() => fires2.push(c2.nowMs()), c2.clock, HIDDEN_TIMING);
  s2.notifyChange();
  for (let n = 0; n < 10; n++) {
    c2.advance(600);
    s2.notifyChange();
  }
  assert.deepEqual(fires2, [5000]);
  s2.dispose();
});

test("becoming visible mid-burst re-arms the ceiling from the burst start", () => {
  const c = fakeClock();
  const fires: number[] = [];
  const s = new RefreshScheduler(() => fires.push(c.nowMs()), c.clock, HIDDEN_TIMING);
  s.notifyChange(); // burst starts at 0, hidden ceiling 5000
  c.advance(500);
  s.notifyChange();
  c.advance(500);
  s.notifyChange(); // t = 1000
  c.advance(500); // t = 1500, burst 1.5 s old
  s.setTiming(VISIBLE_TIMING);
  // The visible ceiling is 2 s from the burst start, i.e. t = 2000 — not 3.5 s.
  // The quiet period from the last change (t = 1000) is already past, so the
  // re-armed quiet timer fires immediately at t = 1500.
  c.advance(1);
  assert.deepEqual(fires, [1500]);
  s.dispose();
});

test("setTiming compares timings by field, not by identity", () => {
  const c = fakeClock();
  const fires: number[] = [];
  const s = new RefreshScheduler(() => fires.push(c.nowMs()), c.clock, HIDDEN_TIMING);
  s.notifyChange();
  c.advance(100);
  // A structurally equal copy is still the visible timing: the quiet period has
  // to drop from 2 s to 500 ms even though the object is a different one.
  s.setTiming({ ...VISIBLE_TIMING });
  c.advance(400);
  assert.deepEqual(fires, [500]);
  s.dispose();

  // And a copy of the timing already in force is a no-op, not a re-arm.
  const c2 = fakeClock();
  const fires2: number[] = [];
  const s2 = new RefreshScheduler(() => fires2.push(c2.nowMs()), c2.clock, VISIBLE_TIMING);
  s2.notifyChange();
  c2.advance(400);
  s2.setTiming({ ...VISIBLE_TIMING });
  c2.advance(100);
  assert.deepEqual(fires2, [500]);
  s2.dispose();
});

test("flush fires immediately and dispose clears everything", () => {
  const c = fakeClock();
  const fires: number[] = [];
  const s = new RefreshScheduler(() => fires.push(c.nowMs()), c.clock, VISIBLE_TIMING);
  s.notifyChange();
  c.advance(100);
  s.flush();
  assert.deepEqual(fires, [100]);
  assert.equal(c.pending(), 0);
  // Flushing with nothing pending still refreshes — this is "refresh on show".
  c.advance(100);
  s.flush();
  assert.deepEqual(fires, [100, 200]);

  s.notifyChange();
  s.dispose();
  assert.equal(c.pending(), 0);
  c.advance(10_000);
  assert.deepEqual(fires, [100, 200]);
  // A change after dispose is inert.
  s.notifyChange();
  c.advance(10_000);
  assert.deepEqual(fires, [100, 200]);
});

// -------------------------------------------------------------- coordinator

test("a superseded response is discarded and the newer read is issued", async () => {
  const reads: Array<ReturnType<typeof deferred<string>>> = [];
  const applied: Array<[string, unknown]> = [];
  const co = new GraphReadCoordinator<string>({
    read: () => {
      const d = deferred<string>();
      reads.push(d);
      return d.promise;
    },
    onResult: (key, r) => applied.push([key, r]),
  });

  co.request("A");
  assert.equal(reads.length, 1);
  co.request("A"); // supersedes; one read in flight at a time
  assert.equal(reads.length, 1);

  reads[0].resolve("stale");
  await flush();
  assert.deepEqual(applied, []); // token no longer current
  assert.equal(reads.length, 2); // the newer request is issued now

  reads[1].resolve("fresh");
  await flush();
  assert.deepEqual(applied, [["A", { graph: "fresh" }]]);
});

test("a response for a project unlinked while in flight is discarded", async () => {
  const reads: Array<ReturnType<typeof deferred<string>>> = [];
  const applied: Array<[string, unknown]> = [];
  const co = new GraphReadCoordinator<string>({
    read: () => {
      const d = deferred<string>();
      reads.push(d);
      return d.promise;
    },
    onResult: (key, r) => applied.push([key, r]),
  });

  co.request("A");
  co.drop("A");
  reads[0].resolve("gone");
  await flush();
  assert.deepEqual(applied, []);
  assert.equal(reads.length, 1);
});

test("a response issued before a drop cannot beat the read issued after it", async () => {
  // Tokens are monotonic across the coordinator, not per key: an unlink and a
  // relink must not reset the counter and let the pre-drop read look current.
  const reads: Array<ReturnType<typeof deferred<string>>> = [];
  const applied: Array<[string, unknown]> = [];
  const reading: Array<[string, boolean]> = [];
  const co = new GraphReadCoordinator<string>({
    read: () => {
      const d = deferred<string>();
      reads.push(d);
      return d.promise;
    },
    onResult: (key, r) => applied.push([key, r]),
    onReading: (key, busy) => reading.push([key, busy]),
  });

  co.request("A");
  co.drop("A");
  co.request("A");
  assert.equal(reads.length, 2);

  reads[0].resolve("stale");
  await flush();
  assert.deepEqual(applied, []);

  reads[1].resolve("fresh");
  await flush();
  assert.deepEqual(applied, [["A", { graph: "fresh" }]]);
  // The spinner ends: the discarded settle must not leave `reading` stuck on.
  assert.deepEqual(reading[reading.length - 1], ["A", false]);
});

test("results for different keys never cross", async () => {
  const reads = new Map<string, ReturnType<typeof deferred<string>>>();
  const applied: Array<[string, unknown]> = [];
  const co = new GraphReadCoordinator<string>({
    read: (key) => {
      const d = deferred<string>();
      reads.set(key, d);
      return d.promise;
    },
    onResult: (key, r) => applied.push([key, r]),
  });

  co.request("A");
  co.request("B");
  reads.get("B")!.resolve("graph-B");
  await flush();
  reads.get("A")!.resolve("graph-A");
  await flush();
  assert.deepEqual(applied, [
    ["B", { graph: "graph-B" }],
    ["A", { graph: "graph-A" }],
  ]);
});

test("errors apply like results, and a later success replaces them", async () => {
  const reads: Array<ReturnType<typeof deferred<string>>> = [];
  const applied: Array<[string, unknown]> = [];
  const reading: Array<[string, boolean]> = [];
  const co = new GraphReadCoordinator<string>({
    read: () => {
      const d = deferred<string>();
      reads.push(d);
      return d.promise;
    },
    onResult: (key, r) => applied.push([key, r]),
    onReading: (key, busy) => reading.push([key, busy]),
  });

  co.request("A");
  reads[0].reject("store_too_new");
  await flush();
  assert.deepEqual(applied, [["A", { error: "store_too_new" }]]);

  co.request("A");
  reads[1].resolve("ok");
  await flush();
  assert.deepEqual(applied[1], ["A", { graph: "ok" }]);
  assert.deepEqual(reading, [
    ["A", true],
    ["A", false],
    ["A", true],
    ["A", false],
  ]);
});

// --------------------------------------------------------------- controller

function controllerHarness() {
  const calls: string[] = [];
  const c = fakeClock();
  let onChange: (() => void) | null = null;
  let unlistened = 0;
  const applied: Array<[string, unknown]> = [];
  const ports = {
    listen: async (cb: () => void) => {
      calls.push("listen");
      onChange = cb;
      return () => {
        unlistened += 1;
      };
    },
    statusDbPath: async () => {
      calls.push("statusDbPath");
      return "/Users/tom/.haven/haven.db";
    },
    watchStore: async (p: string) => {
      calls.push(`watchStore:${p}`);
    },
    read: async (key: string) => {
      calls.push(`read:${key}`);
      return `graph-${key}`;
    },
    onResult: (key: string, r: unknown) => applied.push([key, r]),
    onReading: () => {},
  };
  return {
    calls,
    clock: c,
    applied,
    ports,
    fireChange: () => onChange?.(),
    unlistenCount: () => unlistened,
  };
}

test("start order is listen, then watch, then the initial read", async () => {
  const h = controllerHarness();
  const ctrl = new HavenLiveController(h.ports, h.clock.clock);
  ctrl.setLinkedKeys(["retrostack"]); // before start: recorded, not read
  assert.deepEqual(h.calls, []);
  await ctrl.start();
  await flush();
  assert.deepEqual(h.calls, [
    "listen",
    "statusDbPath",
    "watchStore:/Users/tom/.haven/haven.db",
    "read:retrostack",
  ]);
  ctrl.dispose();
  assert.equal(h.unlistenCount(), 1);
});

test("a failed watch still leaves the initial read, degrading to refresh-on-show", async () => {
  const h = controllerHarness();
  const ports = {
    ...h.ports,
    watchStore: async () => {
      h.calls.push("watchStore");
      throw "no such file";
    },
  };
  const ctrl = new HavenLiveController(ports, h.clock.clock);
  ctrl.setLinkedKeys(["retrostack"]);
  await ctrl.start();
  await flush();
  assert.deepEqual(h.calls, ["listen", "statusDbPath", "watchStore", "read:retrostack"]);
  assert.deepEqual(h.applied, [["retrostack", { graph: "graph-retrostack" }]]);
  ctrl.dispose();
});

test("a store change fans out to every linked key with that key's own timing", async () => {
  const h = controllerHarness();
  const ctrl = new HavenLiveController(h.ports, h.clock.clock);
  ctrl.setLinkedKeys(["retrostack", "codezilla"]);
  await ctrl.start();
  await flush();
  ctrl.setVisibleKey("retrostack");
  await flush();
  h.calls.length = 0;

  h.fireChange();
  h.clock.advance(500);
  await flush();
  // The visible project refreshes on the 500 ms quiet period...
  assert.deepEqual(h.calls, ["read:retrostack"]);
  h.clock.advance(1500);
  await flush();
  // ...and the hidden one on its own 2 s quiet period, inside the 5 s clause.
  assert.deepEqual(h.calls, ["read:retrostack", "read:codezilla"]);
  ctrl.dispose();
});

test("selecting a project refreshes it immediately; linking and unlinking add and drop", async () => {
  const h = controllerHarness();
  const ctrl = new HavenLiveController(h.ports, h.clock.clock);
  ctrl.setLinkedKeys(["retrostack"]);
  await ctrl.start();
  await flush();
  h.calls.length = 0;

  // Refresh on show.
  ctrl.setVisibleKey("retrostack");
  await flush();
  assert.deepEqual(h.calls, ["read:retrostack"]);
  // Re-asserting the same visible key is not another read.
  ctrl.setVisibleKey("retrostack");
  await flush();
  assert.deepEqual(h.calls, ["read:retrostack"]);

  // A newly linked project reads at once.
  h.calls.length = 0;
  ctrl.setLinkedKeys(["retrostack", "heed"]);
  await flush();
  assert.deepEqual(h.calls, ["read:heed"]);

  // Unlinking stops it: a store change no longer refreshes it.
  h.calls.length = 0;
  ctrl.setLinkedKeys(["retrostack"]);
  h.fireChange();
  h.clock.advance(5000);
  await flush();
  assert.deepEqual(h.calls, ["read:retrostack"]);

  // The manual refresh button.
  h.calls.length = 0;
  ctrl.refresh("retrostack");
  await flush();
  assert.deepEqual(h.calls, ["read:retrostack"]);

  // After dispose nothing is scheduled and no change does anything.
  ctrl.dispose();
  h.calls.length = 0;
  h.fireChange();
  h.clock.advance(10_000);
  await flush();
  assert.deepEqual(h.calls, []);
  assert.equal(h.clock.pending(), 0);
});

test("a failed listen still leaves the initial read", async () => {
  // §10 degradation is uniform: losing the change signal costs the live
  // refresh, never the first read.
  const h = controllerHarness();
  const ports = {
    ...h.ports,
    listen: async () => {
      h.calls.push("listen");
      throw "no such event";
    },
  };
  const ctrl = new HavenLiveController(ports, h.clock.clock);
  ctrl.setLinkedKeys(["retrostack"]);
  await ctrl.start();
  await flush();
  assert.deepEqual(h.calls, ["listen", "read:retrostack"]);
  assert.deepEqual(h.applied, [["retrostack", { graph: "graph-retrostack" }]]);
  ctrl.dispose();
});

test("showing a project before start does not read ahead of the watcher", async () => {
  const h = controllerHarness();
  const ctrl = new HavenLiveController(h.ports, h.clock.clock);
  ctrl.setLinkedKeys(["retrostack"]);
  ctrl.setVisibleKey("retrostack");
  await flush();
  assert.deepEqual(h.calls, []); // §10.1: nothing before listen and watch
  await ctrl.start();
  await flush();
  assert.deepEqual(h.calls, [
    "listen",
    "statusDbPath",
    "watchStore:/Users/tom/.haven/haven.db",
    "read:retrostack",
  ]);
  ctrl.dispose();
});
