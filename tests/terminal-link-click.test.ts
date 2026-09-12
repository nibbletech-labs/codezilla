import assert from "node:assert/strict";
import test from "node:test";
import type { IBufferLine, ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { createTerminalLinkClickAddon } from "../src/lib/terminalLinkClickAddon.ts";
import { createFilePathLinkProviderForTerminal } from "../src/lib/filePathLinkProvider.ts";

function bufferLine(text: string, cells = [...text].map((chars) => ({ chars, width: 1 })), isWrapped = false) {
  return {
    isWrapped,
    length: cells.length,
    translateToString: (trimRight: boolean) => trimRight ? text.trimEnd() : text,
    getCell: (index: number) => cells[index] && ({
      getChars: () => cells[index].chars,
      getWidth: () => cells[index].width,
    }),
  } as unknown as IBufferLine;
}

function mouse(type: string, options: Record<string, unknown> = {}) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { button: 0, clientX: 25, clientY: 5, shiftKey: false, ...options });
  return event as MouseEvent;
}

function harness() {
  const document = new EventTarget();
  const element = Object.assign(new EventTarget(), {
    ownerDocument: document,
    isConnected: true,
    querySelector: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }) }),
  });
  let line = bufferLine("src/foo.ts");
  let selected = false;
  let registered: ILinkProvider;
  let scroll = () => {};
  const buffer = { viewportY: 0, getLine: () => line };
  const terminal = {
    element, cols: 20, rows: 10, buffer: { active: buffer },
    hasSelection: () => selected,
    registerLinkProvider: (p: ILinkProvider) => { registered = p; return { dispose() {} }; },
    onScroll: (callback: () => void) => { scroll = callback; return { dispose() {} }; },
    onResize: () => ({ dispose() {} }),
  } as unknown as Terminal;
  const replies: ((links: ILink[]) => void)[] = [];
  const activations: MouseEvent[] = [];
  const link: ILink = {
    range: { start: { x: 1, y: 1 }, end: { x: 10, y: 1 } },
    text: "src/foo.ts",
    activate: (event) => { activations.push(event); },
  };
  // xterm's native mouseup listener runs before the addon's fallback.
  let native: ILink | undefined;
  element.addEventListener("mouseup", (event) => native?.activate(event as MouseEvent, native.text));
  const addon = createTerminalLinkClickAddon({ provideLinks: (_, cb) => { replies.push(cb); } });
  addon.activate(terminal);
  return {
    terminal, link, replies, activations, addon,
    down(options = {}) {
      const event = mouse("mousedown", options);
      document.dispatchEvent(event);
      element.dispatchEvent(event);
    },
    up(options = {}) { const event = mouse("mouseup", options); element.dispatchEvent(event); return event; },
    setSelection() { selected = true; },
    replaceLine() { line = bufferLine("other text"); },
    scroll() { scroll(); },
    cancel() { document.dispatchEvent(mouse("mousedown")); },
    setNative() {
      registered!.provideLinks(1, (links) => { native = links?.[0]; });
      replies.shift()!([link]);
    },
  };
}

test("first click activates when link detection finishes after mouseup", () => {
  const h = harness();
  h.down();
  const event = h.up({ metaKey: true });
  assert.equal(h.activations.length, 0);
  h.replies.shift()!([h.link]);
  assert.deepEqual(h.activations, [event]);
  assert.equal(h.activations[0].metaKey, true);
  h.addon.dispose();
});

test("a native xterm activation is never repeated by the fallback", () => {
  const h = harness();
  h.setNative();
  h.down();
  h.up();
  assert.equal(h.activations.length, 1);
  assert.equal(h.replies.length, 0);
  h.addon.dispose();
});

test("dragging, selecting, Shift-click and right-click do not open a link", () => {
  for (const gesture of ["drag", "selection", "shift", "right"]) {
    const h = harness();
    h.down(gesture === "shift" ? { shiftKey: true } : gesture === "right" ? { button: 2 } : {});
    if (gesture === "selection") h.setSelection();
    h.up(gesture === "drag" ? { clientX: 65 } : {});
    assert.equal(h.replies.length, 0, gesture);
    assert.equal(h.activations.length, 0, gesture);
    h.addon.dispose();
  }
});

test("stale lookups cannot open menus after output, scroll, another click, or disposal", () => {
  for (const change of ["replaceLine", "scroll", "cancel", "dispose"] as const) {
    const h = harness();
    h.down();
    h.up();
    if (change === "dispose") h.addon.dispose();
    else h[change]();
    h.replies.shift()!([h.link]);
    assert.equal(h.activations.length, 0, change);
    h.addon.dispose();
  }
});

