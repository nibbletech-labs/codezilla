import { marked } from "marked";
import type { Highlighter } from "shiki";
import { sanitizeHtml } from "./sanitize";
import { highlightWithHljs } from "./hljs";

export function isMarkdownFile(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase();
  return ext === "md" || ext === "mdx" || ext === "markdown";
}

export function renderMarkdown(
  content: string,
  highlighter: Highlighter | null,
  theme: string,
): string {
  const renderer = new marked.Renderer();

  renderer.code = ({ text, lang }: { text: string; lang?: string }) => {
    if (highlighter && lang) {
      try {
        return highlighter.codeToHtml(text, { lang, theme });
      } catch {
        // Fall back below.
      }
    }

    if (lang) {
      const fallback = highlightWithHljs(text, lang);
      if (fallback) return fallback;
    }

    const escaped = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    return `<pre class="md-code-plain"><code>${escaped}</code></pre>`;
  };

  const raw = marked.parse(content, {
    renderer,
    gfm: true,
    async: false,
  }) as string;

  return sanitizeHtml(raw);
}
