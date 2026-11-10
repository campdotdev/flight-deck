// `flight-deck apply [--dry-run] <folder>` (spec 1, "Hand runs"): a hand run's outbox, applied with the
// maintainer's setup key, makes the writes the runner would make, and the exit code says what happened.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunnerSocket } from "../../src/runner/index.ts";
import type { StoredIssue, TrackerWrite } from "../../src/tracker/index.ts";
import { outbox, STATUSES, World } from "../scenario/world.ts";
import { cli, listen } from "./cli.ts";

let world: World;
let socket: RunnerSocket | null;

beforeEach(async () => {
  world = await World.create();
  socket = null;
});

afterEach(async () => {
  await socket?.close();
  await world.cleanup();
});

const REPORT = "The Save button is blue on the settings page.\n\nIt should be red.";
const BRIEF = outbox.brief({ summary: "Brief ready: the Save button turns red\n\nIt takes the shared red.", brief: "## Summary\n\nThe Save button turns red.\n" });
const PAUSE = outbox.pause({
  summary: "Which red?\n\nTwo reds fit.",
  pause: "## Question\n\nWhich red?\n",
  answers: [{ word: "brand", does: "Use the brand red", move: "ready_to_plan" }],
  needs: "answer",
});

/**
 * A hand run's session folder, as `plugin/shared/session.md` makes it: under `hand-runs/`, with its `session.json`
 * and `outbox/`, after the maintainer took the issue by hand.
 */
async function handRun(issue: StoredIssue, files: Record<string, string>, session = "hnd001"): Promise<string> {
  world.tracker.setStatus(issue.id, STATUSES.planning[0]);
  const folder = join(world.folders.data, "hand-runs", `${issue.identifier}-20261110T090000Z`);
  const sessionJson = { version: world.version, session, stage: "plan", mode: "issue", repo: world.repo, issue: issue.identifier, team: "SHA", maintainer: world.maintainer };
  const all = { "session.json": JSON.stringify(sessionJson), ...Object.fromEntries(Object.entries(files).map(([name, text]) => [`outbox/${name}`, text])) };
  for (const [path, text] of Object.entries(all)) {
    await mkdir(dirname(join(folder, path)), { recursive: true });
    await writeFile(join(folder, path), text);
  }
  return folder;
}

/** The writes on one issue, with its identifier and the session IDs taken out, so two issues' writes compare. */
function writesOn(issue: StoredIssue, from = 0): unknown[] {
  return world.tracker.writes
    .slice(from)
    .filter((write): write is TrackerWrite & { issue: string } => "issue" in write && write.issue === issue.identifier)
    .map((write) => JSON.parse(JSON.stringify(write).replaceAll(issue.identifier, "<issue>").replace(/session [a-z0-9]{6}/g, "session <id>")));
}

