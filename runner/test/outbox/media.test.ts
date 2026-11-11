// The image matcher every outbox check, upload, and embed shares (ADRs 0009 and 0019).
import { expect, test } from "bun:test";
import { embedImages, imageTargets, mediaRule } from "../../src/outbox/media.ts";

test.each([`"caption"`, `'caption'`, `(caption)`])("an image with a %s title names its target", (title) => {
  const text = `![Before](before.png ${title})`;
  expect(imageTargets(text)).toEqual(["before.png"]);
  expect(mediaRule([{ name: "brief.md", text }], new Set())).toBe("brief.md names the image before.png, which media/ doesn't hold");
  expect(embedImages(text, { "before.png": "https://uploads.linear.app/before.png" })).toBe("![Before](https://uploads.linear.app/before.png)");
});

test("an image URL with a single-quoted title is still not a bare file name", () => {
  const text = "![Before](https://example.com/before.png 'caption')";
  expect(mediaRule([{ name: "summary.md", text }], new Set())).toBe("summary.md names the image https://example.com/before.png, which isn't a bare file name in media/");
});
