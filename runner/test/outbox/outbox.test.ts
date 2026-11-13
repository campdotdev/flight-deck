// Outbox.apply on a session folder, with the in-memory Tracker. Poll's scenarios can't reach these cases: Poll
// applies an outbox only while its issue sits in Planning, applies it once, and its scripted sessions leave plain files.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Folders } from "../../src/folders/index.ts";
import { Outbox } from "../../src/outbox/index.ts";
import type { Role } from "../../src/record/index.ts";
import { State } from "../../src/state/index.ts";
import { InMemoryTracker, type StoredIssue, type TrackerRepo } from "../../src/tracker/index.ts";
import { outbox, STATUSES } from "../scenario/world.ts";

const VERSION = "0.1.0";
const SUMMARY = "Brief ready: the Save button turns green\n\nThe brief names the theme token.";
const BRIEF = "## Summary\n\nThe Save button turns green.\n\n## Current behavior\n\nThe Save button is blue.\n\n## Key interfaces\n\nNone.";

const repo: TrackerRepo = {
  name: "campdotdev/shaders",
  workspace: "campdotdev",
  team: "SHA",
  statuses: Object.fromEntries(Object.entries(STATUSES).map(([role, [name]]) => [role, name])) as Record<Role, string>,
  maintainer: "maintainer",
};

let root: string;
let sessionFolder: string;
let tracker: InMemoryTracker;
let issue: StoredIssue;
let state: State;
let apply: () => ReturnType<Outbox["apply"]>;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "flight-deck-outbox-")));
  const folders: Folders = { data: join(root, "data"), config: join(root, "config"), sessionRoot: join(root, "session-root"), home: join(root, "home") };
  tracker = new InMemoryTracker({ clock: () => new Date("2026-11-10T09:00:00Z"), appUser: "flight-deck-app" });
  tracker.addUser({ id: "maintainer", name: "Hunter" });
  tracker.addUser({ id: "flight-deck-app", name: "Flight Deck" });
  // Icebox maps to no role.
  const statuses = [...Object.values(STATUSES), ["Icebox", "backlog"] as const].map(([name, type]) => ({ name, type }));
  tracker.addTeam({ key: "SHA", name: "Shaders", statuses });
  issue = tracker.addIssue({ team: "SHA", status: STATUSES.planning[0], creator: "maintainer", title: "Save button is blue", description: "" });

  sessionFolder = join(folders.sessionRoot, "sessions", "abc123");
  await mkdir(join(sessionFolder, "outbox"), { recursive: true });
  await writeFile(
    join(sessionFolder, "session.json"),
    JSON.stringify({ version: VERSION, session: "abc123", stage: "plan", mode: "issue", repo: repo.name, issue: issue.identifier }),
  );
  state = new State(folders);
  const box = new Outbox({ version: VERSION, state, clock: () => new Date("2026-11-10T09:00:00Z"), repo: () => repo });
  apply = () => box.apply(sessionFolder, { identity: tracker });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function leave(files: Record<string, string>): Promise<void> {
  for (const [name, text] of Object.entries(files)) await writeFile(join(sessionFolder, "outbox", name), text);
}

describe("a second apply", () => {
  test("after every write landed makes none and succeeds", async () => {
    await leave(outbox.brief({ summary: SUMMARY, brief: BRIEF, version: VERSION }));
    expect(await apply()).toEqual({ result: "applied", writes: ["writeBrief", "post", "move"] });
    const writes = tracker.writes.length;
    expect(await apply()).toEqual({ result: "applied", writes: [] });
    expect(tracker.writes.length).toBe(writes);
  });
});

