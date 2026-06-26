const suppressUntilMap = new Map<string, number>();

export function recordOutput(_threadId: string, _timestamp = Date.now()): void {
  // Output timestamps are no longer tracked on the frontend.
  // PTY-owned activity signals (via the watchdog) are the single source of truth.
}

export function suppressOutputActivity(threadId: string, durationMs: number): void {
  const until = Date.now() + Math.max(0, durationMs);
  const prev = suppressUntilMap.get(threadId) ?? 0;
  suppressUntilMap.set(threadId, Math.max(prev, until));
}

export function isOutputActivitySuppressed(threadId: string, timestamp = Date.now()): boolean {
  const suppressUntil = suppressUntilMap.get(threadId) ?? 0;
  return timestamp <= suppressUntil;
}

export function clearActivity(threadId: string): void {
  suppressUntilMap.delete(threadId);
  interruptedThreads.delete(threadId);
}

// Interrupt suppression. A Ctrl+C interrupt is a Codezilla-local signal: it
// travels from xterm through the PTY and never reaches Heed's daemon as a hook
// event. So when the user interrupts a running turn, Heed can leave the thread
// frozen at activityState="working" (no turn-end hook fires on an interrupt),
// and the spinner never stops. We arm a per-thread marker here on the Ctrl+C so
// the Heed mapper coerces that stale "working" to idle. The marker is armed only
// when the thread was genuinely working, and disarmed by the next submitted
// prompt (the user starting a fresh turn) or thread teardown — both local
// signals — so it can never mute a legitimately-new turn.
const interruptedThreads = new Set<string>();

export function recordInterrupt(threadId: string): void {
  interruptedThreads.add(threadId);
}

export function isInterrupted(threadId: string): boolean {
  return interruptedThreads.has(threadId);
}

export function clearInterrupt(threadId: string): void {
  interruptedThreads.delete(threadId);
}
