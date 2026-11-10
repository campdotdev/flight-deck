// `flight-deck apply [--dry-run] <folder>` (spec 1, "Hand runs"): a hand run's outbox, applied with the
// maintainer's setup key, makes the writes the runner would make, and the exit code says what happened.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunnerSocket } from "../../src/runner/index.ts";
import { TrackerRefused, type StoredIssue, type TrackerWrite } from "../../src/tracker/index.ts";
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

/** A brief with a Key interfaces section, for the rules that read it. */
const KEYED_BRIEF = "## Summary\n\nThe Save button turns red.\n\n## Key interfaces\n\nNone.\n\n## Context\n\n- Slots: none";
const KEYED_SUMMARY = "Brief ready: the Save button turns red\n\nIt takes the shared red.";

function briefWith(extra: Record<string, string> = {}, outcome: Record<string, unknown> = {}): Record<string, string> {
  return {
    "outcome.json": JSON.stringify({ version: "0.1.0", stage: "plan", move: "ready_to_build", ...outcome }),
    "summary.md": KEYED_SUMMARY,
    "brief.md": KEYED_BRIEF,
    ...extra,
  };
}

function duplicateOf(of: string, extra: Record<string, string> = {}): Record<string, string> {
  return { "outcome.json": JSON.stringify({ version: "0.1.0", stage: "plan", move: "duplicate", of }), "summary.md": KEYED_SUMMARY, ...extra };
}

describe("a hand run's refused outbox names the rule, and writes nothing", () => {
  test.each<[string, () => Record<string, string>, string]>([
    [
      "an unaccepted break",
      () => briefWith({ "brief.md": KEYED_BRIEF.replace("None.", "- `Button`: break, drops the color prop") }),
      "brief.md's Key interfaces lists a break of `Button` that isn't marked (accepted)",
    ],
    ["a second handoff file", () => briefWith({ "pause.md": "Which red?" }), "the outbox holds 2 handoff files: brief.md, pause.md"],
    ["a stray file", () => briefWith({ "notes.txt": "scratch" }), "notes.txt isn't part of the outbox's envelope"],
    ["a Report fold in brief.md", () => briefWith({ "brief.md": `${KEYED_BRIEF}\n\n+++ Report\n\nold\n\n+++` }), "brief.md holds a Report fold line, which the next re-plan would take for the report"],
    ["a >>> Report fold in brief.md", () => briefWith({ "brief.md": `${KEYED_BRIEF}\n\n>>> Report\n\nold\n\n>>>` }), "brief.md holds a Report fold line, which the next re-plan would take for the report"],
    ["an extra outcome.json key", () => briefWith({}, { of: "SHA-9" }), "outcome.json holds of, which a move to ready_to_build doesn't take"],
    ["a duplicate with a handoff file", () => duplicateOf("SHA-2", { "brief.md": KEYED_BRIEF }), "a move to duplicate holds no handoff file, but the outbox holds brief.md"],
    ["a duplicate with no of", () => ({ "outcome.json": JSON.stringify({ version: "0.1.0", stage: "plan", move: "duplicate" }) }), "a move to duplicate needs of, an issue identifier"],
    ["an image not in media/", () => briefWith({ "brief.md": `${KEYED_BRIEF}\n\n![Before](before.png)` }), "brief.md names the image before.png, which media/ doesn't hold"],
    [
      "an image URL",
      () => briefWith({ "summary.md": `${KEYED_SUMMARY}\n\n![Before](https://uploads.linear.app/x/before.png)` }),
      "summary.md names the image https://uploads.linear.app/x/before.png, which isn't a bare file name in media/",
    ],
    ["a follow-up's file name", () => briefWith({ "follow-ups/one.md": "# One\n\nx" }), "follow-ups/one.md isn't named follow-ups/<n>.md"],
    ["a follow-up with no title", () => briefWith({ "follow-ups/1.md": "One\n\nx" }), "follow-ups/1.md doesn't open with # <title>"],
  ])("%s", async (_, files, rule) => {
    await world.tick();
    const issue = world.issue({ title: "Save button is blue", description: REPORT });
    const folder = await handRun(issue, files());
    const before = world.tracker.writes.length;
    const command = cli(world);
    expect(await command.run("apply", folder)).toBe(1);
    expect(command.err).toEqual([`Refused: ${rule}`]);
    expect(world.tracker.writes.length).toBe(before);
  });

  test.each<[string, (issue: StoredIssue) => string, (of: string) => string]>([
    [
      "a closed issue",
      () => world.issue({ title: "Old", status: STATUSES.done[0] }).identifier,
      (of) => `outcome.json's of ${of} is in Done, which isn't open`,
    ],
    ["the issue itself", (issue) => issue.identifier, (of) => `outcome.json's of ${of} is the issue itself`],
    ["an unknown issue", () => "SHA-99", (of) => `outcome.json's of ${of} names no issue Flight Deck can read`],
    [
      "another team's issue",
      () => {
        world.tracker.addTeam({ key: "OTH", name: "Other", statuses: [{ name: "Todo", type: "unstarted" }] });
        return world.tracker.addIssue({ team: "OTH", title: "Elsewhere", status: "Todo", creator: world.maintainer.id }).identifier;
      },
      (of) => `outcome.json's of ${of} is on team OTH, not SHA`,
    ],
  ])("a duplicate of %s", async (_, original, rule) => {
    await world.tick();
    const issue = world.issue({ title: "Save button is blue", description: REPORT });
    const of = original(issue);
    const folder = await handRun(issue, duplicateOf(of));
    const command = cli(world);
    expect(await command.run("apply", folder)).toBe(1);
    expect(command.err).toEqual([`Refused: ${rule(of)}`]);
  });
});

