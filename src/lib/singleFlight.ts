/**
 * Wrap an async fn so calls never stack but are never lost either: a call
 * arriving while one is in flight marks it pending, and the fn reruns once
 * after the current run finishes. This replaces the bare `inFlight`
 * early-return pattern, which silently dropped the trailing refresh of a
 * write burst — leaving stale git stats on screen until the next poll
 * happened to fire.
 */
export function singleFlight(fn: () => Promise<void>): () => Promise<void> {
  let running = false;
  let pending = false;
  const run = async (): Promise<void> => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      await fn();
    } finally {
      running = false;
      if (pending) {
        pending = false;
        void run();
      }
    }
  };
  return run;
}