test("clicks outside the link or terminal never activate it", () => {
  const h = harness();
  h.down({ clientX: 155 });
  h.up({ clientX: 155 });
  h.replies.shift()!([h.link]);
  h.down({ clientX: 205 });
  h.up({ clientX: 205 });
  assert.equal(h.replies.length, 0);
  assert.equal(h.activations.length, 0);
  h.addon.dispose();
});

test("click fallback hits every row of a wrapped link and excludes adjacent cells", () => {
  for (const [x, y, expected] of [[4, 1, 0], [5, 1, 1], [20, 1, 1], [1, 2, 1], [20, 2, 1], [1, 3, 1], [6, 3, 1], [7, 3, 0]]) {
    const h = harness();
    h.link.range = { start: { x: 5, y: 1 }, end: { x: 6, y: 3 } };
    const position = { clientX: x * 10 - 5, clientY: y * 10 - 5 };
    h.down(position);
    h.up(position);
    h.replies.shift()!([h.link]);
    assert.equal(h.activations.length, expected, `cell ${x},${y}`);
    h.addon.dispose();
  }
});

function fileProvider(line: IBufferLine | IBufferLine[], index: Set<string>, pathExists: (path: string) => Promise<boolean>) {
  const lines = Array.isArray(line) ? line : [line];
  const terminal = { buffer: { active: { getLine: (row: number) => lines[row] } } } as unknown as Terminal;
  const menus: string[] = [];
  const previews: string[] = [];
  const provider = createFilePathLinkProviderForTerminal(terminal, "/click-test", {
    onSelect() {}, onMultipleMatches() {},
    onPreview: (path) => { previews.push(path); },
    onShowMenu: (path) => { menus.push(path); },
  }, { getFileIndex: () => index, pathExists });
  return { provider, menus, previews, terminal };
}

function linksAt(provider: ILinkProvider, row: number) {
  return new Promise<ILink[] | undefined>((resolve) => provider.provideLinks(row, resolve));
}

test("a path spanning three rows resolves from every row with its line and column suffix", async () => {
  const h = fileProvider([
    bufferLine("See src/comp"),
    bufferLine("onents/foo.t", undefined, true),
    bufferLine("s:42:7", undefined, true),
  ], new Set(["/click-test/src/components/foo.ts"]), async () => { throw Error("unexpected IPC"); });
  for (const row of [1, 2, 3]) {
    const links = await linksAt(h.provider, row);
    assert.equal(links?.length, 1);
    assert.equal(links![0].text, "src/components/foo.ts:42:7");
    assert.deepEqual(links![0].range, { start: { x: 5, y: 1 }, end: { x: 6, y: 3 } });
    links![0].activate(mouse("mouseup"), links![0].text);
    links![0].activate(mouse("mouseup", { metaKey: true }), links![0].text);
  }
  assert.deepEqual(h.menus, Array(3).fill("/click-test/src/components/foo.ts"));
  assert.deepEqual(h.previews, h.menus);
});

test("real newlines never join separate path fragments", async () => {
  const h = fileProvider([bufferLine("src/comp"), bufferLine("onents/foo.ts")],
    new Set(["/click-test/src/components/foo.ts"]), async () => false);
  assert.equal((await linksAt(h.provider, 1))?.length ?? 0, 0);
  assert.equal((await linksAt(h.provider, 2))?.length ?? 0, 0);
});

test("links starting and ending at wrap boundaries keep inclusive cell ranges", async () => {
  const h = fileProvider([
    bufferLine("foo.ts"), bufferLine("bar.ts", undefined, true),
  ], new Set(["/click-test/foo.tsbar.ts"]), async () => false);
  assert.deepEqual((await linksAt(h.provider, 2))?.[0].range,
    { start: { x: 1, y: 1 }, end: { x: 6, y: 2 } });

  const separate = fileProvider([
    bufferLine("x     "), bufferLine("foo.ts", undefined, true), bufferLine(" bar.ts", undefined, true),
  ], new Set(["/click-test/foo.ts", "/click-test/bar.ts"]), async () => false);
  assert.deepEqual((await linksAt(separate.provider, 2))?.map((link) => link.range),
    [{ start: { x: 1, y: 2 }, end: { x: 6, y: 2 } }]);
});

test("spaces at wrap boundaries are preserved in directory names", async () => {
  const h = fileProvider([bufferLine("docs/My "), bufferLine("Folder/a.ts", undefined, true)],
    new Set(["/click-test/docs/My Folder/a.ts"]), async () => false);
  assert.equal((await linksAt(h.provider, 2))?.[0].text, "docs/My Folder/a.ts");
});

