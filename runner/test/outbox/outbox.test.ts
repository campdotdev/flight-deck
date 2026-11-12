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
const BRIEF = "## Problem\n\nThe Save button is blue.\n\n## Key interfaces\n\nNone.";

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
  const box = new Outbox({ version: VERSION, state: new State(folders), repo: () => repo });
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
