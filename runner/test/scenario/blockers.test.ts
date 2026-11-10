// A sent issue waits in Ready to plan until its blockers are done, and a canceled blocker pauses it (spec 1's
// "Starts", ADRs 0002 and 0004). Issues with a parent or sub-issues wait for spec 4.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { StoredIssue } from "../../src/tracker/index.ts";
import { World } from "./world.ts";

let world: World;

beforeEach(async () => {
  world = await World.create();
});

afterEach(async () => {
  await world.cleanup();
});

/** Files an issue in the status, as the maintainer. */
function blocker(status: string, title = `Blocker in ${status}`): StoredIssue {
  return world.issue({ title, status });
}

function startedFor(issue: StoredIssue): number {
  return world.harness.started.filter((each) => each.session.issue === issue.identifier).length;
}

/** Every write the runner made on the issue, by kind. */
function writesOn(issue: StoredIssue): string[] {
  return world.tracker.writes.filter((write) => "issue" in write && write.issue === issue.identifier).map((write) => write.kind);
}

describe("issues that wait for spec 4", () => {
  test("an issue with a parent or sub-issues stays in Ready to plan, gets nothing, and shows under waiting_for_specs", async () => {
    const child = world.issue({ title: "Part of a spec", parent: "parent-issue" });
    const spec = world.issue({ title: "A spec", children: 2 });
    world.send(child);
    world.send(spec);
    await world.tick();
    expect(world.harness.started).toEqual([]);
    // Steps 6 and 7 leave them alone too, so the maintainer stays subscribed.
    expect(world.tracker.writes).toEqual([]);
    expect(world.tracker.stored(child.id).status).toBe("Ready to plan");
    expect((await world.status()).repos[0]!.waiting_for_specs).toEqual([
      { issue: child.identifier, title: "Part of a spec" },
      { issue: spec.identifier, title: "A spec" },
    ]);
  });
});

describe("an issue with a blocker that isn't done", () => {
  test("waits with no comment, shows under waiting_for_blockers, and is taken once every blocker is Done", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    const open = blocker("Backlog", "Pick the palette");
    const landed = blocker("Landed", "Ship the tokens");
    world.tracker.addBlocker(issue.id, open.id);
    world.tracker.addBlocker(issue.id, landed.id);
    world.send(issue);
    await world.tick();

    expect(startedFor(issue)).toBe(0);
    expect(world.tracker.stored(issue.id).status).toBe("Ready to plan");
    expect(world.tracker.stored(issue.id).comments).toEqual([]);
    // Step 7 still applies to a waiting issue.
    expect(writesOn(issue)).toEqual(["unsubscribe"]);
    expect((await world.status()).repos[0]!.waiting_for_blockers).toEqual([
      {
        issue: issue.identifier,
        title: "Save button is blue",
        blockers: [
          { issue: open.identifier, title: "Pick the palette", status: "Backlog" },
          { issue: landed.identifier, title: "Ship the tokens", status: "Landed" },
        ],
      },
    ]);

    world.tracker.setStatus(open.id, "Done");
    await world.tick();
    expect(startedFor(issue)).toBe(0);
    expect((await world.status()).repos[0]!.waiting_for_blockers).toEqual([
      { issue: issue.identifier, title: "Save button is blue", blockers: [{ issue: landed.identifier, title: "Ship the tokens", status: "Landed" }] },
    ]);

    world.tracker.setStatus(landed.id, "Done");
    await world.tick();
    expect(startedFor(issue)).toBe(1);
    expect(world.tracker.stored(issue.id).status).toBe("Planning");
    expect((await world.status()).repos[0]!.waiting_for_blockers).toEqual([]);
  });

  test("a blocker the app can't read counts as open and shows by its identifier alone", async () => {
    world.tracker.addTeam({ key: "SEC", name: "Security", statuses: [{ name: "Done", type: "completed" }], readable: false });
    const issue = world.issue({ title: "Save button is blue" });
    const hidden = world.tracker.addIssue({ team: "SEC", title: "Private", status: "Done", creator: world.maintainer.id });
    world.tracker.addBlocker(issue.id, hidden.id);
    world.send(issue);
    await world.tick();
    expect(startedFor(issue)).toBe(0);
    expect((await world.status()).repos[0]!.waiting_for_blockers).toEqual([
      { issue: issue.identifier, title: "Save button is blue", blockers: [{ issue: hidden.identifier, title: null, status: null }] },
    ]);
  });
});

describe("a blocker marked a duplicate", () => {
  test("counts as its original's status, even when Linear reports the duplicate as canceled", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    const duplicate = blocker("Canceled", "Pick colors");
    const original = blocker("Backlog", "Pick the palette");
    world.tracker.setDuplicate(duplicate.id, original.id);
    world.tracker.addBlocker(issue.id, duplicate.id);
    world.send(issue);
    await world.tick();
    expect(startedFor(issue)).toBe(0);
    expect(world.tracker.stored(issue.id).status).toBe("Ready to plan");
    expect(world.tracker.stored(issue.id).comments).toEqual([]);
    expect((await world.status()).repos[0]!.waiting_for_blockers).toEqual([
      { issue: issue.identifier, title: "Save button is blue", blockers: [{ issue: duplicate.identifier, title: "Pick colors", status: "Canceled" }] },
    ]);

    world.tracker.setStatus(original.id, "Done");
    await world.tick();
    expect(startedFor(issue)).toBe(1);
  });
});

