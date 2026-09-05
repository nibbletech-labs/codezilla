import assert from "node:assert/strict";
import test from "node:test";
import { usageActivity } from "../src/lib/usageActivity.ts";
import type { Thread } from "../src/store/types.ts";
import { createInitialTranscriptInfo } from "../src/store/transcriptTypes.ts";

const now = 1_000_000;
const thread = (id: string, type: "claude" | "codex", lastActivityAt: number): Thread => ({
  id, type, lastActivityAt, state: "running", sessionId: id, projectId: "p", name: id,
  claudeSessionId: null, codexThreadId: null, exitCode: null, resuming: false, extraArgs: null,
});

test("counts providers separately, includes exactly five minutes, excludes closed terminals", () => {
  const result = usageActivity([
    thread("a", "claude", now - 300_000), thread("b", "claude", now - 300_001),
    thread("c", "codex", now), { ...thread("d", "codex", now), state: "dormant" },
    { ...thread("e", "claude", now), state: "exited" },
  ], {}, new Map(), now);
  assert.deepEqual(result, { claude: [700], codex: [1000] });
});

test("quiet working sessions count and their activity expires after they stop", () => {
  const t = thread("a", "claude", 1);
  const working = { ...createInitialTranscriptInfo(), hookAuthoritative: true, activityState: "working" as const };
  const recent = new Map<string, number>();
  assert.deepEqual(usageActivity([t], { a: working }, recent, now).claude, [1000]);
  const idle = { ...working, activityState: "idle" as const };
  assert.deepEqual(usageActivity([t], { a: idle }, recent, now + 300_000).claude, [1000]);
  assert.deepEqual(usageActivity([t], { a: idle }, recent, now + 300_001).claude, []);
  usageActivity([], {}, recent, now);
  assert.equal(recent.size, 0);
});