describe("a hand run's apply", () => {
  test("makes the writes the runner makes for the same outbox, as the maintainer, with their setup key", async () => {
    // The runner's session on one issue.
    const factory = world.issue({ title: "Save button is blue", description: REPORT });
    world.send(factory);
    world.harness.script(factory.identifier, { outbox: BRIEF });
    await world.tick();
    world.reply(factory, "Thanks.");
    const taken = world.tracker.writes.length;
    world.harness.finish(world.harness.started[0]!.session.id, { kind: "exited", code: 0 });
    await world.tick();
    const runnerWrites = writesOn(factory, taken);
    expect(runnerWrites.map((write) => (write as TrackerWrite).kind)).toEqual(["description", "unsubscribe", "comment", "move"]);

    // A hand run on another, with the same outbox.
    const hand = world.issue({ title: "Save button is blue", description: REPORT });
    const folder = await handRun(hand, BRIEF);
    const keys: unknown[] = [];
    const command = cli(world, {
      maintainerTracker: (input) => {
        keys.push({ workspace: input.workspace, setupKey: input.setupKey });
        return world.tracker.as(world.maintainer.id);
      },
    });
    const before = world.tracker.writes.length;
    expect(await command.run("apply", folder)).toBe(0);

    expect(keys).toEqual([{ workspace: "campdotdev", setupKey: "test-setup_key" }]);
    expect(writesOn(hand, before)).toEqual(runnerWrites);
    expect(world.tracker.stored(hand.id).status).toBe("Ready to build");
    expect(command.out).toEqual(["Wrote writeBrief.", "Wrote post.", "Wrote move.", `Applied: ${hand.identifier} moved to Ready to build.`]);
  });

  test("refuses an outbox from another version with exit 2, before any write", async () => {
    await world.tick();
    const issue = world.issue({ title: "Save button is blue", description: REPORT });
    const folder = await handRun(issue, outbox.brief({ summary: "Brief ready", brief: "## Summary\n\nRed.\n", version: "0.0.9" }));
    const before = world.tracker.writes.length;
    const command = cli(world);
    expect(await command.run("apply", folder)).toBe(2);
    expect(command.err).toEqual([
      `Refused: Flight Deck 0.0.9 wrote this outbox, and this is Flight Deck ${world.version}. Run the hand run again with Flight Deck ${world.version}.`,
    ]);
    expect(world.tracker.writes.length).toBe(before);
  });

  test("refuses a repo this Mac hasn't registered with exit 2", async () => {
    await world.tick();
    const issue = world.issue({ title: "Save button is blue" });
    const folder = await handRun(issue, BRIEF);
    await writeFile(join(folder, "session.json"), JSON.stringify({ version: world.version, session: "hnd001", stage: "plan", mode: "issue", repo: "campdotdev/other", issue: issue.identifier }));
    const command = cli(world);
    expect(await command.run("apply", folder)).toBe(2);
    expect(command.err).toEqual(["Refused: campdotdev/other isn't registered on this Mac. Run flight-deck register campdotdev/other first."]);
  });

  test("refuses with exit 2 when the default branch holds no valid record", async () => {
    await world.push({ ".flight-deck/record.toml": "schema = 1\n" });
    await world.tick();
    const issue = world.issue({ title: "Save button is blue" });
    const folder = await handRun(issue, BRIEF);
    const before = world.tracker.writes.length;
    const command = cli(world);
    expect(await command.run("apply", folder)).toBe(2);
    expect(command.err).toHaveLength(1);
    expect(command.err[0]).toStartWith(`Refused: the record on main isn't valid: `);
    expect(world.tracker.writes.length).toBe(before);
  });

  test("refuses with exit 2 before the runner has fetched the repo", async () => {
    // A World with a cache has fetched the clone already.
    await world.cleanup();
    world = await World.create({ cache: false });
    const issue = world.issue({ title: "Save button is blue" });
    const folder = await handRun(issue, BRIEF);
    const command = cli(world);
    expect(await command.run("apply", folder)).toBe(2);
    expect(command.err).toEqual([`Refused: Flight Deck has no clone of ${world.repo} yet, so it can't read the record. Wait for the runner's next poll.`]);
  });

  test("exits 1 with the rule an outbox breaks", async () => {
    await world.tick();
    const issue = world.issue({ title: "Save button is blue" });
    const { "brief.md": _, ...noBrief } = BRIEF;
    const folder = await handRun(issue, noBrief);
    const command = cli(world);
    expect(await command.run("apply", folder)).toBe(1);
    expect(command.err).toHaveLength(1);
    expect(command.err[0]).toStartWith("Refused: ");
    expect(world.tracker.stored(issue.id).status).toBe("Planning");
  });

  test("exits 75 when Linear doesn't take a write, and a rerun skips the writes already made", async () => {
    await world.tick();
    const issue = world.issue({ title: "Save button is blue", description: REPORT });
    const folder = await handRun(issue, BRIEF);
    world.tracker.refuse("move");
    const command = cli(world);
    const before = world.tracker.writes.length;
    expect(await command.run("apply", folder)).toBe(75);
    expect(command.out).toEqual(["Wrote writeBrief.", "Wrote post."]);
    expect(command.err).toEqual([`Linear didn't take a write. Run flight-deck apply ${folder} again: it skips the writes already made.`]);

    const rerun = cli(world);
    expect(await rerun.run("apply", folder)).toBe(0);
    expect(rerun.out).toEqual(["Wrote move.", `Applied: ${issue.identifier} moved to Ready to build.`]);
    expect(writesOn(issue, before).map((write) => (write as TrackerWrite).kind)).toEqual(["description", "unsubscribe", "comment", "move"]);
  });

  test("--dry-run prints each write and makes none", async () => {
    await world.tick();
    const issue = world.issue({ title: "Save button is blue", description: REPORT });
    const folder = await handRun(issue, BRIEF);
    const before = world.tracker.writes.length;
    const command = cli(world);
    expect(await command.run("apply", "--dry-run", folder)).toBe(0);
    expect(command.out).toEqual(["Would write writeBrief.", "Would write post.", "Would write move.", "Dry run: no write made."]);
    expect(world.tracker.writes.length).toBe(before);
    expect(world.tracker.stored(issue.id).status).toBe("Planning");
  });
});

describe("a hand run's pause", () => {
  for (const runner of ["answers", "doesn't answer"] as const) {
    test(`writes issue memory, so the maintainer's one-word answer moves the issue, when the runner ${runner}`, async () => {
      await world.tick();
      if (runner === "answers") socket = await listen(world);
      const issue = world.issue({ title: "Save button is blue", description: REPORT });
      const folder = await handRun(issue, PAUSE);
      const command = cli(world);
      expect(await command.run("apply", folder)).toBe(0);
      expect(command.out.at(-1)).toBe("Paused: 🟡 Needs your answer: Which red?");
      expect(world.tracker.stored(issue.id).status).toBe("Paused");

      await world.tick();
      expect((await world.status()).flags).toMatchObject([{ issue: issue.identifier, status_line: "🟡 Needs your answer: Which red?" }]);
      world.reply(issue, "Brand.");
      await world.tick();
      expect(world.tracker.stored(issue.id).status).toBe("Ready to plan");
    });
  }
});