describe("a retry after a post whose response was lost", () => {
  test("finds the session's comment by its footer and doesn't post it twice", async () => {
    await leave(outbox.brief({ summary: SUMMARY, brief: BRIEF, version: VERSION }));
    const post = tracker.post.bind(tracker);
    tracker.post = async (...args) => {
      await post(...args);
      throw new Error("socket hang up");
    };
    await expect(apply()).rejects.toThrow("socket hang up");
    tracker.post = post;
    expect(await apply()).toEqual({ result: "applied", writes: ["post", "move"] });
    expect((await tracker.issue({ id: issue.id, repo })).comments).toHaveLength(1);
  });

  test.each([
    ["came through the GitHub sync", (body: string) => tracker.addComment(issue.id, { author: "github-user", body, synced: true })],
    [
      "is a reply",
      (body: string) => {
        const question = tracker.addComment(issue.id, { author: "maintainer", body: "Which red?" });
        tracker.addComment(issue.id, { author: "maintainer", body, parent: question.id });
      },
    ],
  ])("still posts when the only comment with the session's footer %s", async (_, add) => {
    await leave(outbox.brief({ summary: SUMMARY, brief: BRIEF, version: VERSION }));
    add(`Copied from another issue:\n\nFlight Deck ${VERSION} · plan · session abc123`);
    expect(await apply()).toEqual({ result: "applied", writes: ["writeBrief", "post", "move"] });
    expect(tracker.writes.filter((write) => write.kind === "comment")).toHaveLength(1);
  });
});

describe("a retry after a brief write whose response was lost", () => {
  test("keeps only the report in the fold, though issue memory doesn't record the brief", async () => {
    tracker.stored(issue.id).description = "The Save button is blue.";
    await leave(outbox.brief({ summary: SUMMARY, brief: BRIEF, version: VERSION }));
    const writeBrief = tracker.writeBrief.bind(tracker);
    tracker.writeBrief = async (...args) => {
      await writeBrief(...args);
      throw new Error("socket hang up");
    };
    await expect(apply()).rejects.toThrow("socket hang up");
    tracker.writeBrief = writeBrief;
    expect(await apply()).toEqual({ result: "applied", writes: ["writeBrief", "post", "move"] });
    expect((await tracker.issue({ id: issue.id, repo })).description).toBe(`${BRIEF}\n\n+++ Report\n\nThe Save button is blue.\n\n+++`);
  });

  test("can't happen to a brief that doesn't open with ## Summary, because the Outbox refuses it", async () => {
    await leave(outbox.brief({ summary: SUMMARY, brief: BRIEF.replace("## Summary", "## Problem"), version: VERSION }));
    expect(await apply()).toEqual({ result: "failed", rule: "brief.md doesn't open with ## Summary, the heading a re-plan finds the brief by", writes: [] });
    expect(tracker.writes).toEqual([]);
  });
});

describe("a retry after a move whose response was lost", () => {
  test("finds the issue in Ready to build and succeeds without moving it again", async () => {
    await leave(outbox.brief({ summary: SUMMARY, brief: BRIEF, version: VERSION }));
    const move = tracker.move.bind(tracker);
    tracker.move = async (...args) => {
      await move(...args);
      throw new Error("socket hang up");
    };
    await expect(apply()).rejects.toThrow("socket hang up");
    tracker.move = move;
    const writes = tracker.writes.length;
    expect(await apply()).toEqual({ result: "applied", writes: ["move"] });
    expect(tracker.writes.length).toBe(writes);
  });
});

