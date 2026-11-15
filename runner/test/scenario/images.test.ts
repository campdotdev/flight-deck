// The runner uploads each image an outbox file names and embeds it once (ADR 0019). A session names an image
// by its bare file name in media/, never by a URL (ADR 0009).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { StoredIssue } from "../../src/tracker/index.ts";
import { outbox, World } from "./world.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const BRIEF = "## Summary\n\nThe Save button turns red.\n\n![Before](before.png)\n\n## Key interfaces\n\nNone.";
const SUMMARY = "Brief ready: the Save button turns red\n\nIt takes the shared red.";

let world: World;

beforeEach(async () => {
  world = await World.create();
});

afterEach(async () => {
  await world.cleanup();
});

async function planned(issue: StoredIssue, files: Record<string, string | Uint8Array>): Promise<string> {
  world.send(issue);
  world.harness.script(issue.identifier, { outbox: files, exit: { kind: "exited", code: 0 } });
  await world.tick();
  await world.tick();
  return world.harness.started.at(-1)!.session.id;
}

function uploads(): { name: string; url: string }[] {
  return world.tracker.writes.flatMap((write) => (write.kind === "upload" ? [{ name: write.name, url: write.url }] : []));
}

describe("an image in a brief", () => {
  test("is uploaded once, embedded in the description, and named in the fold", async () => {
    const issue = world.issue({ title: "Save button is blue", description: "It should be red." });
    const session = await planned(issue, { ...outbox.brief({ summary: SUMMARY, brief: BRIEF }), "media/before.png": PNG });
    const [upload, ...more] = uploads();
    expect(more).toEqual([]);
    expect(upload!.name).toBe("before.png");
    expect(upload!.url).not.toContain("signature");
    expect(world.tracker.uploads.get(upload!.url)).toEqual(PNG);

    const embedded = BRIEF.replace("![Before](before.png)", `![Before](${upload!.url})`);
    const named = BRIEF.replace("![Before](before.png)", "\\[Before: before.png\\]");
    const take = world.tracker.writes.findIndex((write) => write.kind === "move" && write.status === "Planning");
    expect(world.tracker.writes.slice(take + 1)).toEqual([
      { kind: "upload", name: "before.png", url: upload!.url },
      { kind: "description", issue: issue.identifier, description: `${embedded}\n\n+++ Report\n\nIt should be red.\n\n+++` },
      {
        kind: "comment",
        issue: issue.identifier,
        body: `🟢 Moving to build: Brief ready: the Save button turns red\n\nIt takes the shared red.\n\n+++ Details\n\n${named}\n\nFlight Deck ${world.version} · plan · session ${session}\n\n+++`,
      },
      { kind: "move", issue: issue.identifier, status: "Ready to build" },
    ]);
  });

  test("named twice is uploaded once", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    const brief = `${BRIEF}\n\nAgain: ![Before](before.png)`;
    const summary = "Brief ready: the Save button turns red\n\n![Before](before.png)";
    await planned(issue, { ...outbox.brief({ summary, brief }), "media/before.png": PNG });
    expect(uploads().map((upload) => upload.name)).toEqual(["before.png"]);
  });
});

describe("an image in a pause", () => {
  test("is embedded in the fold", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    const pause = "## Question\n\nWhich red?\n\n![Two reds](reds.png)";
    await planned(issue, { ...outbox.pause({ summary: "Which red?\n\nThere are two.", pause, answers: [], needs: "help" }), "media/reds.png": PNG });
    const [upload] = uploads();
    const comment = world.tracker.writes.find((write) => write.kind === "comment");
    expect(comment?.kind === "comment" && comment.body).toContain(`![Two reds](${upload!.url})`);
  });
});

describe("an image in a follow-up issue", () => {
  test("is embedded in its description", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await planned(issue, {
      ...outbox.brief({ summary: SUMMARY, brief: "## Summary\n\nRed.\n\n## Key interfaces\n\nNone." }),
      "follow-ups/1.md": "# Cancel is blue too\n\n![Cancel](cancel.png)",
      "media/cancel.png": PNG,
    });
    const [upload] = uploads();
    const filed = world.tracker.writes.find((write) => write.kind === "file");
    expect(filed?.kind === "file" && filed.description).toBe(`![Cancel](${upload!.url})\n\nFlight Deck ${world.version} · plan · follow-up`);
  });
});

describe("an image the Outbox refuses", () => {
  test.each([
    ["isn't in media/", { "brief.md": BRIEF }],
    ["is a URL", { "brief.md": BRIEF.replace("before.png", "https://example.com/before.png"), "media/before.png": PNG }],
    ["is a path", { "brief.md": BRIEF.replace("before.png", "media/before.png"), "media/before.png": PNG }],
    ["sits in a follow-up and isn't in media/", { "follow-ups/1.md": "# Cancel\n\n![Cancel](cancel.png)", "media/before.png": PNG }],
  ])("that %s fails the outbox before any write", async (_, files) => {
    const issue = world.issue({ title: "Save button is blue" });
    await planned(issue, { ...outbox.brief({ summary: SUMMARY, brief: BRIEF }), ...files });
    expect(world.tracker.writes.map((write) => write.kind)).toEqual(["unsubscribe", "move"]);
  });
});
