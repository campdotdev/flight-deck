// An outbox Linear wouldn't take: the runner keeps it and applies it again with no session, and after 3 hours
// keeps the handoff and pauses the issue (spec 1's "Exits", "Not yet written" and "Not yet written after the move").
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { StoredIssue } from "../../src/tracker/index.ts";
import { outbox, World } from "./world.ts";

let world: World;

beforeEach(async () => {
  world = await World.create();
});

afterEach(async () => {
  await world.cleanup();
});

const BRIEF = outbox.brief({ summary: "Brief ready: the Save button turns red", brief: "## Summary\n\nRed." });

/** The writes after the issue's last move to Planning. */
function afterTake(issue: StoredIssue) {
  const writes = world.tracker.writes;
  const take = writes.findLastIndex((write) => write.kind === "move" && write.issue === issue.identifier && write.status === "Planning");
  return writes.slice(take + 1);
}

/** Sends the issue, and ticks once so its session runs, and once more so the exit is handled. */
async function runSession(issue: StoredIssue, files: Record<string, string> = BRIEF): Promise<string> {
  world.send(issue);
  world.harness.script(issue.identifier, { outbox: files, exit: { kind: "exited", code: 0 } });
  await world.tick();
  await world.tick();
  return world.harness.started.at(-1)!.session.id;
}

describe("an apply Linear doesn't take", () => {
  test("waits as apply_waiting with no session, then applies again at the next poll, skipping the writes that landed", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.tracker.refuse("post");
    const id = await runSession(issue);
    expect(afterTake(issue).map((write) => write.kind)).toEqual(["description"]);
    const status = await world.status();
    expect(status.sessions).toEqual([
      { id, repo: world.repo, issue: issue.identifier, title: "Save button is blue", stage: "plan", state: "apply_waiting", started_at: null, deadline: null },
    ]);
    // The outbox stays in the session folder, and the worktree goes.
    expect(existsSync(join(world.folders.sessionRoot, "sessions", id, "outbox", "outcome.json"))).toBe(true);
    expect(existsSync(join(world.folders.sessionRoot, "worktrees", id))).toBe(false);

    await world.tick();
    expect(afterTake(issue).map((write) => write.kind)).toEqual(["description", "comment", "move"]);
    expect(world.tracker.stored(issue.id).status).toBe("Ready to build");
    expect(world.harness.started).toHaveLength(1);
    expect((await world.status()).sessions).toEqual([]);
    expect(existsSync(join(world.folders.sessionRoot, "sessions", id))).toBe(false);
  });
});

/** Ticks at each of these minutes after the clock's current reading. */
async function tickAt(minutes: number[]): Promise<void> {
  const start = world.now.getTime();
  for (const minute of minutes) await world.tick(new Date(start + minute * 60_000));
}

describe("the backoff", () => {
  test("tries at the next poll, then after 1, 2, 4, and 8 minutes, then every 15 minutes", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    // The first apply and the next five tries fail. The seventh try, 31 minutes after the first, lands.
    world.tracker.refuse("post", { times: 6 });
    await runSession(issue);
    await tickAt(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(afterTake(issue).map((write) => write.kind)).toEqual(["description"]);
    await tickAt([1]);
    expect(afterTake(issue).map((write) => write.kind)).toEqual(["description", "comment", "move"]);
  }, 30_000);

  test("an apply_waiting entry takes no place under the cap", async () => {
    world.config.concurrency_cap = 1;
    await world.writeConfig();
    const first = world.issue({ title: "Save button is blue" });
    world.tracker.refuse("post", { times: 100 });
    await runSession(first);
    const second = world.issue({ title: "Checkout crashes" });
    world.send(second);
    world.harness.script(second.identifier, {});
    await world.tick();
    expect(world.harness.started.map(({ session }) => session.issue)).toEqual([first.identifier, second.identifier]);
    expect((await world.status()).sessions.map(({ issue, state }) => ({ issue, state }))).toEqual([
      { issue: first.identifier, state: "apply_waiting" },
      { issue: second.identifier, state: "running" },
    ]);
  });
});

/** The tries after the exit's apply, in minutes after it, up to the 3 hours: 16 tries, so 17 with the first. */
const UNTIL_KEPT = [1, 2, 4, 8, 16, 31, 46, 61, 76, 91, 106, 121, 136, 151, 166, 180];

function kept(issue: StoredIssue): string {
  return join(world.folders.data, "repos", "campdotdev", "shaders", "kept", issue.id);
}

/** Runs a session whose comment Linear refuses for 3 hours, so the runner keeps the outbox and pauses the issue. */
async function keep(issue: StoredIssue, extraRefusals = 0): Promise<string> {
  world.tracker.refuse("post", { times: 17 + extraRefusals });
  const id = await runSession(issue);
  await tickAt(UNTIL_KEPT);
  return id;
}