describe("a pause retried after a lost response", () => {
  const PAUSE = "## Question\n\nWhich red: `danger` or `brand`?";
  const ANSWERS = [{ word: "danger", does: "plan uses the danger red", move: "ready_to_plan" as const }];
  const leavePause = () => leave(outbox.pause({ summary: "Which red should the Save button use?", pause: PAUSE, answers: ANSWERS, needs: "answer" }));

  test("finds the pause comment by its footer, doesn't post it twice, and keeps its time", async () => {
    await leavePause();
    const post = tracker.post.bind(tracker);
    tracker.post = async (...args) => {
      await post(...args);
      throw new Error("socket hang up");
    };
    await expect(apply()).rejects.toThrow("socket hang up");
    tracker.post = post;
    expect(await apply()).toMatchObject({ result: "paused", writes: ["post", "move", "pause"] });
    const comments = (await tracker.issue({ id: issue.id, repo })).comments;
    expect(comments).toHaveLength(1);
    expect((await state.issueMemory(repo.name, issue.id)).pause?.comment_at).toBe(comments[0]!.created_at);
  });

  test("keeps the pause pending until the move to Paused lands, as a hand run's retry needs", async () => {
    await leavePause();
    const move = tracker.move.bind(tracker);
    tracker.move = async () => {
      throw new Error("fetch failed");
    };
    await expect(apply()).rejects.toThrow("fetch failed");
    expect((await state.issueMemory(repo.name, issue.id)).pause).toMatchObject({ session: "abc123", pending: true });
    tracker.move = move;
    expect(await apply()).toMatchObject({ result: "paused", writes: ["move", "pause"] });
    expect((await state.issueMemory(repo.name, issue.id)).pause).toMatchObject({ session: "abc123", pending: false });
  });

  test.each(["pause comment's post", "pause step's issue read"] as const)("keeps a reply a poll saved while the %s was on its way", async (call) => {
    await leavePause();
    const saved = { id: "reply-1", author: "maintainer", created_at: "2026-11-10T09:00:01.000Z", body: "Which red is the brand one?", synced: false };
    const pollSavesReply = async () => {
      const memory = await state.issueMemory(repo.name, issue.id);
      if (memory.pause !== null) await state.writeIssueMemory(repo.name, issue.id, { ...memory, pause: { ...memory.pause, replies: [saved] } });
    };
    if (call === "pause comment's post") {
      const post = tracker.post.bind(tracker);
      tracker.post = async (...args) => {
        const posted = await post(...args);
        await pollSavesReply();
        return posted;
      };
    } else {
      // The first read is apply's own. The second is the pause step's.
      const read = tracker.issue.bind(tracker);
      let reads = 0;
      tracker.issue = async (ref) => {
        const got = await read(ref);
        if (++reads === 2) await pollSavesReply();
        return got;
      };
    }
    expect(await apply()).toMatchObject({ result: "paused" });
    expect((await state.issueMemory(repo.name, issue.id)).pause?.replies).toEqual([saved]);
  });

  test("a new handoff doesn't keep the answers of a pause an earlier session opened", async () => {
    const stale = { answers: [{ word: "brand", does: "plan uses the brand red", move: "ready_to_plan" as const }], session: "old111", pending: false };
    await state.writeIssueMemory(repo.name, issue.id, { brief: null, flag: null, pause: { ...stale, comment_at: "2026-11-09T09:00:00Z", replies: [] } });
    await leavePause();
    expect(await apply()).toMatchObject({ result: "paused", writes: ["post", "move", "pause"] });
    expect((await state.issueMemory(repo.name, issue.id)).pause).toMatchObject({ answers: ANSWERS, session: "abc123" });
  });

  test("after a move whose response was lost finds the issue in Paused and doesn't move it again", async () => {
    await leavePause();
    const move = tracker.move.bind(tracker);
    tracker.move = async (...args) => {
      await move(...args);
      throw new Error("socket hang up");
    };
    await expect(apply()).rejects.toThrow("socket hang up");
    tracker.move = move;
    const writes = tracker.writes.length;
    expect(await apply()).toMatchObject({ result: "paused", writes: ["move", "pause"] });
    expect(tracker.writes.length).toBe(writes);
    expect((await state.issueMemory(repo.name, issue.id)).pause?.answers).toEqual(ANSWERS);
  });
});

describe("a plan handoff", () => {
  test("on a paused issue writes nothing, though an answer may move it to Ready to build", async () => {
    tracker.setStatus(issue.id, STATUSES.paused[0]);
    await leave(outbox.brief({ summary: SUMMARY, brief: BRIEF, version: VERSION }));
    expect(await apply()).toEqual({ result: "failed", rule: "Lifecycle doesn't allow paused to ready_to_build", writes: [] });
    expect(tracker.writes).toEqual([]);
  });
});

describe("an issue in a status that maps to no role", () => {
  test("writes nothing", async () => {
    tracker.setStatus(issue.id, "Icebox");
    await leave(outbox.brief({ summary: SUMMARY, brief: BRIEF, version: VERSION }));
    expect(await apply()).toEqual({
      result: "failed",
      rule: "the issue's status maps to no role, so Lifecycle allows no move to ready_to_build",
      writes: [],
    });
    expect(tracker.writes).toEqual([]);
  });
});

describe("follow-up issues", () => {
  test("fail the outbox until the Outbox can file them, and nothing is written", async () => {
    await leave(outbox.brief({ summary: SUMMARY, brief: BRIEF, version: VERSION }));
    await mkdir(join(sessionFolder, "outbox", "follow-ups"));
    await writeFile(join(sessionFolder, "outbox", "follow-ups", "1.md"), "# Theme tokens drift\n\nThe theme has two greens.");
    expect(await apply()).toEqual({ result: "failed", rule: "the Outbox can't file follow-up issues yet", writes: [] });
    expect(tracker.writes).toEqual([]);
  });

  test("an empty follow-ups folder files nothing and fails nothing", async () => {
    await leave(outbox.brief({ summary: SUMMARY, brief: BRIEF, version: VERSION }));
    await mkdir(join(sessionFolder, "outbox", "follow-ups"));
    expect(await apply()).toEqual({ result: "applied", writes: ["writeBrief", "post", "move"] });
  });
});

