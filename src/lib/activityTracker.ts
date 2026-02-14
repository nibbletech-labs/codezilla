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
}
