// Outbox.apply at its own interface: the rule a refused outbox names, which a scenario sees only once a
// second failed session posts it (FLD-98), and a second apply on the same folder.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Outbox } from "../../src/outbox/index.ts";
import type { Role } from "../../src/record/index.ts";
import { State } from "../../src/state/index.ts";
import { InMemoryTracker, type IssueRef, type RelationKind, type StatusType, type StoredIssue, type TrackerRepo } from "../../src/tracker/index.ts";

const STATUSES: Record<Role, [string, StatusType]> = {
  intake: ["Triage", "triage"],
  backlog: ["Backlog", "backlog"],
  ready_to_plan: ["Ready to plan", "unstarted"],
  planning: ["Planning", "started"],
  ready_to_build: ["Ready to build", "unstarted"],
  building: ["Building", "started"],
  ready_to_check: ["Ready to check", "unstarted"],
  checking: ["Checking", "started"],
  landed: ["Landed", "started"],
  paused: ["Paused", "started"],
  in_review: ["In Review", "started"],
  done: ["Done", "completed"],
  canceled: ["Canceled", "canceled"],
  duplicate: ["Duplicate", "duplicate"],
};

const repo: TrackerRepo = {
  name: "campdotdev/shaders",
  workspace: "campdotdev",
  team: "SHA",
  statuses: Object.fromEntries(Object.entries(STATUSES).map(([role, [name]]) => [role, name])) as Record<Role, string>,
  maintainer: "maintainer",
};

const BRIEF = "## Summary\n\nThe Save button turns red.\n\n## Key interfaces\n\nNone.\n\n## Context\n\n- Slots: none";
const SUMMARY = "Brief ready: the Save button turns red\n\nIt takes the shared red.";
const VERSION = "0.1.0";

/** A Tracker whose first `relate` fails, as a lost connection would. */
class FlakyTracker extends InMemoryTracker {
  failRelate = true;
  override async relate(issue: IssueRef, other: IssueRef, kind: RelationKind): Promise<void> {
    if (this.failRelate) {
      this.failRelate = false;
      throw new Error("socket hang up");
    }
    return super.relate(issue, other, kind);
  }
}

let root: string;
let tracker: FlakyTracker;
let issue: StoredIssue;
let outbox: Outbox;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "flight-deck-outbox-")));
  const now = new Date("2026-11-10T09:00:00Z");
  tracker = new FlakyTracker({ clock: () => now, appUser: "app" });
  tracker.addUser({ id: "maintainer", name: "Hunter" });
  tracker.addTeam({ key: "SHA", name: "Shaders", statuses: Object.values(STATUSES).map(([name, type]) => ({ name, type })) });
  issue = tracker.addIssue({ team: "SHA", title: "Save button is blue", description: "It should be red.", status: "Planning", creator: "maintainer" });
  const state = new State({ data: join(root, "data"), config: join(root, "config"), sessionRoot: join(root, "sessions"), home: root });
  outbox = new Outbox({ version: VERSION, state, clock: () => now, repo: () => repo });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A session folder whose outbox holds the files. */
async function session(files: Record<string, string>): Promise<string> {
  const folder = join(root, "sessions", "abc123");
  const sessionJson = { version: VERSION, session: "abc123", stage: "plan", repo: repo.name, issue: issue.identifier };
  for (const [path, text] of Object.entries({ "session.json": JSON.stringify(sessionJson), ...Object.fromEntries(Object.entries(files).map(([name, text]) => [`outbox/${name}`, text])) })) {
    await mkdir(dirname(join(folder, path)), { recursive: true });
    await writeFile(join(folder, path), text);
  }
  await mkdir(join(folder, "outbox"), { recursive: true });
  return folder;
}

function brief(extra: Record<string, string> = {}, outcome: Record<string, unknown> = {}): Record<string, string> {
  return {
    "outcome.json": JSON.stringify({ version: VERSION, stage: "plan", move: "ready_to_build", ...outcome }),
    "summary.md": SUMMARY,
    "brief.md": BRIEF,
    ...extra,
  };
}

function duplicate(of: string, extra: Record<string, string> = {}): Record<string, string> {
  return { "outcome.json": JSON.stringify({ version: VERSION, stage: "plan", move: "duplicate", of }), "summary.md": SUMMARY, ...extra };
}