describe("media", () => {
  test("fails the outbox until the Outbox can upload it, and nothing is written", async () => {
    await leave(outbox.brief({ summary: SUMMARY, brief: `${BRIEF}\n\n![Before](before.png)`, version: VERSION }));
    await mkdir(join(sessionFolder, "outbox", "media"));
    await writeFile(join(sessionFolder, "outbox", "media", "before.png"), "png");
    expect(await apply()).toEqual({ result: "failed", rule: "the Outbox can't upload media yet", writes: [] });
    expect(tracker.writes).toEqual([]);
  });

  test("an empty media folder, which prepare makes for every session, fails nothing", async () => {
    await leave(outbox.brief({ summary: SUMMARY, brief: BRIEF, version: VERSION }));
    await mkdir(join(sessionFolder, "outbox", "media"));
    expect(await apply()).toEqual({ result: "applied", writes: ["writeBrief", "post", "move"] });
  });

  test.each([
    ["brief.md", "a URL", "![Before](https://example.com/before.png)"],
    ["brief.md", "a path", "![Before](/Users/maintainer/before.png)"],
    ["brief.md", "a media file the folder doesn't hold", "![Before](before.png)"],
    ["brief.md", "a reference", "![Before][before]\n\n[before]: https://example.com/before.png"],
    ["brief.md", "an HTML tag", '<img src="https://example.com/before.png">'],
    ["summary.md", "a URL", "![Before](https://example.com/before.png)"],
  ])("%s that shows an image by %s fails the outbox, and nothing is written", async (name, _, image) => {
    const brief = name === "brief.md" ? `${BRIEF}\n\n${image}` : BRIEF;
    const summary = name === "summary.md" ? `${SUMMARY}\n\n${image}` : SUMMARY;
    await leave(outbox.brief({ summary, brief, version: VERSION }));
    expect(await apply()).toEqual({ result: "failed", rule: `${name} names an image, and the Outbox can't upload media yet`, writes: [] });
    expect(tracker.writes).toEqual([]);
  });

  test("image syntax in a code block or a code span passes", async () => {
    const brief = `${BRIEF}\n\n\`\`\`md\n![Before](before.png)\n\`\`\`\n\nThe docs write \`![alt](before.png)\`.`;
    await leave(outbox.brief({ summary: SUMMARY, brief, version: VERSION }));
    expect(await apply()).toEqual({ result: "applied", writes: ["writeBrief", "post", "move"] });
  });
});

describe("a brief with CRLF line ends", () => {
  const crlf = (text: string) => text.replaceAll("\n", "\r\n");

  test("with a Report fold line fails, and nothing is written", async () => {
    await leave(outbox.brief({ summary: SUMMARY, brief: crlf(`${BRIEF}\n\n+++ Report\n\nold\n\n+++`), version: VERSION }));
    expect(await apply()).toEqual({
      result: "failed",
      rule: "brief.md holds a Report fold line, which the next re-plan would take for the report",
      writes: [],
    });
    expect(tracker.writes).toEqual([]);
  });

  test("has its folds written as +++ in the description and flattened in the comment", async () => {
    const notes = "\n\n>>> Agent notes\n\nUse the shared token.\n\n>>>";
    await leave(outbox.brief({ summary: crlf(SUMMARY), brief: crlf(`${BRIEF}${notes}`), version: VERSION }));
    expect(await apply()).toEqual({ result: "applied", writes: ["writeBrief", "post", "move"] });
    const read = await tracker.issue({ id: issue.id, repo });
    expect(read.description.startsWith(`${BRIEF}\n\n+++ Agent notes\n\nUse the shared token.\n\n+++\n\n+++ Report`)).toBe(true);
    const comment = read.comments.at(-1)?.body ?? "";
    expect(comment).toContain(`+++ Details\n\n${BRIEF}\n\n#### Agent notes\n\nUse the shared token.\n\n`);
    expect(comment).not.toContain("\r");
  });
});