describe("after 3 hours", () => {
  test("keeps the outbox and pauses the issue with the Linear-write text, and the kept folder outlives dispose", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    const id = await keep(issue);
    const session = world.harness.started[0]!.session;
    const body = [
      "🟡 Needs your help: Flight Deck couldn't write to Linear",
      "",
      "Plan finished, but for 3 hours Linear refused Flight Deck's writes or didn't answer them. Flight Deck kept plan's handoff on the Mac. A retry writes that handoff with no new session.",
      "",
      "Reply with one word:",
      "",
      "- **retry**: Flight Deck writes the kept handoff. Moves the issue to Ready to plan.",
      "",
      "Any other reply leaves the issue paused until you move it.",
      "",
      "+++ Details",
      "",
      `- Session: \`${id}\``,
      "- Attempt: 1",
      `- Transcript: \`${session.transcript}\``,
      "",
      `The handoff is kept in \`${kept(issue)}\`.`,
      "",
      `Flight Deck ${world.version} · runner`,
      "",
      "+++",
    ].join("\n");
    expect(afterTake(issue)).toEqual([
      { kind: "description", issue: issue.identifier, description: expect.any(String) },
      { kind: "assign", issue: issue.identifier, user: world.maintainer.id },
      { kind: "comment", issue: issue.identifier, body },
      { kind: "move", issue: issue.identifier, status: "Paused" },
    ]);
    const status = await world.status();
    expect(status.sessions).toEqual([]);
    expect(status.flags.map(({ issue, status_line }) => ({ issue, status_line }))).toEqual([
      { issue: issue.identifier, status_line: "🟡 Needs your help: Flight Deck couldn't write to Linear" },
    ]);
    expect(existsSync(join(world.folders.sessionRoot, "sessions", id))).toBe(false);
    for (const file of ["session.json", "applied.json", "outbox/outcome.json", "outbox/brief.md"]) expect(existsSync(join(kept(issue), file))).toBe(true);
    // A later poll leaves it alone while the issue stays paused.
    await world.tick();
    expect(existsSync(join(kept(issue), "outbox", "outcome.json"))).toBe(true);
  }, 30_000);

  test("its retry makes the next take apply the kept outbox and start no session", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await keep(issue);
    world.reply(issue, "retry");
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Ready to plan");
    await world.tick();
    expect(afterTake(issue).map((write) => write.kind)).toEqual(["comment", "move"]);
    expect(world.tracker.stored(issue.id).status).toBe("Ready to build");
    expect(world.harness.started).toHaveLength(1);
    expect((await world.status()).sessions).toEqual([]);
    expect(existsSync(kept(issue))).toBe(false);
  }, 30_000);

  test("from an older version, its next take after the retry deletes it and starts a fresh session", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await keep(issue);
    world.reply(issue, "retry");
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Ready to plan");
    // flight-deck update restarts the runner on a new version, which can't apply the old one's outbox (ADR 0015).
    world.restart({ version: "0.1.0-dev.20261111T000000Z" });
    world.harness.script(issue.identifier, {});
    await world.tick();
    expect(existsSync(kept(issue))).toBe(false);
    expect(world.harness.started).toHaveLength(2);
    expect(world.harness.started[1]!.sessionJson).toMatchObject({ version: "0.1.0-dev.20261111T000000Z", attempt: 1 });
    expect(world.tracker.stored(issue.id).status).toBe("Planning");
    expect((await world.status()).sessions.map(({ issue: id, state }) => ({ id, state }))).toEqual([{ id: issue.identifier, state: "running" }]);
  }, 30_000);

  test("a hand move back to Ready to plan applies the kept outbox too", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await keep(issue);
    world.send(issue);
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Ready to build");
    expect(world.harness.started).toHaveLength(1);
  }, 30_000);

  test("any other move out of Paused deletes the kept folder, so the next take starts a session", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await keep(issue);
    world.tracker.setStatus(issue.id, "Backlog");
    await world.tick();
    expect(existsSync(kept(issue))).toBe(false);
    world.send(issue);
    world.harness.script(issue.identifier, {});
    await world.tick();
    expect(world.harness.started).toHaveLength(2);
    expect(world.tracker.stored(issue.id).status).toBe("Planning");
  }, 30_000);

  test("a pause Linear won't take either keeps the entry, and the pause is tried on the same backoff", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    // The pause's first try at 3 hours fails, and so do the next two, at the next poll and a minute later.
    await keep(issue, 3);
    expect((await world.status()).sessions.map(({ issue, state }) => ({ issue, state }))).toEqual([{ issue: issue.identifier, state: "apply_waiting" }]);
    await tickAt([1, 2, 3]);
    expect(world.tracker.writes.filter((write) => write.kind === "comment")).toEqual([]);
    await tickAt([1]);
    expect(afterTake(issue).map((write) => write.kind)).toEqual(["description", "assign", "comment", "move"]);
    expect(world.tracker.stored(issue.id).status).toBe("Paused");
    expect((await world.status()).sessions).toEqual([]);
    expect(existsSync(join(kept(issue), "outbox", "outcome.json"))).toBe(true);
  }, 30_000);
});

