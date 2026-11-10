// Each session reads the record at the commit it starts from. A missing, invalid, or too-new record pauses the
// issue at the take, and a valid record's slot skills reach the session as `SKILL.md` paths (spec 1's
// "Starts" and "The runner's own comments", ADRs 0003, 0014, 0015, and 0017).
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { StoredIssue, TrackerWrite } from "../../src/tracker/index.ts";
import { outbox, SHADERS_RECORD, World } from "./world.ts";

let world: World;

afterEach(async () => {
  await world.cleanup();
});

const RECORD = ".flight-deck/record.toml";

/** The writes after the issue's last move to Planning. */
function afterTake(issue: StoredIssue) {
  const writes = world.tracker.writes;
  const take = writes.findLastIndex((write) => write.kind === "move" && write.issue === issue.identifier && write.status === "Planning");
  return writes.slice(take + 1);
}

/** A pause comment the runner wrote, with the record pauses' `retry` answer. */
function pauseComment(statusLine: string, sentences: string, fold: string[] = []): string {
  return [
    statusLine,
    "",
    sentences,
    "",
    "Reply with one word:",
    "",
    "- **retry**: plan reads the record again and runs. Moves the issue to Ready to plan.",
    "",
    "Any other reply leaves the issue paused until you move it.",
    "",
    "+++ Details",
    "",
    ...(fold.length === 0 ? [] : [...fold, ""]),
    `Flight Deck ${world.version} · runner`,
    "",
    "+++",
  ].join("\n");
}

/** The writes a record pause makes after the take: the flag, the comment, the move. */
function pauseWrites(issue: StoredIssue, body: string): TrackerWrite[] {
  return [
    { kind: "assign", issue: issue.identifier, user: world.maintainer.id },
    { kind: "comment", issue: issue.identifier, body },
    { kind: "move", issue: issue.identifier, status: "Paused" },
  ];
}

async function recordState(): Promise<string> {
  return (await world.status()).repos[0]!.record;
}

describe("a repo with no record on its default branch", () => {
  test("finds its team through the registration's copy, and pauses the sent issue at the take with no session", async () => {
    world = await World.create({ record: null });
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    await world.tick();

    const statusLine = "🟡 Needs your help: this repo has no Flight Deck record yet";
    const body = pauseComment(
      statusLine,
      "Plan reads the repo's record from `.flight-deck/record.toml` on `main`, and `main` has none. Run `/flight-setup` in the repo, then merge the record it writes to `main`.",
    );
    expect(world.tracker.writes.filter((write) => "issue" in write && write.issue === issue.identifier)).toEqual([
      { kind: "unsubscribe", issue: issue.identifier, user: world.maintainer.id },
      { kind: "move", issue: issue.identifier, status: "Planning" },
      ...pauseWrites(issue, body),
    ]);
    expect(world.harness.started).toEqual([]);
    const status = await world.status();
    expect(status.repos[0]!.record).toBe("waiting");
    expect(status.sessions).toEqual([]);
    expect(status.flags.map((flag) => flag.status_line)).toEqual([statusLine]);
  });

  test("its retry, once the record is merged, takes the issue again with the stage's first attempt", async () => {
    world = await World.create({ record: null });
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Paused");

    await world.push({ [RECORD]: SHADERS_RECORD });
    world.reply(issue, "retry");
    world.harness.script(issue.identifier, {});
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Ready to plan");
    await world.tick();
    expect(world.harness.started).toHaveLength(1);
    expect(world.harness.started[0]!.sessionJson.attempt).toBe(1);
    expect(world.tracker.stored(issue.id).status).toBe("Planning");
    expect(await recordState()).toBe("ok");
  });
});

/** Shaders' record with one piece of text swapped for another. */
function edited(from: string, to: string): string {
  if (!SHADERS_RECORD.includes(from)) throw new Error(`Shaders' record has no ${from}`);
  return SHADERS_RECORD.replace(from, to);
}

const REPRODUCE = 'plan = { reproduce = ["reproducing-bugs"], design = [] }';

/** Sends a new issue and runs the take. */
async function sendAndTake(): Promise<StoredIssue> {
  const issue = world.issue({ title: "Save button is blue" });
  world.send(issue);
  await world.tick();
  return issue;
}

describe("an invalid record", () => {
  test("pauses at the take, quotes the first error, and lists the rest under Details", async () => {
    let record = edited('category = "types"', 'category = "typing"');
    record = record.replace('plan = "30m"', 'plan = "soon"');
    record = record.replace('build = "90m"', 'build = "later"');
    world = await World.create({ record });
    const issue = await sendAndTake();

    const body = pauseComment(
      "🟡 Needs your help: this repo's Flight Deck record has an error",
      [
        "Plan can't run, because the record at `.flight-deck/record.toml` on `main` has an error:",
        "",
        "```text",
        "commands[1].category: must be one of types, lint, format, unit, integration, e2e",
        "```",
        "",
        "Fix the record on `main`. Its other 2 errors are under Details.",
      ].join("\n"),
      ["The record's other errors:", "", "```text", 'time_limits.plan: must be a duration such as "30m" or "1h30m"', 'time_limits.build: must be a duration such as "30m" or "1h30m"', "```"],
    );
    expect(afterTake(issue)).toEqual(pauseWrites(issue, body));
    expect(world.harness.started).toEqual([]);
    expect(await recordState()).toBe("invalid");
  });

  test("with one error says so, and its fold holds only the footer", async () => {
    world = await World.create({ record: SHADERS_RECORD.replace('plan = "30m"', 'plan = "soon"') });
    const issue = await sendAndTake();
    const comment = afterTake(issue).find((write) => write.kind === "comment");
    if (comment?.kind !== "comment") throw new Error("no comment");
    expect(comment.body).toContain('```text\ntime_limits.plan: must be a duration such as "30m" or "1h30m"\n```\n\nFix the record on `main`.\n\nReply with one word:');
    expect(comment.body).toEndWith(`+++ Details\n\nFlight Deck ${world.version} · runner\n\n+++`);
  });

  test("its retry, with nothing fixed, pauses the issue again at the next take", async () => {
    world = await World.create({ record: SHADERS_RECORD.replace('plan = "30m"', 'plan = "soon"') });
    const issue = await sendAndTake();
    world.reply(issue, "retry");
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Ready to plan");
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Paused");
    expect(world.tracker.writes.filter((write) => write.kind === "comment")).toHaveLength(2);
    expect(world.harness.started).toEqual([]);
  });
});