describe("a refused outbox names the rule", () => {
  test.each<[string, () => Record<string, string>, string]>([
    [
      "an unaccepted break",
      () => brief({ "brief.md": BRIEF.replace("None.", "- `Button`: break, drops the color prop") }),
      "brief.md's Key interfaces lists a break of `Button` that isn't marked (accepted)",
    ],
    ["a second handoff file", () => brief({ "pause.md": "Which red?" }), "the outbox holds 2 handoff files: brief.md, pause.md"],
    ["a stray file", () => brief({ "notes.txt": "scratch" }), "notes.txt isn't part of the outbox's envelope"],
    ["a Report fold in brief.md", () => brief({ "brief.md": `${BRIEF}\n\n+++ Report\n\nold\n\n+++` }), "brief.md holds a Report fold line, which the next re-plan would take for the report"],
    ["a >>> Report fold in brief.md", () => brief({ "brief.md": `${BRIEF}\n\n>>> Report\n\nold\n\n>>>` }), "brief.md holds a Report fold line, which the next re-plan would take for the report"],
    ["an extra outcome.json key", () => brief({}, { of: "SHA-9" }), "outcome.json holds of, which a move to ready_to_build doesn't take"],
    ["a duplicate with a handoff file", () => duplicate("SHA-2", { "brief.md": BRIEF }), "a move to duplicate holds no handoff file, but the outbox holds brief.md"],
    ["a duplicate with no of", () => ({ "outcome.json": JSON.stringify({ version: VERSION, stage: "plan", move: "duplicate" }) }), "a move to duplicate needs of, an issue identifier"],
    ["an image not in media/", () => brief({ "brief.md": `${BRIEF}\n\n![Before](before.png)` }), "brief.md names the image before.png, which media/ doesn't hold"],
    [
      "an image URL",
      () => brief({ "summary.md": `${SUMMARY}\n\n![Before](https://uploads.linear.app/x/before.png)` }),
      "summary.md names the image https://uploads.linear.app/x/before.png, which isn't a bare file name in media/",
    ],
    ["a follow-up's file name", () => brief({ "follow-ups/one.md": "# One\n\nx" }), "follow-ups/one.md isn't named follow-ups/<n>.md"],
    ["a follow-up with no title", () => brief({ "follow-ups/1.md": "One\n\nx" }), "follow-ups/1.md doesn't open with # <title>"],
  ])("%s", async (_, files, rule) => {
    const result = await outbox.apply(await session(files()), { identity: tracker });
    expect(result).toEqual({ result: "failed", rule, writes: [] });
    expect(tracker.writes).toEqual([]);
  });

  test.each<[string, () => string, string]>([
    ["a closed issue", () => tracker.addIssue({ team: "SHA", title: "Old", status: "Done", creator: "maintainer" }).identifier, "outcome.json's of SHA-2 is in Done, which isn't open"],
    ["the issue itself", () => issue.identifier, "outcome.json's of SHA-1 is the issue itself"],
    ["an unknown issue", () => "SHA-99", "outcome.json's of SHA-99 names no issue Flight Deck can read"],
    [
      "another team's issue",
      () => {
        tracker.addTeam({ key: "OTH", name: "Other", statuses: [{ name: "Todo", type: "unstarted" }] });
        return tracker.addIssue({ team: "OTH", title: "Elsewhere", status: "Todo", creator: "maintainer" }).identifier;
      },
      "outcome.json's of OTH-1 is on team OTH, not SHA",
    ],
  ])("a duplicate of %s", async (_, of, rule) => {
    const result = await outbox.apply(await session(duplicate(of())), { identity: tracker });
    expect(result).toEqual({ result: "failed", rule, writes: [] });
  });
});

describe("the Details fold", () => {
  test("turns fold lines inside the handoff file into #### headings", async () => {
    const pause = "## Question\n\nWhich red?\n\n+++ Proof\n\nThe log.\n\n+++\n\n>>> More\n\nText.\n\n>>>";
    const files = {
      "outcome.json": JSON.stringify({ version: VERSION, stage: "plan", move: "paused", answers: [], needs: "help" }),
      "summary.md": "Which red?\n\nThere are two.",
      "pause.md": pause,
    };
    await outbox.apply(await session(files), { identity: tracker });
    const comment = tracker.writes.find((write) => write.kind === "comment");
    expect(comment?.kind === "comment" && comment.body).toBe(
      `🟡 Needs your help: Which red?\n\nThere are two.\n\n+++ Details\n\n## Question\n\nWhich red?\n\n#### Proof\n\nThe log.\n\n#### More\n\nText.\n\nFlight Deck ${VERSION} · plan · session abc123\n\n+++`,
    );
  });
});

describe("a second apply on the same folder", () => {
  test("skips the writes that landed, uploads nothing again, and relates the follow-up it filed", async () => {
    const folder = await session(brief({ "brief.md": `${BRIEF}\n\n![Before](before.png)`, "follow-ups/1.md": "# Cancel is blue too\n\nx" }));
    await mkdir(join(folder, "outbox", "media"));
    await writeFile(join(folder, "outbox", "media", "before.png"), "png");
    await expect(outbox.apply(folder, { identity: tracker })).rejects.toThrow("socket hang up");
    const landed = tracker.writes.map((write) => write.kind);
    expect(landed).toEqual(["upload", "description", "unsubscribe", "comment", "move", "file"]);

    const result = await outbox.apply(folder, { identity: tracker });
    expect(result).toEqual({ result: "applied", writes: ["relate follow-ups/1.md"] });
    expect(tracker.writes.slice(landed.length)).toEqual([{ kind: "relate", issue: "SHA-2", other: issue.identifier, relation: "related" }]);
  });

  test("after a write Linear didn't take returns unwritten with the writes that landed, then finishes the rest", async () => {
    const folder = await session(brief());
    tracker.refuse("post", { reason: "rate_limited" });
    expect(await outbox.apply(folder, { identity: tracker })).toEqual({ result: "unwritten", writes: ["writeBrief"] });
    expect(await outbox.apply(folder, { identity: tracker })).toEqual({ result: "applied", writes: ["post", "move"] });
    expect(tracker.writes.map((write) => write.kind)).toEqual(["description", "unsubscribe", "comment", "move"]);
  });

  test("a dry run makes no write and lists each one", async () => {
    const folder = await session(brief({ "brief.md": `${BRIEF}\n\n![Before](before.png)`, "follow-ups/1.md": "# Cancel\n\nx", "media/before.png": "png" }));
    const result = await outbox.apply(folder, { identity: tracker, dryRun: true });
    expect(result).toEqual({
      result: "applied",
      writes: ["upload before.png", "writeBrief", "post", "move", "file follow-ups/1.md", "relate follow-ups/1.md"],
    });
    expect(tracker.writes).toEqual([]);
  });
});
