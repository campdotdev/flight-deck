// The images an outbox's files name. A file names an image with Markdown image syntax and its bare file name,
// such as `![Before](before.png)`, which must sit in `media/` (overview, ADR 0009). The runner uploads each one
// once and embeds it once (ADR 0019). Image syntax in a fenced code block or a code span is text, not an image.
import { extname } from "node:path";
import { codeLines } from "../tracker/index.ts";

/** `![alt](target)` or `![alt](target "title")`, with an optional `<target>`. */
const IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

/** A bare file name: no folder, no scheme, no query, and not `.` or `..`. */
function isBareName(target: string): boolean {
  return /^[^/\\:?#]+$/.test(target) && target !== "." && target !== "..";
}

/**
 * Image syntax `IMAGE` doesn't match: `![alt][ref]`, an `![alt](` whose target has a space, and an HTML `<img>`.
 * Each names a URL or a path, which `session.md` forbids, and the runner can't upload it.
 */
const OTHER_IMAGE = /!\[[^\]]*\][([]|<img\b/i;

/** The line split at its code spans: the even parts are prose, the odd parts code spans. */
function spans(line: string): string[] {
  const parts: string[] = [];
  let last = 0;
  for (const span of line.matchAll(/(`+)[^`]*?\1/g)) {
    parts.push(line.slice(last, span.index), span[0]);
    last = span.index + span[0].length;
  }
  return [...parts, line.slice(last)];
}

/** The text's stretches outside fenced code blocks and code spans. */
function prose(text: string): string[] {
  return codeLines(text).flatMap(({ line, code }) => (code ? [] : spans(line).filter((_, index) => index % 2 === 0)));
}

/** The text with `edit` applied to each stretch outside code. */
function inProse(text: string, edit: (prose: string) => string): string {
  return codeLines(text)
    .map(({ line, code }) => (code ? line : spans(line).map((part, index) => (index % 2 === 0 ? edit(part) : part)).join("")))
    .join("\n");
}

/** Every image target the text names outside code, in order. */
export function imageTargets(text: string): string[] {
  return prose(text).flatMap((stretch) => [...stretch.matchAll(IMAGE)].map((match) => match[2] ?? ""));
}

/** Whether the text shows an image outside code that isn't `![alt](target)`. */
function showsOtherImage(text: string): boolean {
  return prose(text).some((stretch) => OTHER_IMAGE.test(stretch.replace(IMAGE, "")));
}

/**
 * The broken rule when a file names an image whose target isn't a bare file name in `media/`, else `null`.
 * `files` holds each posted file by its name in the outbox.
 */
export function mediaRule(files: { name: string; text: string }[], media: ReadonlySet<string>): string | null {
  for (const { name, text } of files) {
    if (showsOtherImage(text)) return `${name} shows an image by reference or HTML, so it names no file in media/: use ![alt](file)`;
    for (const target of imageTargets(text)) {
      if (!isBareName(target)) return `${name} names the image ${target}, which isn't a bare file name in media/`;
      if (!media.has(target)) return `${name} names the image ${target}, which media/ doesn't hold`;
    }
  }
  return null;
}

/** The text with each image's file name replaced by its upload URL. A name with no upload, as in a dry run, stays. */
export function embedImages(text: string, uploads: Readonly<Record<string, string>>): string {
  return inProse(text, (prose) =>
    prose.replace(IMAGE, (whole, alt: string, target: string) => {
      const url = uploads[target];
      return url === undefined ? whole : `![${alt}](${url})`;
    }),
  );
}

/**
 * The text with each image replaced by its alt text and file name in brackets, such as "\[Before: before.png\]",
 * for a brief's fold, because the description already shows the image (ADR 0019).
 */
export function nameImages(text: string): string {
  return inProse(text, (prose) =>
    prose.replace(IMAGE, (_, alt: string, target: string) => (alt.trim() === "" ? `\\[${target}\\]` : `\\[${alt.trim()}: ${target}\\]`)),
  );
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
