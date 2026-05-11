import assert from "node:assert/strict";
import test from "node:test";
import { deriveCoreRuntimeStatus } from "../src/lib/threadActivityCore.ts";
import { getThreadSubtitle, isThreadLikelyWorking } from "../src/lib/threadRuntime.ts";
import { createInitialTranscriptInfo } from "../src/store/transcriptTypes.ts";
import type { Thread } from "../src/store/types.ts";

// NOTE: the legacy transcript-parser / state-machine test suite was removed
// when the legacy detection stack was retired. Activity detection now flows
// through Claude / Codex hooks at runtime; reducer logic lives in
// `applyHookEvent` inside `Terminal.tsx`. Future unit tests should target
// that reducer + the question-pattern scan with fixture buffers (see the
// "Reducer + scan unit tests" item in
// docs/specs/hook-based-activity-detection-followups.md).

function makeThread(overrides: Partial<Thread>): Thread {
  return {
    id: "thread-1",
    projectId: "project-1",
    type: "claude",
    name: "Claude #1",
    sessionId: "session-1",
    claudeSessionId: null,
    codexThreadId: null,
    state: "running",
    exitCode: null,
    resuming: false,
    ...overrides,
  };
}

test("deriveCoreRuntimeStatus is PTY-owned", () => {
  assert.equal(deriveCoreRuntimeStatus("idle", true), "working");
  assert.equal(deriveCoreRuntimeStatus("working", false), "idle");
  assert.equal(deriveCoreRuntimeStatus("exited", true), "exited");
});

test("getThreadSubtitle: hook-less fallback is PTY-only", () => {
  const thread = makeThread({});
  // Hook-less PTY active → Working
  assert.deepEqual(
    getThreadSubtitle(thread, { ...createInitialTranscriptInfo(), ptyActive: true }),
    { body: "Working", progress: null },
  );
  // Hook-less PTY quiet → Idle
  assert.deepEqual(
    getThreadSubtitle(thread, createInitialTranscriptInfo()),
    { body: "Idle", progress: null },
  );
});

test("getThreadSubtitle: lifecycle states for non-running threads", () => {
  const exitedCleanly = makeThread({ state: "exited", exitCode: 0 });
  assert.deepEqual(
    getThreadSubtitle(exitedCleanly, createInitialTranscriptInfo()),
    { body: "Session ended", progress: null },
  );

  const crashed = makeThread({ state: "exited", exitCode: 1 });
  assert.deepEqual(
    getThreadSubtitle(crashed, createInitialTranscriptInfo()),
    { body: "Session crashed", progress: null },
  );

  const dormant = makeThread({ state: "dormant" });
  assert.deepEqual(
    getThreadSubtitle(dormant, createInitialTranscriptInfo()),
    { body: "Saved session", progress: null },
  );
});

test("getThreadSubtitle: shell threads are PTY-only", () => {
  const shellRunning = makeThread({ type: "shell", state: "running" });
  assert.deepEqual(
    getThreadSubtitle(shellRunning, null),
    { body: "Idle", progress: null },
  );
  assert.deepEqual(
    getThreadSubtitle(shellRunning, { ...createInitialTranscriptInfo(), ptyActive: true }),
    { body: "Working", progress: null },
  );
});

test("getThreadSubtitle: hook-authoritative working with tool detail", () => {
  const thread = makeThread({});
  const info = {
    ...createInitialTranscriptInfo(),
    hookAuthoritative: true,
    activityState: "working" as const,
    lastToolName: "Read",
    lastToolTarget: "/some/path/package.json",
  };
  assert.deepEqual(
    getThreadSubtitle(thread, info),
    { body: "Reading package.json", progress: null },
  );
});

test("getThreadSubtitle: hook-authoritative awaiting_input", () => {
  const thread = makeThread({});
  const info = {
    ...createInitialTranscriptInfo(),
    hookAuthoritative: true,
    activityState: "awaiting_input" as const,
  };
  assert.deepEqual(
    getThreadSubtitle(thread, info),
    { body: "Awaiting input", progress: null },
  );
});

test("getThreadSubtitle: hook-authoritative idle", () => {
  const thread = makeThread({});
  const info = {
    ...createInitialTranscriptInfo(),
    hookAuthoritative: true,
    activityState: "idle" as const,
  };
  assert.deepEqual(
    getThreadSubtitle(thread, info),
    { body: "Idle", progress: null },
  );
});

test("getThreadSubtitle: plan-mode prefix and plan-progress suffix", () => {
  const thread = makeThread({});
  // Plan mode + working + progress: body carries the prefix, progress is separate
  // so the sidebar can ellipsify the body without clipping (N/M).
  const planning = {
    ...createInitialTranscriptInfo(),
    hookAuthoritative: true,
    activityState: "working" as const,
    inPlanMode: true,
    planProgress: { total: 5, done: 1 },
  };
  // display index = min(done+1, total) = min(2,5) = 2
  assert.deepEqual(
    getThreadSubtitle(thread, planning),
    { body: "Plan mode · Working", progress: "(2/5)" },
  );

  // Plan-progress only (no plan-mode prefix)
  const progressOnly = {
    ...createInitialTranscriptInfo(),
    hookAuthoritative: true,
    activityState: "working" as const,
    planProgress: { total: 3, done: 3 },
  };
  // display = min(4,3) = 3
  assert.deepEqual(
    getThreadSubtitle(thread, progressOnly),
    { body: "Working", progress: "(3/3)" },
  );

  // Plan-progress with a per-tool body — the tool detail is the part that
  // would ellipsify in the sidebar; (N/M) lives in `progress` and stays visible.
  const planningWithTool = {
    ...createInitialTranscriptInfo(),
    hookAuthoritative: true,
    activityState: "working" as const,
    lastToolName: "Bash",
    lastToolTarget: "echo really-long-string-to-force-truncation",
    planProgress: { total: 3, done: 0 },
  };
  const result = getThreadSubtitle(thread, planningWithTool);
  assert.equal(result.progress, "(1/3)");
  assert.ok(result.body.length > 0 && !result.body.includes("(1/3)"));
});

test("isThreadLikelyWorking: hook-authoritative wins over PTY", () => {
  const thread = makeThread({});
  // Hook says idle, PTY says active → idle (hook is authoritative)
  const hookIdleButPtyActive = {
    ...createInitialTranscriptInfo(),
    hookAuthoritative: true,
    activityState: "idle" as const,
    ptyActive: true,
  };
  assert.equal(isThreadLikelyWorking(thread, hookIdleButPtyActive), false);

  // Hook says working, PTY says quiet → working
  const hookWorkingButPtyQuiet = {
    ...createInitialTranscriptInfo(),
    hookAuthoritative: true,
    activityState: "working" as const,
    ptyActive: false,
  };
  assert.equal(isThreadLikelyWorking(thread, hookWorkingButPtyQuiet), true);
});

test("isThreadLikelyWorking: hook-less falls back to PTY", () => {
  const thread = makeThread({});
  assert.equal(
    isThreadLikelyWorking(thread, { ...createInitialTranscriptInfo(), ptyActive: true }),
    true,
  );
  assert.equal(
    isThreadLikelyWorking(thread, { ...createInitialTranscriptInfo(), ptyActive: false }),
    false,
  );
});

test("isThreadLikelyWorking: non-running threads are not working", () => {
  const exited = makeThread({ state: "exited", exitCode: 0 });
  assert.equal(isThreadLikelyWorking(exited, { ...createInitialTranscriptInfo(), ptyActive: true }), false);
});
