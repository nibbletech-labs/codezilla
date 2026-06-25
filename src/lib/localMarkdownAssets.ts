const URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

function stripQueryAndHash(src: string): string {
  const queryIdx = src.indexOf("?");
  const hashIdx = src.indexOf("#");
  const cutIdx = [queryIdx, hashIdx].filter((idx) => idx >= 0).sort((a, b) => a - b)[0];
  return cutIdx === undefined ? src : src.slice(0, cutIdx);
}

function safeDecodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx > 0 ? path.slice(0, idx) : "/";
}

function joinPath(base: string, child: string): string {
  const combined = child.startsWith("/")
    ? `${base.replace(/\/+$/, "")}${child}`
    : `${base.replace(/\/+$/, "")}/${child}`;

  const absolute = combined.startsWith("/");
  const segments: string[] = [];
  for (const segment of combined.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
    } else {
      segments.push(segment);
    }
  }

  return `${absolute ? "/" : ""}${segments.join("/")}`;
}

export function getMimeTypeFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    webp: "image/webp",
    bmp: "image/bmp",
    ico: "image/x-icon",
    tiff: "image/tiff",
    tif: "image/tiff",
  };
  return map[ext] ?? "application/octet-stream";
}

export function resolveMarkdownImageCandidates(
  src: string,
  markdownFilePath: string,
  projectRoot: string,
): string[] {
  const trimmed = src.trim();
  if (!trimmed || trimmed.startsWith("#")) return [];

  if (URL_SCHEME_RE.test(trimmed) || trimmed.startsWith("//")) return [];

  const imagePath = safeDecodePath(stripQueryAndHash(trimmed));
  if (!imagePath) return [];

  const candidates = imagePath.startsWith("/")
    ? [
        joinPath(projectRoot, `public${imagePath}`),
        joinPath(projectRoot, imagePath),
      ]
    : [
        joinPath(dirname(markdownFilePath), imagePath),
      ];

  return Array.from(new Set(candidates));
}
