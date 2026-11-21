// An outbox Linear wouldn't take: the runner keeps it and applies it again with no session, and after 3 hours
// keeps the handoff and pauses the issue (spec 1's "Exits", "Not yet written" and "Not yet written after the move").
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { TrackerUnavailable, type StoredIssue } from "../../src/tracker/index.ts";
import { outbox, SHADERS_RECORD, UNMAPPED_STATUS, World } from "./world.ts";

let world: World;

beforeEach(async () => {
  world = await World.create();
});

afterEach(async () => {
  await world.cleanup();
});

const BRIEF = outbox.brief({ summary: "Brief ready: the Save button turns red", brief: "## Summary\n\nRed." });
const PAUSE = outbox.pause({ summary: "Which red?\n\nThere are two.", pause: "## Question\n\nWhich red?", answers: [], needs: "help" });

/** Makes the move to `to` land and lose its response once, as a dropped connection would on the real adapter. */
function loseMove(to: string): void {
  const move = world.tracker.move.bind(world.tracker);
  let lost = 1;
  world.tracker.move = async (ref, role) => {
    await move(ref, role);
    if (role === to && lost-- > 0) throw new TrackerUnavailable("network");
  };
}

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

  test("reads the issue's status with the statuses the take read, when the registration's copy names others", async () => {
    world.config.repos[0]!.tracker.statuses.planning = UNMAPPED_STATUS;
    await world.writeConfig();
    const issue = world.issue({ title: "Save button is blue" });
    world.tracker.refuse("post");
    await runSession(issue);
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Ready to build");
    expect((await world.status()).sessions).toEqual([]);
  });

  test("a try that throws for another reason waits for the next poll, and the other entries still go", async () => {
    const first = world.issue({ title: "Save button is blue" });
    const second = world.issue({ title: "Checkout crashes" });
    world.tracker.refuse("post", { times: 2 });
    for (const issue of [first, second]) {
      world.send(issue);
      world.harness.script(issue.identifier, { outbox: BRIEF, exit: { kind: "exited", code: 0 } });
    }
    await world.tick();
    await world.tick();
    expect((await world.status()).sessions.map(({ issue, state }) => ({ issue, state }))).toEqual([
      { issue: first.identifier, state: "apply_waiting" },
      { issue: second.identifier, state: "apply_waiting" },
    ]);
    const read = world.tracker.issue.bind(world.tracker);
    let broken = 1;
    world.tracker.issue = async (ref) => {
      if (ref.id === first.id && broken-- > 0) throw new Error("socket hang up");
      return read(ref);
    };
    await world.tick();
    expect(world.tracker.stored(first.id).status).toBe("Planning");
    expect(world.tracker.stored(second.id).status).toBe("Ready to build");
    expect((await world.status()).sessions.map(({ issue, state }) => ({ issue, state }))).toEqual([{ issue: first.identifier, state: "apply_waiting" }]);
    await world.tick();
    expect(world.tracker.stored(first.id).status).toBe("Ready to build");
    expect((await world.status()).sessions).toEqual([]);
  });

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

/** Whether a read names the issue, by its UUID or, as the Outbox reads it, by its identifier. */
const reads = (issue: StoredIssue, id: string) => id === issue.id || id === issue.identifier;

/** Makes every read of the issue fail as Linear not answering, until the returned function is called. */
function breakReads(issue: StoredIssue): () => void {
  const read = world.tracker.issue.bind(world.tracker);
  world.tracker.issue = async (ref) => {
    if (reads(issue, ref.id)) throw new TrackerUnavailable("network");
    return read(ref);
  };
  return () => {
    world.tracker.issue = read;
  };
}

