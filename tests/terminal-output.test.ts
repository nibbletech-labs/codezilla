import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type { Terminal as Xterm } from "@xterm/xterm";
import { createTerminalOutputAddon } from "../src/lib/terminalOutput.ts";

// Exercise the actual parser without opening a browser renderer. There is no
// requestAnimationFrame here, just as a hidden window can stop receiving frames.
const { Terminal } = createRequire(import.meta.url)("@xterm/xterm") as {
  Terminal: typeof Xterm;
};
const encode = (text: string) => new TextEncoder().encode(text);
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

function harness() {
  const terminal = new Terminal({ cols: 40, rows: 8, allowProposedApi: true });
  let drained: (() => void) | undefined;
  const output = createTerminalOutputAddon({
    onWrite: () => {
      if (!output.getPendingText()) {
        drained?.();
        drained = undefined;
      }
    },
    onError: (error) => { throw error; },
  });
  terminal.loadAddon(output);
  return {
    terminal,
    output,
    row: (y: number) => terminal.buffer.active.getLine(y)!.translateToString(true),
    drain: () => output.getPendingText()
      ? new Promise<void>((resolve) => { drained = resolve; })
      : Promise.resolve(),
  };
}

test("background output over 8 MB keeps the spinner off the input prompt", { timeout: 10_000 }, async (t) => {
  const h = harness();
  t.after(() => h.terminal.dispose());
  h.output.write(encode("\x1b[5;1H> draft prompt\x1b[5;1H"));
  await h.drain();

  // The old hidden queue evicted this cursor move, then drew the star on row 5.
  h.output.write(encode("\x1b[4;1H"));
  const padding = encode("\x1b[0m".repeat(1024));
  for (let i = 0; i < 2048; i++) h.output.write(padding);
  h.output.write(encode("\x1b[2K✦ Working…"));
  await h.drain();

  assert.equal(h.row(3), "✦ Working…");
  assert.equal(h.row(4), "> draft prompt");
});

test("escape sequences and UTF-8 survive splits between parsed writes", { timeout: 10_000 }, async (t) => {
  const h = harness();
  t.after(() => h.terminal.dispose());
  for (const byte of encode("\x1b[4;1H\x1b[32m✦ Working…\x1b[0m")) {
    h.output.write(new Uint8Array([byte]));
    await h.drain();
  }
  assert.equal(h.row(3), "✦ Working…");
  assert.equal(h.terminal.buffer.active.getLine(3)!.getCell(0)!.getFgColor(), 2);
});

test("hidden terminals answer cursor queries and keep exit output in order", { timeout: 10_000 }, async (t) => {
  const h = harness();
  t.after(() => h.terminal.dispose());
  const replies: string[] = [];
  h.terminal.onData((data) => replies.push(data));
  h.output.write(encode("\x1b[4;1H\x1b[6n"));
  await h.drain();
  assert.deepEqual(replies, ["\x1b[4;1R"]);

  h.output.write(encode("\x1b[0m".repeat(100_000) + "final output"));
  h.output.write(encode("\r\n[Process exited with code 0]"));
  await h.drain();
  assert.equal(h.row(3), "final output");
  assert.equal(h.row(4), "[Process exited with code 0]");
});

test("bursts have one bounded write in flight and preserve newly arriving output", async () => {
  const writes: string[] = [];
  const callbacks: (() => void)[] = [];
  const output = createTerminalOutputAddon({ onWrite() {}, onError: assert.fail });
  output.activate({
    write(data: string, callback: () => void) {
      writes.push(data);
      callbacks.push(callback);
    },
  } as unknown as Xterm);
  try {
    const burst = encode("x".repeat(600_000));
    output.write(burst);
    await tick();
    assert.equal(writes.length, 1);
    assert.ok(writes[0].length <= 256 * 1024);
    output.write(encode("tail"));
    await tick();
    assert.equal(writes.length, 1, "new arrivals must wait for parsing to finish");

    while (callbacks.length) {
      callbacks.shift()!();
      await tick();
    }
    assert.ok(writes.every((data) => data.length <= 256 * 1024));
    assert.equal(writes.join(""), "x".repeat(600_000) + "tail");
  } finally {
    output.dispose();
  }
});

test("activity hints include in-flight output and split UTF-8 without retaining parsed output", async () => {
  let finish: (() => void) | undefined;
  const output = createTerminalOutputAddon({ onWrite() {}, onError: assert.fail });
  output.activate({
    write(_data: string, callback: () => void) { finish = callback; },
  } as unknown as Xterm);
  try {
    const star = encode("✦");
    output.write(star.subarray(0, 1));
    await tick();
    output.write(star.subarray(1));
    output.write(encode(" Working…"));
    assert.equal(output.getPendingText(), "✦ Working…");
    finish!();
    await tick();
    finish!();
    assert.equal(output.getPendingText(), "");
  } finally {
    output.dispose();
  }
});

test("terminal disposal cancels scheduled output and ignores late parse callbacks", async () => {
  for (const alreadyWriting of [false, true]) {
    let writes = 0;
    let notifications = 0;
    let finish: (() => void) | undefined;
    const output = createTerminalOutputAddon({
      onWrite: () => { notifications++; },
      onError: assert.fail,
    });
    output.activate({
      write(_data: string, callback: () => void) { writes++; finish = callback; },
    } as unknown as Xterm);
    output.write(encode("old session"));
    if (alreadyWriting) await tick();
    output.dispose();
    finish?.();
    output.write(encode("stale output"));
    await tick();
    assert.equal(writes, alreadyWriting ? 1 : 0);
    assert.equal(notifications, 0);
    assert.equal(output.getPendingText(), "");
  }
});
