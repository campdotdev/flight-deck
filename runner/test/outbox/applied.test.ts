// `applied.json`: the Outbox records each write as it lands, so a second `apply` on the same folder skips it
// (spec 1, "Writes, in order").
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Folders } from "../../src/folders/index.ts";
import { Outbox } from "../../src/outbox/index.ts";
import type { Role } from "../../src/record/index.ts";
import { State } from "../../src/state/index.ts";
import { InMemoryTracker, isUnavailable, type TrackerRepo } from "../../src/tracker/index.ts";

const STATUSES = {
  intake: "Triage",
  backlog: "Backlog",
  ready_to_plan: "Ready to plan",
  planning: "Planning",
  ready_to_build: "Ready to build",
  building: "Building",
  ready_to_check: "Ready to check",
  checking: "Checking",
  landed: "Landed",
  paused: "Paused",
  in_review: "In Review",
  done: "Done",
  canceled: "Canceled",
  duplicate: "Duplicate",
} satisfies Record<Role, string>;

const repo: TrackerRepo = { name: "campdotdev/shaders", workspace: "campdotdev", team: "SHA", statuses: STATUSES, maintainer: "maintainer" };
const now = new Date("2026-11-10T09:00:00Z");

let root: string;
let tracker: InMemoryTracker;
let outbox: Outbox;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "flight-deck-outbox-")));
  const folders: Folders = { data: join(root, "data"), config: join(root, "config"), sessionRoot: join(root, "sessions"), home: join(root, "home") };
  tracker = new InMemoryTracker({ clock: () => now, appUser: "app" });
  tracker.addUser({ id: "maintainer", name: "Hunter" });
  tracker.addTeam({ key: "SHA", name: "Shaders", statuses: Object.values(STATUSES).map((name) => ({ name, type: "started" })) });
  outbox = new Outbox({ version: "0.1.0", state: new State(folders), clock: () => now, repo: () => repo });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("a second apply on the same folder skips the writes the first recorded", async () => {
  const issue = tracker.addIssue({ team: "SHA", title: "Save button is blue", status: "Planning", creator: "maintainer" });
  const folder = join(root, "session");
  await mkdir(join(folder, "outbox"), { recursive: true });
  await writeFile(join(folder, "session.json"), JSON.stringify({ session: "abc123", repo: repo.name, issue: issue.identifier, stage: "plan" }));
  const answers = [{ word: "brand", does: "plan uses the brand red", move: "ready_to_plan" }];
  await writeFile(join(folder, "outbox", "outcome.json"), JSON.stringify({ version: "0.1.0", stage: "plan", move: "paused", answers, needs: "answer" }));
  await writeFile(join(folder, "outbox", "summary.md"), "Which red?");
  await writeFile(join(folder, "outbox", "pause.md"), "## Question\n\nWhich red?");

  tracker.refuse("move");
  const failed = await outbox.apply(folder, { identity: tracker }).catch((error: unknown) => error);
  expect(isUnavailable(failed)).toBe(true);
  expect(tracker.writes.map((write) => write.kind)).toEqual(["assign", "comment"]);

  expect(await outbox.apply(folder, { identity: tracker })).toEqual({ result: "paused", reason: "🟡 Needs your answer: Which red?", writes: ["move", "pause"] });
  expect(tracker.writes.map((write) => write.kind)).toEqual(["assign", "comment", "move"]);
});
