import { useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Channel } from "@tauri-apps/api/core";
import {
  spawnPty,
  writePty,
  resizePty,
  killPty,
  type PtyEvent,
  type PtyOutputData,
  type PtyExitData,
} from "../lib/tauri";
import { TERMINAL_CONFIG, TERMINAL_THEME, RESIZE_DEBOUNCE_MS } from "../lib/constants";

interface UsePtyOptions {
  cwd?: string;
}

export function usePty(
  containerRef: React.RefObject<HTMLDivElement | null>,
  options?: UsePtyOptions,
) {
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const resizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleResize = useCallback(() => {
    if (resizeTimeoutRef.current) {
      clearTimeout(resizeTimeoutRef.current);
    }
    resizeTimeoutRef.current = setTimeout(() => {
      const fitAddon = fitAddonRef.current;
      const terminal = terminalRef.current;
      const sessionId = sessionIdRef.current;
      if (fitAddon && terminal && sessionId) {
        fitAddon.fit();
        resizePty(sessionId, terminal.rows, terminal.cols).catch(
          console.error,
        );
      }
    }, RESIZE_DEBOUNCE_MS);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      ...TERMINAL_CONFIG,
      theme: TERMINAL_THEME,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);

    // Try WebGL renderer, fall back to canvas
    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddon.dispose();
      });
      terminal.loadAddon(webglAddon);
    } catch {
      // Canvas fallback is automatic
    }

    fitAddon.fit();
    terminal.focus();
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Channel for PTY output
    const channel = new Channel<PtyEvent>();
    channel.onmessage = (event: PtyEvent) => {
      if (event.event === "Output") {
        const { data } = event.data as PtyOutputData;
        terminal.write(new Uint8Array(data));
      } else if (event.event === "Exit") {
        const { code } = event.data as PtyExitData;
        terminal.write(
          `\r\n\x1b[90m[Process exited with code ${code ?? "unknown"}]\x1b[0m\r\n`,
        );
      }
    };

    const sessionId = crypto.randomUUID();
    sessionIdRef.current = sessionId;

    spawnPty(
      sessionId,
      terminal.rows,
      terminal.cols,
      channel,
      options?.cwd,
    ).catch(console.error);

    terminal.onData((data: string) => {
      writePty(sessionId, data).catch(console.error);
    });

    const resizeObserver = new ResizeObserver(() => {
      handleResize();
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      if (resizeTimeoutRef.current) {
        clearTimeout(resizeTimeoutRef.current);
      }
      killPty(sessionId).catch(console.error);
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      sessionIdRef.current = null;
    };
  }, [containerRef, handleResize, options?.cwd]);

  return { terminalRef, sessionIdRef };
}
