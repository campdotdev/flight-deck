// The images an outbox's files name. A file names an image with Markdown image syntax and its bare file name,
// such as `![Before](before.png)`, which must sit in `media/` (overview, ADR 0009). The runner uploads each one
// once and embeds it once (ADR 0019).
import { extname } from "node:path";

/** `![alt](target)` or `![alt](target "title")`, with an optional `<target>`. */
const IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

/** A bare file name: no folder, no scheme, no query, and not `.` or `..`. */
function isBareName(target: string): boolean {
  return /^[^/\\:?#]+$/.test(target) && target !== "." && target !== "..";
}

/** Every image target the text names, in order. */
export function imageTargets(text: string): string[] {
  return [...text.matchAll(IMAGE)].map((match) => match[2] ?? "");
}

/**
 * The broken rule when a file names an image whose target isn't a bare file name in `media/`, else `null`.
 * `files` holds each posted file by its name in the outbox.
 */
export function mediaRule(files: { name: string; text: string }[], media: ReadonlySet<string>): string | null {
  for (const { name, text } of files) {
    for (const target of imageTargets(text)) {
      if (!isBareName(target)) return `${name} names the image ${target}, which isn't a bare file name in media/`;
      if (!media.has(target)) return `${name} names the image ${target}, which media/ doesn't hold`;
    }
  }
  return null;
}

/** The text with each image's file name replaced by its upload URL. A name with no upload, as in a dry run, stays. */
export function embedImages(text: string, uploads: Readonly<Record<string, string>>): string {
  return text.replace(IMAGE, (whole, alt: string, target: string) => {
    const url = uploads[target];
    return url === undefined ? whole : `![${alt}](${url})`;
  });
}

/**
 * The text with each image replaced by its alt text and file name in brackets, such as "\[Before: before.png\]",
 * for a brief's fold, because the description already shows the image (ADR 0019).
 */
export function nameImages(text: string): string {
  return text.replace(IMAGE, (_, alt: string, target: string) => (alt.trim() === "" ? `\\[${target}\\]` : `\\[${alt.trim()}: ${target}\\]`));
}

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
};

/** The upload's content type, from the file name's extension. */
export function contentType(name: string): string {
  return CONTENT_TYPES[extname(name).toLowerCase()] ?? "application/octet-stream";
}
