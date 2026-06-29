import { marked } from "marked";
import { sanitizeHtml } from "./sanitize";
import { highlightWithHljs } from "./hljs";
import { splitFrontMatter, renderFrontMatterPanel } from "./frontMatter";

export function isMarkdownFile(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase();
  return ext === "md" || ext === "mdx" || ext === "markdown";
}

// Every markdown file is editable via the raw source editor — there is no
// longer a WYSIWYG round-trip to constrain editing to plain `.md`.
export function isEditableMarkdownFile(filePath: string): boolean {
  return isMarkdownFile(filePath);
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

  // Split off a leading YAML front matter block so it renders as a structured
  // metadata panel instead of marked treating the `---` delimiters as
  // horizontal rules and the metadata as a paragraph.
  const split = splitFrontMatter(content);
  const panel = renderFrontMatterPanel(split);

  const raw = marked.parse(split.body, {
    renderer,
    gfm: true,
    async: false,
  }) as string;

  return sanitizeHtml(panel + raw);
}