/** Runs a session whose comment Linear refuses for 3 hours, so the runner keeps the outbox and pauses the issue. */
async function keep(issue: StoredIssue, extraRefusals = 0, files: Record<string, string> = BRIEF): Promise<string> {
  world.tracker.refuse("post", { times: 17 + extraRefusals });
  const id = await runSession(issue, files);
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

  test("a take of the kept outbox that throws keeps it for the next take, and the tick still runs", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await keep(issue);
    world.reply(issue, "retry");
    await world.tick();
    const move = world.tracker.move.bind(world.tracker);
    let broken = 1;
    world.tracker.move = async (ref, to) => {
      if (to === "planning" && broken-- > 0) throw new Error("socket hang up");
      await move(ref, to);
    };
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Ready to plan");
    // The entry stays until a read shows whether the take landed.
    expect((await world.status()).sessions.map(({ issue, state }) => ({ issue, state }))).toEqual([{ issue: issue.identifier, state: "apply_waiting" }]);
    expect(existsSync(join(kept(issue), "outbox", "outcome.json"))).toBe(true);
    const log = await Bun.file(join(world.folders.data, "state", "runner.log")).text();
    expect(log).toContain(`${issue.identifier}: kept outbox not applied, retrying next poll: socket hang up`);
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Ready to build");
    expect(world.harness.started).toHaveLength(1);
    expect(existsSync(kept(issue))).toBe(false);
  }, 30_000);

  test("a take of the kept outbox whose response was lost applies the kept outbox at the next poll", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await keep(issue);
    world.reply(issue, "retry");
    await world.tick();
    const move = world.tracker.move.bind(world.tracker);
    let lost = 1;
    world.tracker.move = async (ref, to) => {
      await move(ref, to);
      if (to === "planning" && lost-- > 0) throw new TrackerUnavailable("network");
    };
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Planning");
    expect(existsSync(join(kept(issue), "outbox", "outcome.json"))).toBe(true);
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Ready to build");
    expect(world.harness.started).toHaveLength(1);
    expect((await world.status()).sessions).toEqual([]);
    expect(existsSync(kept(issue))).toBe(false);
  }, 30_000);

  test("a kept outbox is applied while Claude Code's version can't be read", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await keep(issue);
    world.reply(issue, "retry");
    await world.tick();
    world.harness.version = async () => {
      throw new Error("claude: command not found");
    };
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Ready to build");
    expect(world.harness.started).toHaveLength(1);
  }, 30_000);

  test("a hand move to Ready to plan while the pause waits keeps the outbox for the next take", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    // The pause's first try at 3 hours fails, so it waits.
    await keep(issue, 1);
    world.tracker.accept("post");
    world.send(issue);
    await tickAt([1]);
    expect(world.tracker.stored(issue.id).status).toBe("Ready to build");
    expect(world.harness.started).toHaveLength(1);
    expect(existsSync(kept(issue))).toBe(false);
  }, 30_000);

  test("keeps the outbox and pauses at 3 hours though Linear doesn't answer the issue's read then", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.tracker.refuse("post", { times: 17 });
    const id = await runSession(issue);
    const start = world.now.getTime();
    await tickAt(UNTIL_KEPT.slice(0, -1));
    const restore = breakReads(issue);
    await world.tick(new Date(start + 180 * 60_000));
    expect(existsSync(join(kept(issue), "outbox", "outcome.json"))).toBe(true);
    expect(existsSync(join(world.folders.sessionRoot, "sessions", id))).toBe(false);
    restore();
    world.tracker.accept("post");
    await tickAt([1]);
    expect(world.tracker.stored(issue.id).status).toBe("Paused");
    expect((await world.status()).sessions).toEqual([]);
  }, 30_000);

  test("a new take while a kept outbox's writes after the move still wait starts a fresh session", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await keep(issue, 0, WITH_FOLLOW_UP);
    world.reply(issue, "retry");
    await world.tick();
    world.tracker.refuse("file", { times: 100 });
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Ready to build");
    world.send(issue);
    world.harness.script(issue.identifier, {});
    await world.tick();
    expect(world.harness.started).toHaveLength(2);
    expect(world.tracker.stored(issue.id).status).toBe("Planning");
  }, 30_000);

  test("a kept pause whose comment landed gets its flag back at the replay, with no second comment", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    world.harness.script(issue.identifier, { outbox: PAUSE, exit: { kind: "exited", code: 0 } });
    await world.tick();
    // The pause's comment lands, and its move to Paused fails for 3 hours.
    world.tracker.refuse("move", { times: 17 });
    await world.tick();
    await tickAt(UNTIL_KEPT);
    expect(world.tracker.stored(issue.id).status).toBe("Paused");
    world.reply(issue, "retry");
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Ready to plan");
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Paused");
    expect(world.tracker.stored(issue.id).assignee).toBe(world.maintainer.id);
    const flags = (await world.status()).flags;
    expect(flags.map((flag) => flag.issue)).toEqual([issue.identifier]);
    expect(flags[0]!.status_line).toContain("Which red?");
    expect(world.tracker.writes.filter((write) => write.kind === "comment")).toHaveLength(2);
    expect(world.harness.started).toHaveLength(1);
  }, 30_000);

  test("a newer handoff kept while an older take of the kept folder still waits retires the older one", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await keep(issue, 0, WITH_FOLLOW_UP);
    world.reply(issue, "retry");
    await world.tick();
    // The kept take's comment and move land, and its follow-up waits after the move.
    world.tracker.refuse("file", { times: 100 });
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Ready to build");
    // A new take runs a session whose comment Linear refuses too.
    world.send(issue);
    world.harness.script(issue.identifier, { outbox: BRIEF, exit: { kind: "exited", code: 0 } });
    world.tracker.refuse("post", { times: 100 });
    await world.tick();
    await world.tick();
    expect(world.harness.started).toHaveLength(2);
    // The older entry's 3 hours end 2 minutes before the newer one's, and Linear answers no read across both.
    const start = world.now.getTime();
    const at = (minutes: number) => world.tick(new Date(start + minutes * 60_000));
    for (const minutes of [15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165]) await at(minutes);
    const restore = breakReads(issue);
    await at(178);
    await at(180);
    restore();
    world.tracker.accept("post");
    await at(181);
    expect(world.tracker.stored(issue.id).status).toBe("Paused");
    world.reply(issue, "retry");
    await world.tick();
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Ready to build");
    expect(world.harness.started).toHaveLength(2);
    const log = await Bun.file(join(world.folders.data, "state", "runner.log")).text();
    expect(log).toContain("writes after the move dropped: a newer handoff takes the kept folder");
  }, 30_000);

  test("a kept outbox's take keeps its statuses while the default branch's record changes", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await keep(issue);
    world.reply(issue, "retry");
    await world.tick();
    // The take lands, and Linear refuses the comment at the take and at the next poll's try.
    world.tracker.refuse("post", { times: 2 });
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Planning");
    await world.push({ ".flight-deck/record.toml": SHADERS_RECORD.replace('planning = "Planning"', `planning = "${UNMAPPED_STATUS}"`) });
    await world.tick();
    expect(existsSync(join(kept(issue), "outbox", "outcome.json"))).toBe(true);
    await tickAt([1]);
    expect(world.tracker.stored(issue.id).status).toBe("Ready to build");
    expect(world.harness.started).toHaveLength(1);
  }, 30_000);

  test.each([
    ["", false],
    [", after a restart", true],
  ])("a pause that waits keeps the take's statuses while the default branch's record changes%s", async (_, restart) => {
    const issue = world.issue({ title: "Save button is blue" });
    // The pause's first try at 3 hours fails too, so it waits for its next try.
    world.tracker.refuse("post", { times: 18 });
    await runSession(issue);
    await world.push({ ".flight-deck/record.toml": SHADERS_RECORD.replace('planning = "Planning"', `planning = "${UNMAPPED_STATUS}"`) });
    await tickAt(UNTIL_KEPT);
    expect(existsSync(join(kept(issue), "outbox", "outcome.json"))).toBe(true);
    if (restart) world.restart();
    await tickAt([1]);
    expect(world.tracker.stored(issue.id).status).toBe("Paused");
    expect(existsSync(join(kept(issue), "outbox", "outcome.json"))).toBe(true);
    expect((await world.status()).sessions).toEqual([]);
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

  test("whose move's response was lost lands at the next poll, though the issue left Planning", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    // The move lands, and its response is lost, as a dropped connection would on the real adapter.
    const move = world.tracker.move.bind(world.tracker);
    let lost = 1;
    world.tracker.move = async (ref, to) => {
      await move(ref, to);
      if (to === "ready_to_build" && lost-- > 0) throw new TrackerUnavailable("network");
    };
    const id = await runSession(issue, WITH_FOLLOW_UP);
    expect(world.tracker.stored(issue.id).status).toBe("Ready to build");
    expect((await world.status()).sessions.map(({ id, state }) => ({ id, state }))).toEqual([{ id, state: "apply_waiting" }]);
    await world.tick();
    expect(afterTake(issue).map((write) => write.kind)).toEqual(["description", "comment", "move", "file", "relate"]);
    expect((await world.status()).sessions).toEqual([]);
  });

  test("stays after the move once a lost move is found, though the next write fails", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    const move = world.tracker.move.bind(world.tracker);
    let lost = 1;
    world.tracker.move = async (ref, to) => {
      await move(ref, to);
      if (to === "ready_to_build" && lost-- > 0) throw new TrackerUnavailable("network");
    };
    const id = await runSession(issue, WITH_FOLLOW_UP);
    // The try's first read finds the move, and its second, inside the apply, fails.
    const read = world.tracker.issue.bind(world.tracker);
    let count = 0;
    world.tracker.issue = async (ref) => {
      if (reads(issue, ref.id) && ++count === 2) throw new TrackerUnavailable("network");
      return read(ref);
    };
    await world.tick();
    const log = await Bun.file(join(world.folders.data, "state", "runner.log")).text();
    expect(log).toContain(`${id} ${issue.identifier}: the move landed, so the writes after it keep trying`);
    await tickAt([1]);
    expect(afterTake(issue).map((write) => write.kind)).toEqual(["description", "comment", "move", "file", "relate"]);
    expect((await world.status()).sessions).toEqual([]);
  });

  test("is listed and dropped after 3 hours, though Linear doesn't answer the issue's read then", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.tracker.refuse("file", { times: 17 });
    const id = await runSession(issue, WITH_FOLLOW_UP);
    const start = world.now.getTime();
    await tickAt(UNTIL_KEPT.slice(0, -1));
    const restore = breakReads(issue);
    await world.tick(new Date(start + 180 * 60_000));
    const before = await Bun.file(join(world.folders.data, "state", "runner.log")).text();
    expect(before).toContain(`${id} ${issue.identifier}: Linear didn't answer, so the writes after the move wait to be listed and dropped`);
    expect((await world.status()).sessions.map(({ id, state }) => ({ id, state }))).toEqual([{ id, state: "apply_waiting" }]);
    restore();
    // Linear takes the follow-up again, but its 3 hours ran out, so the try only lists and drops it.
    world.tracker.accept("file");
    await tickAt([15]);
    expect(afterTake(issue).map((write) => write.kind)).toEqual(["description", "comment", "move"]);
    const log = await Bun.file(join(world.folders.data, "state", "runner.log")).text();
    expect(log).toContain(`${id} ${issue.identifier}: file follow-ups/1.md dropped: Linear didn't take it for 3 hours`);
    expect((await world.status()).sessions).toEqual([]);
    expect(world.tracker.stored(issue.id).status).toBe("Ready to build");
  }, 30_000);

  test("relates no follow-up deleted since it was filed, and the other writes still land", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.tracker.refuse("relate");
    await runSession(issue, WITH_FOLLOW_UP);
    world.tracker.deleteIssue(world.tracker.stored("SHA-2").id);
    await world.tick();
    expect((await world.status()).sessions).toEqual([]);
    const log = await Bun.file(join(world.folders.data, "state", "runner.log")).text();
    expect(log).toContain(`${issue.identifier}: the issue filed for follow-ups/1.md is gone, so it isn't related`);
  });

  test("is found though the default branch's record no longer maps the move's status", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    loseMove("ready_to_build");
    world.send(issue);
    world.harness.script(issue.identifier, { outbox: WITH_FOLLOW_UP, exit: { kind: "exited", code: 0 } });
    await world.tick();
    await world.push({ ".flight-deck/record.toml": SHADERS_RECORD.replace('ready_to_build = "Ready to build"', `ready_to_build = "${UNMAPPED_STATUS}"`) });
    await world.tick();
    await world.tick();
    expect(world.tracker.writes.filter((write) => write.kind === "file")).toHaveLength(1);
    expect((await world.status()).sessions).toEqual([]);
  });

  test("a pause whose move's response was lost finishes, though Linear didn't answer its reads for 3 hours", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    loseMove("paused");
    await runSession(issue, { ...PAUSE, "follow-ups/1.md": "# Cancel is blue too\n\nx" });
    expect(world.tracker.stored(issue.id).status).toBe("Paused");
    const restore = breakReads(issue);
    await tickAt(UNTIL_KEPT);
    expect(existsSync(join(kept(issue), "outbox", "outcome.json"))).toBe(true);
    restore();
    await tickAt([1, 2, 3]);
    expect(world.tracker.writes.filter((write) => write.kind === "file")).toHaveLength(1);
    expect((await world.status()).sessions).toEqual([]);
  }, 30_000);

  test("is dropped when the issue was deleted", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.tracker.refuse("file");
    const id = await runSession(issue, WITH_FOLLOW_UP);
    world.tracker.deleteIssue(issue.id);
    await world.tick();
    expect((await world.status()).sessions).toEqual([]);
    expect(existsSync(join(world.folders.sessionRoot, "sessions", id))).toBe(false);
    const log = await Bun.file(join(world.folders.data, "state", "runner.log")).text();
    expect(log).toContain(`${id} ${issue.identifier}: the issue is gone, writes after the move dropped`);
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

  test("loses it when the issue was deleted", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.tracker.refuse("post", { times: 1 });
    const id = await runSession(issue);
    world.tracker.deleteIssue(issue.id);
    await world.tick();
    expect((await world.status()).sessions).toEqual([]);
    expect(existsSync(join(world.folders.sessionRoot, "sessions", id))).toBe(false);
    const log = await Bun.file(join(world.folders.data, "state", "runner.log")).text();
    expect(log).toContain(`${id} ${issue.identifier}: left planning, outbox discarded`);
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
