import type { ILinkProvider, ITerminalAddon } from "@xterm/xterm";

/** Preserve clicks made before xterm's asynchronous hover lookup has finished. */
export function createTerminalLinkClickAddon(provider: ILinkProvider): ITerminalAddon {
  let cleanup = () => {};
  return {
    activate(terminal) {
      const element = terminal.element;
      const screen = element?.querySelector<HTMLElement>(".xterm-screen");
      if (!element || !screen) return;

      const activated = new WeakSet<MouseEvent>();
      const registration = terminal.registerLinkProvider({
        provideLinks(row, callback) {
          provider.provideLinks(row, (links) => callback(links?.map((link) => ({
            ...link,
            activate(event, text) {
              activated.add(event);
              link.activate(event, text);
            },
          }))));
        },
      });

      const position = (event: MouseEvent) => {
        const rect = screen.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        if (rect.width <= 0 || rect.height <= 0 || x < 0 || y < 0 || x >= rect.width || y >= rect.height) return;
        return {
          x: Math.max(1, Math.ceil(x / (rect.width / terminal.cols))),
          y: Math.max(1, Math.ceil(y / (rect.height / terminal.rows))) + terminal.buffer.active.viewportY,
        };
      };

      let generation = 0;
      let down: {
        x: number; y: number; clientX: number; clientY: number;
        buffer: typeof terminal.buffer.active; viewportY: number; text: string;
      } | undefined;
      const cancel = () => { generation++; down = undefined; };
      const onDown = (event: MouseEvent) => {
        cancel();
        if (event.button !== 0 || event.shiftKey) return;
        const cell = position(event);
        if (!cell) return;
        const buffer = terminal.buffer.active;
        down = {
          ...cell, clientX: event.clientX, clientY: event.clientY,
          buffer, viewportY: buffer.viewportY,
          text: buffer.getLine(cell.y - 1)?.translateToString(true) ?? "",
        };
      };
      const onUp = (event: MouseEvent) => {
        const start = down;
        down = undefined;
        if (!start || event.button !== 0 || event.shiftKey || event.defaultPrevented || activated.has(event) || terminal.hasSelection()) return;
        const cell = position(event);
        if (!cell || cell.x !== start.x || cell.y !== start.y ||
          Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) > 4) return;

        const request = generation;
        const stillValid = () => request === generation && element.isConnected &&
          terminal.buffer.active === start.buffer && start.buffer.viewportY === start.viewportY &&
          start.buffer.getLine(cell.y - 1)?.translateToString(true) === start.text && !terminal.hasSelection();
        if (!stillValid()) return;
        provider.provideLinks(cell.y, (links) => {
          if (!stillValid()) return;
          const link = links?.find(({ range }) =>
            cell.y >= range.start.y && cell.y <= range.end.y &&
            (cell.y !== range.start.y || cell.x >= range.start.x) &&
            (cell.y !== range.end.y || cell.x <= range.end.x));
          link?.activate(event, link.text);
        });
      };

      // Bubble after xterm's mouseup handler so an ordinary activation wins.
      // Any subsequent click, scroll, or Escape cancels an outstanding lookup.
      const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") cancel(); };
      element.ownerDocument.addEventListener("mousedown", cancel, true);
      element.ownerDocument.addEventListener("keydown", onKey, true);
      element.addEventListener("mousedown", onDown);
      element.addEventListener("mouseup", onUp);
      const scroll = terminal.onScroll(cancel);
      const resize = terminal.onResize(cancel);
      cleanup = () => {
        cancel();
        registration.dispose();
        scroll.dispose();
        resize.dispose();
        element.ownerDocument.removeEventListener("mousedown", cancel, true);
        element.ownerDocument.removeEventListener("keydown", onKey, true);
        element.removeEventListener("mousedown", onDown);
        element.removeEventListener("mouseup", onUp);
      };
    },
    dispose() { cleanup(); },
  };
}