describe("a hand run's comment", () => {
  test("turns fold lines inside the handoff file into #### headings in the Details fold", async () => {
    await world.tick();
    const issue = world.issue({ title: "Save button is blue", description: REPORT });
    const pause = "## Question\n\nWhich red?\n\n+++ Proof\n\nThe log.\n\n+++\n\n>>> More\n\nText.\n\n>>>";
    const folder = await handRun(issue, {
      "outcome.json": JSON.stringify({ version: "0.1.0", stage: "plan", move: "paused", answers: [], needs: "help" }),
      "summary.md": "Which red?\n\nThere are two.",
      "pause.md": pause,
    });
    expect(await cli(world).run("apply", folder)).toBe(0);
    expect(writesOn(issue).find((write) => (write as TrackerWrite).kind === "comment")).toEqual({
      kind: "comment",
      issue: "<issue>",
      body: "🟡 Needs your help: Which red?\n\nThere are two.\n\n+++ Details\n\n## Question\n\nWhich red?\n\n#### Proof\n\nThe log.\n\n#### More\n\nText.\n\nFlight Deck 0.1.0 · plan · session <id>\n\n+++",
    });
  });
});

describe("a hand run's second apply on the same folder", () => {
  test("skips the writes that landed, uploads nothing again, and relates the follow-up it filed", async () => {
    await world.tick();
    const issue = world.issue({ title: "Save button is blue", description: REPORT });
    const folder = await handRun(issue, { ...briefWith({ "brief.md": `${KEYED_BRIEF}\n\n![Before](before.png)`, "follow-ups/1.md": "# Cancel is blue too\n\nx" }), "media/before.png": "png" });
    world.tracker.refuse("relate");
    const first = cli(world);
    expect(await first.run("apply", folder)).toBe(75);
    expect(first.out).toEqual(["Wrote upload before.png.", "Wrote writeBrief.", "Wrote post.", "Wrote move.", "Wrote file follow-ups/1.md."]);
    const landed = world.tracker.writes.length;
    const followUp = world.tracker.writes.find((write) => write.kind === "file") as { issue: string };

    const rerun = cli(world);
    expect(await rerun.run("apply", folder)).toBe(0);
    expect(rerun.out).toEqual(["Wrote relate follow-ups/1.md.", `Applied: ${issue.identifier} moved to Ready to build.`]);
    expect(world.tracker.writes.slice(landed)).toEqual([{ kind: "relate", issue: followUp.issue, other: issue.identifier, relation: "related" }]);
  });

  test("a write Linear refused exits 1 with Linear's reason, after the writes that landed", async () => {
    await world.tick();
    const issue = world.issue({ title: "Save button is blue", description: REPORT });
    const folder = await handRun(issue, briefWith());
    const maintainer = world.tracker.as(world.maintainer.id);
    maintainer.post = async () => {
      throw new TrackerRefused("Linear refused the call: body is too long");
    };
    const command = cli(world, { maintainerTracker: () => maintainer });
    expect(await command.run("apply", folder)).toBe(1);
    expect(command.out).toEqual(["Wrote writeBrief."]);
    expect(command.err).toEqual(["Refused: Linear refused post: Linear refused the call: body is too long"]);
  });

  test("--dry-run lists the uploads and the follow-ups' writes too", async () => {
    await world.tick();
    const issue = world.issue({ title: "Save button is blue", description: REPORT });
    const folder = await handRun(issue, { ...briefWith({ "brief.md": `${KEYED_BRIEF}\n\n![Before](before.png)`, "follow-ups/1.md": "# Cancel\n\nx" }), "media/before.png": "png" });
    const before = world.tracker.writes.length;
    const command = cli(world);
    expect(await command.run("apply", "--dry-run", folder)).toBe(0);
    expect(command.out).toEqual([
      "Would write upload before.png.",
      "Would write writeBrief.",
      "Would write post.",
      "Would write move.",
      "Would write file follow-ups/1.md.",
      "Would write relate follow-ups/1.md.",
      "Dry run: no write made.",
    ]);
    expect(world.tracker.writes.length).toBe(before);
  });
});