describe("a record newer than the runner", () => {
  test("pauses at the take, names both schemas, and asks for flight-deck update", async () => {
    world = await World.create({ record: SHADERS_RECORD.replace("schema = 1", "schema = 2") });
    const issue = await sendAndTake();
    const body = pauseComment(
      "🟡 Needs your help: this repo's record needs a newer Flight Deck",
      `The record on \`main\` has schema 2, and Flight Deck ${world.version} reads only schema 1. Run \`flight-deck update\` on the Mac to install a version that reads it.`,
    );
    expect(afterTake(issue)).toEqual(pauseWrites(issue, body));
    expect(world.harness.started).toEqual([]);
    expect(await recordState()).toBe("newer");
  });
});

describe("slot entries", () => {
  test("a shipped skill and a .claude/skills/ path each reach session.json as a SKILL.md path", async () => {
    world = await World.create({ record: edited(REPRODUCE, 'plan = { reproduce = ["reproducing-bugs", ".claude/skills/triage"], design = [] }') });
    await world.push({ ".claude/skills/triage/SKILL.md": "---\nname: triage\n---\n" });
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    world.harness.script(issue.identifier, {});
    await world.tick();

    const started = world.harness.started[0]!;
    const slots = { reproduce: [`${world.versionFolder}/skills/reproducing-bugs/SKILL.md`, `${started.session.worktree}/.claude/skills/triage/SKILL.md`], design: [] };
    expect(started.sessionJson.slots).toEqual(slots);
    expect(started.sessionJson.skills).toBe(`${world.versionFolder}/skills`);
    for (const path of slots.reproduce) expect(existsSync(path)).toBe(true);
    expect(await recordState()).toBe("ok");
  });

  test("a path the commit doesn't hold makes the record invalid, and pauses with the invalid-record text", async () => {
    world = await World.create({ record: edited(REPRODUCE, 'plan = { reproduce = ["reproducing-bugs", ".claude/skills/triage"], design = [] }') });
    const issue = await sendAndTake();
    const comment = afterTake(issue).find((write) => write.kind === "comment");
    if (comment?.kind !== "comment") throw new Error("no comment");
    expect(comment.body.split("\n").slice(0, 7)).toEqual([
      "🟡 Needs your help: this repo's Flight Deck record has an error",
      "",
      "Plan can't run, because the record at `.flight-deck/record.toml` on `main` has an error:",
      "",
      "```text",
      `slots.plan.reproduce[2]: .claude/skills/triage/SKILL.md isn't in the repo at commit ${world.commit.slice(0, 7)}`,
      "```",
    ]);
    expect(world.harness.started).toEqual([]);
    expect(world.tracker.stored(issue.id).status).toBe("Paused");
    expect(await recordState()).toBe("invalid");
  });

  test("a name the running version doesn't ship makes the record invalid", async () => {
    world = await World.create({ record: edited("build = { finish = [] }", 'build = { finish = ["changeset"] }') });
    const issue = await sendAndTake();
    const comment = afterTake(issue).find((write) => write.kind === "comment");
    if (comment?.kind !== "comment") throw new Error("no comment");
    expect(comment.body).toContain('```text\nslots.build.finish[1]: Flight Deck ships no skill named "changeset"\n```');
    expect(world.harness.started).toEqual([]);
  });
});

describe("a retry", () => {
  test("reads the record again at its own commit, and a record broken since the take pauses it without a session", async () => {
    world = await World.create();
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    world.harness.script(issue.identifier, { exit: { kind: "timed_out" } });
    await world.tick();
    expect(world.harness.started).toHaveLength(1);

    await world.push({ [RECORD]: SHADERS_RECORD.replace("schema = 1", "schema = 2") });
    await world.tick();
    expect(world.harness.started).toHaveLength(1);
    const comment = afterTake(issue).find((write) => write.kind === "comment");
    if (comment?.kind !== "comment") throw new Error("no comment");
    expect(comment.body.split("\n")[0]).toBe("🟡 Needs your help: this repo's record needs a newer Flight Deck");
    expect(world.tracker.stored(issue.id).status).toBe("Paused");
    expect((await world.status()).sessions).toEqual([]);

    // The pause used no retry: once the record is fixed, its retry takes the issue with attempt 1.
    await world.push({ [RECORD]: SHADERS_RECORD });
    world.reply(issue, "retry");
    world.harness.script(issue.identifier, { outbox: outbox.brief({ summary: "Brief ready", brief: "## Summary\n\nRed." }), exit: { kind: "exited", code: 0 } });
    await world.tick();
    await world.tick();
    expect(world.harness.started.map(({ sessionJson }) => sessionJson.attempt)).toEqual([1, 1]);
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Ready to build");
  });
});
