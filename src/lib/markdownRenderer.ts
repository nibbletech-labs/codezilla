import { marked } from "marked";
import { sanitizeHtml } from "./sanitize";
import { highlightWithHljs } from "./hljs";

export function isMarkdownFile(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase();
  return ext === "md" || ext === "mdx" || ext === "markdown";
}

// Shiki is not used here because its output relies on inline style=""
// attributes which are blocked by Tauri's CSP nonce policy. hljs uses
// CSS classes instead, which work with external stylesheets.
export function renderMarkdown(content: string): string {
  const renderer = new marked.Renderer();

  renderer.code = ({ text, lang }: { text: string; lang?: string }) => {
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
