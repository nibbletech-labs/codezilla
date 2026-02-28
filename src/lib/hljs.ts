import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

let initialized = false;

function ensureInitialized(): void {
  if (initialized) return;
  hljs.registerLanguage("bash", bash);
  hljs.registerLanguage("c", c);
  hljs.registerLanguage("cpp", cpp);
  hljs.registerLanguage("css", css);
  hljs.registerLanguage("go", go);
  hljs.registerLanguage("javascript", javascript);
  hljs.registerLanguage("json", json);
  hljs.registerLanguage("markdown", markdown);
  hljs.registerLanguage("python", python);
  hljs.registerLanguage("rust", rust);
  hljs.registerLanguage("sql", sql);
  hljs.registerLanguage("typescript", typescript);
  hljs.registerLanguage("xml", xml);
  hljs.registerLanguage("html", xml);
  hljs.registerLanguage("yaml", yaml);
  initialized = true;
}

function normalizeLang(lang: string): string | null {
  const key = lang.toLowerCase();
  if (key === "js" || key === "javascript" || key === "mjs" || key === "cjs") return "javascript";
  if (key === "ts" || key === "typescript") return "typescript";
  if (key === "tsx") return "typescript";
  if (key === "jsx") return "javascript";
  if (key === "html" || key === "htm" || key === "xml") return "html";
  if (key === "css") return "css";
  if (key === "json" || key === "jsonc" || key === "json5") return "json";
  if (key === "markdown" || key === "md" || key === "mdx") return "markdown";
  if (key === "py" || key === "python") return "python";
  if (key === "rs" || key === "rust") return "rust";
  if (key === "go") return "go";
  if (key === "yaml" || key === "yml") return "yaml";
  if (key === "sql") return "sql";
  if (key === "sh" || key === "bash" || key === "zsh" || key === "shell") return "bash";
  if (key === "c" || key === "h") return "c";
  if (key === "cpp" || key === "cxx" || key === "cc" || key === "hpp" || key === "hxx") return "cpp";
  return null;
}

export function highlightWithHljs(code: string, lang: string): string | null {
  const normalized = normalizeLang(lang);
  if (!normalized) return null;

  ensureInitialized();
  try {
    const value = hljs.highlight(code, {
      language: normalized,
      ignoreIllegals: true,
    }).value;
    return `<pre class="hljs"><code>${value}</code></pre>`;
  } catch {
    return null;
  }
}
