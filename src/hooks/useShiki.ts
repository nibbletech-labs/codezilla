import { useEffect, useState } from "react";
import { createHighlighter, type Highlighter } from "shiki";

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["vitesse-dark", "vitesse-light"],
      langs: [
        "javascript", "typescript", "tsx", "jsx",
        "json", "html", "css", "markdown",
        "rust", "python", "go", "yaml", "toml",
        "bash", "sql", "c", "cpp",
      ],
    });
  }
  return highlighterPromise;
}

export function useShiki(): Highlighter | null {
  const [highlighter, setHighlighter] = useState<Highlighter | null>(null);

  useEffect(() => {
    getHighlighter().then(setHighlighter);
  }, []);

  return highlighter;
}