/** The blocker pause's comment, with nothing in its fold but the runner footer. */
function pauseComment(statusLine: string, sentences: string): string {
  return [
    statusLine,
    "",
    sentences,
    "",
    "Reply with one word:",
    "",
    "- **retry**: Flight Deck tests the blockers again. Moves the issue to Ready to plan.",
    "",
    "Any other reply leaves the issue paused until you move it.",
    "",
    "+++ Details",
    "",
    `Flight Deck ${world.version} · runner`,
    "",
    "+++",
  ].join("\n");
}

function link(issue: StoredIssue): string {
  return `[${issue.title}](https://linear.app/campdotdev/issue/${issue.identifier})`;
}

describe("a blocker that won't be done", () => {
  test("a canceled blocker pauses the issue from Ready to plan with no session, flags it, and offers retry", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    const canceled = blocker("Canceled", "Pick the palette");
    world.tracker.addBlocker(issue.id, canceled.id);
    world.send(issue);
    await world.tick();

    expect(world.harness.started).toEqual([]);
    expect(world.tracker.writes).toEqual([
      { kind: "unsubscribe", issue: issue.identifier, user: world.maintainer.id },
      { kind: "assign", issue: issue.identifier, user: world.maintainer.id },
      {
        kind: "comment",
        issue: issue.identifier,
        body: pauseComment(
          "🟡 Needs your help: a blocker was canceled",
          `Plan can't start, because a blocker of this issue won't be done. ${link(canceled)} was canceled. Remove the blocking relation, or reopen the blocker.`,
        ),
      },
      { kind: "move", issue: issue.identifier, status: "Paused" },
    ]);
    const status = await world.status();
    expect(status.sessions).toEqual([]);
    expect(status.repos[0]!.waiting_for_blockers).toEqual([]);
    expect(status.flags.map(({ issue, status_line }) => ({ issue, status_line }))).toEqual([
      { issue: issue.identifier, status_line: "🟡 Needs your help: a blocker was canceled" },
    ]);
  });

  test("a duplicate blocker with no original pauses the issue", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    const orphan = blocker("Duplicate", "Pick colors");
    world.tracker.addBlocker(issue.id, orphan.id);
    world.send(issue);
    await world.tick();
    expect(world.harness.started).toEqual([]);
    expect(world.tracker.stored(issue.id).status).toBe("Paused");
    expect(world.tracker.writes.find((write) => write.kind === "comment")).toEqual({
      kind: "comment",
      issue: issue.identifier,
      body: pauseComment(
        "🟡 Needs your help: a blocker is a duplicate of nothing",
        `Plan can't start, because a blocker of this issue won't be done. ${link(orphan)} is marked a duplicate of no issue. Remove the blocking relation, or reopen the blocker.`,
      ),
    });
  });

  test("a canceled blocker pauses even beside an open one, and its status line wins over a duplicate of nothing", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    const open = blocker("Backlog");
    const canceled = blocker("Canceled", "Pick the palette");
    const orphan = blocker("Duplicate", "Pick colors");
    for (const each of [open, orphan, canceled]) world.tracker.addBlocker(issue.id, each.id);
    world.send(issue);
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Paused");
    expect(world.tracker.writes.find((write) => write.kind === "comment")).toEqual({
      kind: "comment",
      issue: issue.identifier,
      body: pauseComment(
        "🟡 Needs your help: a blocker was canceled",
        `Plan can't start, because blockers of this issue won't be done. ${link(canceled)} was canceled. ${link(orphan)} is marked a duplicate of no issue. Remove each blocking relation, or reopen each blocker.`,
      ),
    });
  });

  test("a retry with nothing changed pauses the issue again at the next poll, and one after the fix takes it", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    const canceled = blocker("Canceled", "Pick the palette");
    world.tracker.addBlocker(issue.id, canceled.id);
    world.send(issue);
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Paused");

    world.reply(issue, "retry");
    await world.tick();
    // The answer moves the issue back, and the clear takes the flag off.
    expect(world.tracker.stored(issue.id).status).toBe("Ready to plan");
    expect(world.tracker.stored(issue.id).assignee).toBeNull();
    const before = world.tracker.writes.length;
    await world.tick();
    expect(world.harness.started).toEqual([]);
    expect(world.tracker.writes.slice(before).map((write) => write.kind)).toEqual(["assign", "comment", "move"]);
    expect(world.tracker.stored(issue.id).status).toBe("Paused");

    world.tracker.setStatus(canceled.id, "Done");
    world.reply(issue, "retry");
    await world.tick();
    await world.tick();
    expect(startedFor(issue)).toBe(1);
    expect(world.tracker.stored(issue.id).status).toBe("Planning");
  });

  test("a pause Linear doesn't take waits in issue memory, and the blocker test leaves the issue alone until it lands", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    const canceled = blocker("Canceled", "Pick the palette");
    world.tracker.addBlocker(issue.id, canceled.id);
    world.send(issue);
    world.tracker.refuse("post", { times: 1 });
    await world.tick();
    expect(world.tracker.writes.map((write) => write.kind)).toEqual(["unsubscribe"]);
    await world.tick();
    // One comment and one move: the retry lands the pending pause, and the blocker test doesn't post a second.
    expect(world.tracker.writes.map((write) => write.kind)).toEqual(["unsubscribe", "assign", "comment", "move"]);
    expect(world.harness.started).toEqual([]);
  });
});