describe("a break in Key interfaces", () => {
  const withBullets = (bullets: string) => BRIEF.replace("## Key interfaces\n\nNone.", `## Key interfaces\n\n${bullets}`);

  test.each([
    "- `Button`: break, drops the color prop",
    "- `Button`: breaking, drops the color prop",
    "- `Button`: breaks callers that pass a color",
    "- `Button`: Break, drops the color prop",
    "- `Button`: **break**, drops the color prop",
    "* `Button`: break, drops the color prop",
    "1. `Button`: break, drops the color prop",
    "  - `Button`: break, drops the color prop",
    "- `Button` : break, drops the color prop",
    "- Button: break, drops the color prop",
    "- Breaks `Button`'s color prop",
  ])("isn't accepted, so %s fails the outbox and writes nothing", async (bullet) => {
    await leave(outbox.brief({ summary: SUMMARY, brief: withBullets(bullet), version: VERSION }));
    const result = await apply();
    expect(result.result).toBe("failed");
    expect(result.result === "failed" ? result.rule : "").toEndWith("that isn't marked (accepted)");
    expect(tracker.writes).toEqual([]);
  });

  test("isn't accepted in a brief with CRLF line ends", async () => {
    await leave(outbox.brief({ summary: SUMMARY, brief: withBullets("- `Button`: break, drops the color prop").replaceAll("\n", "\r\n"), version: VERSION }));
    expect((await apply()).result).toBe("failed");
  });

  test("after a code block holding a ## line still counts, because the code block ends no section", async () => {
    await leave(outbox.brief({ summary: SUMMARY, brief: withBullets("```\n## not a heading\n```\n\n- `Button`: break, drops the color prop"), version: VERSION }));
    expect((await apply()).result).toBe("failed");
  });

  test.each([
    ["marked (accepted)", "- `Button`: break (accepted), drops the color prop"],
    ["in a code block", "```\n- `Button`: break, drops the color prop\n```"],
    ["a seam whose words mention breaking", "- `castIdleVote()`: seam, breaks the loop when both speeds are 0"],
  ])("%s passes", async (_, bullets) => {
    await leave(outbox.brief({ summary: SUMMARY, brief: withBullets(bullets), version: VERSION }));
    expect(await apply()).toEqual({ result: "applied", writes: ["writeBrief", "post", "move"] });
  });
});

describe("an outbox file that isn't a regular file", () => {
  test.each(["outcome.json", "brief.md", "summary.md"])("%s as a symlink to a file outside the outbox writes nothing", async (name) => {
    const files = outbox.brief({ summary: SUMMARY, brief: BRIEF, version: VERSION });
    const secret = join(root, "secret.env");
    await writeFile(secret, files[name]!);
    delete files[name];
    await leave(files);
    await symlink(secret, join(sessionFolder, "outbox", name));
    expect(await apply()).toEqual({ result: "failed", rule: `${name} isn't a regular file`, writes: [] });
    expect(tracker.writes).toEqual([]);
  });

  test.each(["outcome.json", "brief.md", "summary.md"])("%s as a folder writes nothing", async (name) => {
    const files = outbox.brief({ summary: SUMMARY, brief: BRIEF, version: VERSION });
    delete files[name];
    await leave(files);
    await mkdir(join(sessionFolder, "outbox", name));
    expect(await apply()).toEqual({ result: "failed", rule: `${name} isn't a regular file`, writes: [] });
    expect(tracker.writes).toEqual([]);
  });
});

describe("a brief with a Python session in a fenced code block", () => {
  const session = ["```", ">>> import shaders", ">>> shaders.render(None)", "Traceback (most recent call last):", ">>> Report", ">>>", "```"].join("\n");
  const brief = BRIEF.replace("The Save button is blue.", `The Save button is blue:\n\n${session}`);

  test("keeps its >>> lines in the description and in the comment, and its >>> Report line passes", async () => {
    await leave(outbox.brief({ summary: SUMMARY, brief, version: VERSION }));
    expect(await apply()).toEqual({ result: "applied", writes: ["writeBrief", "post", "move"] });
    const read = await tracker.issue({ id: issue.id, repo });
    expect(read.description.startsWith(`${brief}\n\n+++ Report`)).toBe(true);
    expect(read.comments.at(-1)?.body).toContain(`+++ Details\n\n${brief}\n\n`);
  });
});
