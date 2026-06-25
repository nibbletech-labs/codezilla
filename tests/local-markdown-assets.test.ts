import assert from "node:assert/strict";
import test from "node:test";
import {
  getMimeTypeFromPath,
  resolveMarkdownImageCandidates,
} from "../src/lib/localMarkdownAssets.ts";

const PROJECT_ROOT = "/Users/tom/Local_Projects/tomfrench.net";
const ARTICLE_PATH = `${PROJECT_ROOT}/content/articles/putting-ai-in-agile-part-1.md`;

test("root-relative markdown images prefer public assets", () => {
  assert.deepEqual(
    resolveMarkdownImageCandidates("/attachments/ai-agile-spec-history.png", ARTICLE_PATH, PROJECT_ROOT),
    [
      `${PROJECT_ROOT}/public/attachments/ai-agile-spec-history.png`,
      `${PROJECT_ROOT}/attachments/ai-agile-spec-history.png`,
    ],
  );
});

test("relative markdown images resolve against the markdown file directory", () => {
  assert.deepEqual(
    resolveMarkdownImageCandidates("../images/diagram.svg", ARTICLE_PATH, PROJECT_ROOT),
    [`${PROJECT_ROOT}/content/images/diagram.svg`],
  );
});

test("external and already resolved image URLs are ignored", () => {
  assert.deepEqual(resolveMarkdownImageCandidates("https://example.com/image.png", ARTICLE_PATH, PROJECT_ROOT), []);
  assert.deepEqual(resolveMarkdownImageCandidates("//cdn.example.com/image.png", ARTICLE_PATH, PROJECT_ROOT), []);
  assert.deepEqual(resolveMarkdownImageCandidates("data:image/png;base64,abc", ARTICLE_PATH, PROJECT_ROOT), []);
  assert.deepEqual(resolveMarkdownImageCandidates("asset://localhost/image.png", ARTICLE_PATH, PROJECT_ROOT), []);
  assert.deepEqual(resolveMarkdownImageCandidates("file:///tmp/image.png", ARTICLE_PATH, PROJECT_ROOT), []);
});

test("image paths drop query and hash before resolving", () => {
  assert.deepEqual(
    resolveMarkdownImageCandidates("./diagram%20one.png?width=1200#caption", ARTICLE_PATH, PROJECT_ROOT),
    [`${PROJECT_ROOT}/content/articles/diagram one.png`],
  );
});

test("image mime type is inferred from extension", () => {
  assert.equal(getMimeTypeFromPath("/tmp/figure.webp"), "image/webp");
  assert.equal(getMimeTypeFromPath("/tmp/unknown.asset"), "application/octet-stream");
});