test("wide and combining characters before a wrapped path keep its cell coordinates", async () => {
  const cells = [
    { chars: "界", width: 2 }, { chars: "", width: 0 }, { chars: "e\u0301", width: 1 },
    ...[..." src/"].map((chars) => ({ chars, width: 1 })),
  ];
  const h = fileProvider([
    bufferLine(cells.map((c) => c.chars).join(""), cells), bufferLine("foo.ts", undefined, true),
  ], new Set(["/click-test/src/foo.ts"]), async () => false);
  assert.deepEqual((await linksAt(h.provider, 2))?.[0].range,
    { start: { x: 5, y: 1 }, end: { x: 6, y: 2 } });
});

test("early wrapping of a wide character does not insert a space or shift later links", async () => {
  const first = [..."See"].map((chars) => ({ chars, width: 1 }));
  first.push({ chars: "", width: 1 });
  const second = [{ chars: "界", width: 2 }, { chars: "", width: 0 },
    ...[..." foo.ts"].map((chars) => ({ chars, width: 1 }))];
  const h = fileProvider([
    bufferLine("See ", first), bufferLine("界 foo.ts", second, true),
  ], new Set(["/click-test/foo.ts"]), async () => false);
  assert.deepEqual((await linksAt(h.provider, 2))?.[0].range,
    { start: { x: 4, y: 2 }, end: { x: 9, y: 2 } });
});

test("wrapped disk paths resolve together and reject changes on any contributing row", async () => {
  for (const change of ["none", "first", "last", "unwrap", "reflow"]) {
    const lines = [bufferLine("/private/tmp/"), bufferLine(`wrapped_${change}.md`, undefined, true)];
    const checked: string[] = [];
    let finish!: (found: boolean) => void;
    const h = fileProvider(lines, new Set(), (path) => {
      checked.push(path);
      return new Promise((resolve) => { finish = resolve; });
    });
    const pending = linksAt(h.provider, 2);
    assert.deepEqual(checked, [`/private/tmp/wrapped_${change}.md`]);
    if (change === "first") lines[0] = bufferLine("/another/tmp/");
    if (change === "last") lines[1] = bufferLine("changed.md", undefined, true);
    if (change === "unwrap") lines[1] = bufferLine(`wrapped_${change}.md`);
    if (change === "reflow") {
      lines[0] = bufferLine("/private/tmp/wrapped_");
      lines[1] = bufferLine("reflow.md", undefined, true);
    }
    finish(true);
    const result = await pending;
    assert.equal(result?.length ?? 0, change === "none" ? 1 : 0, change);
  }
});

test("indexed links resolve synchronously and preserve plain/Cmd-click actions", () => {
  const h = fileProvider(bufferLine("src/foo.ts:12"), new Set(["/click-test/src/foo.ts"]), async () => { throw Error("unexpected IPC"); });
  let links: ILink[] | undefined;
  h.provider.provideLinks(1, (result) => { links = result; });
  assert.equal(links?.length, 1);
  links![0].activate(mouse("mouseup"), links![0].text);
  links![0].activate(mouse("mouseup", { metaKey: true }), links![0].text);
  assert.deepEqual(h.menus, ["/click-test/src/foo.ts"]);
  assert.deepEqual(h.previews, ["/click-test/src/foo.ts"]);
});

test("hover and click share concurrent disk checks; missing files stay unlinked", async () => {
  const checks = new Map<string, (exists: boolean) => void>();
  let calls = 0;
  const h = fileProvider(bufferLine("new.md missing.md"), new Set(), (path) => {
    calls++;
    return new Promise((resolve) => { checks.set(path, resolve); });
  });
  const hover = new Promise<ILink[] | undefined>((resolve) => h.provider.provideLinks(1, resolve));
  const click = new Promise<ILink[] | undefined>((resolve) => h.provider.provideLinks(1, resolve));
  assert.equal(calls, 2);
  checks.get("/click-test/new.md")!(true);
  checks.get("/click-test/missing.md")!(false);
  for (const result of await Promise.all([hover, click])) {
    assert.deepEqual(result?.map((link) => link.text), ["new.md"]);
  }
});

test("wide and combining characters do not shift the file hitbox", () => {
  for (const prefix of [
    [{ chars: "界", width: 2 }, { chars: "", width: 0 }],
    [{ chars: "e\u0301", width: 1 }],
  ]) {
    const cells = [...prefix, { chars: " ", width: 1 }, ...[..."foo.ts"].map((chars) => ({ chars, width: 1 }))];
    const h = fileProvider(bufferLine(cells.map((c) => c.chars).join(""), cells), new Set(["/click-test/foo.ts"]), async () => false);
    let links: ILink[] | undefined;
    h.provider.provideLinks(1, (result) => { links = result; });
    assert.deepEqual(links?.[0].range, {
      start: { x: prefix.length + 2, y: 1 }, end: { x: prefix.length + 7, y: 1 },
    });
  }
});