const WITH_FOLLOW_UP = { ...BRIEF, "follow-ups/1.md": "# Cancel is blue too\n\nThe Cancel button has the same blue." };

describe("a write after the move", () => {
  test("retries with no session, while the issue has moved on", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.tracker.refuse("file");
    const id = await runSession(issue, WITH_FOLLOW_UP);
    expect(world.tracker.stored(issue.id).status).toBe("Ready to build");
    expect((await world.status()).sessions.map(({ id, state }) => ({ id, state }))).toEqual([{ id, state: "apply_waiting" }]);
    await world.tick();
    expect(afterTake(issue).map((write) => write.kind)).toEqual(["description", "comment", "move", "file", "relate"]);
    expect(world.harness.started).toHaveLength(1);
    expect((await world.status()).sessions).toEqual([]);
  });

  test("is dropped after 3 hours, with no pause", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.tracker.refuse("file", { times: 17 });
    const id = await runSession(issue, WITH_FOLLOW_UP);
    await tickAt(UNTIL_KEPT);
    expect(afterTake(issue).map((write) => write.kind)).toEqual(["description", "comment", "move"]);
    const status = await world.status();
    expect(status.sessions).toEqual([]);
    expect(status.flags).toEqual([]);
    expect(world.tracker.stored(issue.id).status).toBe("Ready to build");
    expect(existsSync(join(world.folders.sessionRoot, "sessions", id))).toBe(false);
    expect(existsSync(kept(issue))).toBe(false);
    const log = await Bun.file(join(world.folders.data, "state", "runner.log")).text();
    expect(log).toContain(`${id} ${issue.identifier}: file follow-ups/1.md dropped: Linear didn't take it for 3 hours`);
    expect(log).toContain(`${id} ${issue.identifier}: relate follow-ups/1.md dropped: Linear didn't take it for 3 hours`);
    await world.tick();
    expect(afterTake(issue).map((write) => write.kind)).toEqual(["description", "comment", "move"]);
  }, 30_000);
});

describe("an issue the maintainer moves while its apply waits", () => {
  test("loses its outbox, and nothing more is written", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.tracker.refuse("post", { times: 1 });
    const id = await runSession(issue);
    world.tracker.setStatus(issue.id, "Backlog");
    await world.tick();
    await world.tick();
    expect(afterTake(issue).map((write) => write.kind)).toEqual(["description"]);
    expect((await world.status()).sessions).toEqual([]);
    expect(existsSync(join(world.folders.sessionRoot, "sessions", id))).toBe(false);
  });

  test("loses it at step 4 of the next poll, before its next try comes", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    // The exit's apply and the retry at the next poll fail, so the next try waits a minute.
    world.tracker.refuse("post", { times: 2 });
    const id = await runSession(issue);
    await world.tick();
    world.tracker.setStatus(issue.id, "Backlog");
    await world.tick(new Date(world.now.getTime() + 30_000));
    expect(afterTake(issue).map((write) => write.kind)).toEqual(["description"]);
    expect((await world.status()).sessions).toEqual([]);
    expect(existsSync(join(world.folders.sessionRoot, "sessions", id))).toBe(false);
    const log = await Bun.file(join(world.folders.data, "state", "runner.log")).text();
    expect(log).toContain(`${id} ${issue.identifier}: left planning, outbox discarded`);
  });

  test("of a kept outbox's take deletes the kept folder, so the next take starts a session", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await keep(issue);
    world.reply(issue, "retry");
    await world.tick();
    // The take's apply and its retry at the next poll fail.
    world.tracker.refuse("post", { times: 2 });
    await world.tick();
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Planning");
    expect((await world.status()).sessions.map(({ issue, state }) => ({ issue, state }))).toEqual([{ issue: issue.identifier, state: "apply_waiting" }]);
    world.tracker.setStatus(issue.id, "Backlog");
    await world.tick(new Date(world.now.getTime() + 30_000));
    expect((await world.status()).sessions).toEqual([]);
    expect(existsSync(kept(issue))).toBe(false);
    world.send(issue);
    world.harness.script(issue.identifier, {});
    await world.tick();
    expect(world.harness.started).toHaveLength(2);
    expect(world.tracker.stored(issue.id).status).toBe("Planning");
  }, 30_000);
});
