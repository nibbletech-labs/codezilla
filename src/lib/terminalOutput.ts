import type { ITerminalAddon, Terminal } from "@xterm/xterm";

const MAX_WRITE_BYTES = 256 * 1024;

/**
 * Feed every PTY byte to xterm, including while its element is hidden. Only one
 * bounded write is in flight so xterm can yield between bursts. Scheduling must
 * not depend on animation frames, which can stop when the window is hidden.
 * Scrollback is bounded by xterm; discarding raw bytes would corrupt its state.
 */
export function createTerminalOutputAddon(options: {
  onWrite: () => void;
  onError: (error: unknown) => void;
}): ITerminalAddon & {
  write: (data: Uint8Array) => void;
  getPendingText: () => string;
} {
  let terminal: Terminal | undefined;
  const decoder = new TextDecoder();
  const queue: Uint8Array[] = [];
  let inFlight: Uint8Array | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const dispose = () => {
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    queue.length = 0;
    inFlight = undefined;
    terminal = undefined;
  };

  const schedule = () => {
    if (disposed || !terminal || timer !== undefined || inFlight || queue.length === 0) return;
    timer = setTimeout(flush, 0);
  };

  const flush = () => {
    timer = undefined;
    if (disposed || !terminal || inFlight || queue.length === 0) return;

    let bytes = 0;
    let count = 0;
    for (const chunk of queue) {
      if (bytes + chunk.length > MAX_WRITE_BYTES) break;
      bytes += chunk.length;
      count++;
    }
    const chunks = queue.splice(0, count);
    const merged = chunks.length === 1 ? chunks[0] : new Uint8Array(bytes);
    if (chunks.length > 1) {
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
    }

    inFlight = merged;
    try {
      // Keep partial UTF-8 characters between batches. xterm 5.5's byte
      // decoder can lose characters whose split continuation byte is 0x80.
      terminal.write(decoder.decode(merged, { stream: true }), () => {
        if (disposed) return;
        inFlight = undefined;
        try {
          options.onWrite();
        } finally {
          schedule();
        }
      });
    } catch (error) {
      // An unrecoverable parser/write failure must be reported, not followed by
      // more output against partially updated terminal state.
      dispose();
      options.onError(error);
    }
  };

  return {
    activate(value) {
      terminal = value;
      schedule();
    },
    dispose,
    write(data) {
      if (disposed) return;
      for (let offset = 0; offset < data.length; offset += MAX_WRITE_BYTES) {
        queue.push(data.subarray(offset, offset + MAX_WRITE_BYTES));
      }
      schedule();
    },
    getPendingText() {
      // Activity events can arrive before xterm has parsed the latest write.
      // Include the in-flight bytes, and decode once to preserve split UTF-8.
      const tail: Uint8Array[] = [];
      let remaining = 4096;
      for (let i = queue.length - 1; i >= -1 && remaining > 0; i--) {
        const chunk = i === -1 ? inFlight : queue[i];
        if (!chunk) continue;
        const slice = chunk.subarray(Math.max(0, chunk.length - remaining));
        tail.unshift(slice);
        remaining -= slice.length;
      }
      const merged = new Uint8Array(4096 - remaining);
      let offset = 0;
      for (const chunk of tail) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      return new TextDecoder().decode(merged);
    },
  };
}
