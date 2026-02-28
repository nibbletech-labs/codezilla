import { useEffect, useState } from "react";
import { createHighlighter, createJavaScriptRegexEngine, type Highlighter } from "shiki";

let highlighterPromise: Promise<Highlighter> | null = null;

function createShikiHighlighter(): Promise<Highlighter> {
  return createHighlighter({
    // Use the JS regex engine to avoid WebAssembly/runtime loading issues
    // in webviews that can silently disable syntax highlighting.
    engine: createJavaScriptRegexEngine(),
    themes: ["vitesse-dark", "vitesse-light"],
    langs: [
      "javascript", "typescript", "tsx", "jsx",
      "json", "html", "css", "markdown",
      "rust", "python", "go", "yaml", "toml",
      "bash", "sql", "c", "cpp",
    ],
  });
}

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createShikiHighlighter().catch((err) => {
      // Do not cache a rejected promise forever.
      highlighterPromise = null;
      throw err;
    });
  }
  return highlighterPromise;
}

export function useShiki(): Highlighter | null {
  const [highlighter, setHighlighter] = useState<Highlighter | null>(null);

  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    const maxRetries = 2;

    const init = () => {
      getHighlighter()
        .then((instance) => {
          if (!cancelled) setHighlighter(instance);
        })
        .catch((err) => {
          if (cancelled) return;
          console.error("Failed to initialize syntax highlighter:", err);
          if (attempts < maxRetries) {
            attempts += 1;
            const delayMs = attempts * 400;
            window.setTimeout(() => {
              if (!cancelled) init();
            }, delayMs);
          }
        });
    };

    init();
    return () => {
      cancelled = true;
    };
  }, []);

  return highlighter;
}
