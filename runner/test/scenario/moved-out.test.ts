// Step 4 of the poll, moved out (spec 1's "Poll" and "Exits", ADR 0007): the maintainer takes an issue back by
// moving it out of Planning, and its session stops at the next poll with its outbox discarded. The runner
// posts nothing and uses no retry, because the maintainer moved it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { StoredIssue } from "../../src/tracker/index.ts";
import { outbox, World } from "./world.ts";
import { STATUSES } from "../statuses.ts";

let world: World;

beforeEach(async () => {
  world = await World.create();
});

afterEach(async () => {
  await world.cleanup();
});

const BRIEF = outbox.brief({ summary: "Brief ready: the Save button turns red", brief: "## Summary\n\nTurn it red.\n" });

/** Sends the issue and starts its session, which runs until it's stopped. */
async function running(issue: StoredIssue): Promise<string> {
  world.send(issue);
  world.harness.script(issue.identifier, { outbox: BRIEF });
  await world.tick();
  return world.harness.started.at(-1)!.session.id;
}

/** The runner's writes from this point on. */
function writesFrom(): () => unknown[] {
  const start = world.tracker.writes.length;
  return () => world.tracker.writes.slice(start);
}

function sessionFolder(id: string): string {
  return join(world.folders.sessionRoot, "sessions", id);
}

describe("an issue moved out of Planning", () => {
  for (const [how, move] of [
    ["back to Backlog", (issue: StoredIssue) => world.tracker.setStatus(issue.id, STATUSES.backlog[0])],
    ["to Canceled", (issue: StoredIssue) => world.tracker.setStatus(issue.id, STATUSES.canceled[0])],
    ["by deleting it", (issue: StoredIssue) => world.tracker.deleteIssue(issue.id)],
    ["by archiving it", (issue: StoredIssue) => world.tracker.archive(issue.id)],
    ["to another team", (issue: StoredIssue) => world.tracker.moveToTeam(issue.id, "OTH", STATUSES.planning[0])],
  ] as const) {
    test(`${how} stops its session at the next poll and discards its outbox`, async () => {
      world.tracker.addTeam({ key: "OTH", name: "Other", statuses: Object.values(STATUSES).map(([name, type]) => ({ name, type })) });
      const issue = world.issue({ title: "Save button is blue" });
      const session = await running(issue);
      const writes = writesFrom();

      move(issue);
      await world.tick();
      expect(world.harness.stops).toEqual([session]);

      await world.tick();
      expect(writes()).toEqual([]);
      expect(existsSync(sessionFolder(session))).toBe(false);
      expect(world.tracker.tokens.map(({ session, revoked }) => ({ session, revoked }))).toEqual([{ session, revoked: true }]);
      expect((await world.status()).sessions).toEqual([]);
      expect(world.harness.started).toHaveLength(1);
    });
  }

  for (const [how, move] of [
    ["by archiving it", (issue: StoredIssue) => world.tracker.archive(issue.id)],
    ["to another team", (issue: StoredIssue) => world.tracker.moveToTeam(issue.id, "OTH", STATUSES.planning[0])],
  ] as const) {
    test(`${how} before its rate_limited exit is handled isn't requeued`, async () => {
      world.tracker.addTeam({ key: "OTH", name: "Other", statuses: Object.values(STATUSES).map(([name, type]) => ({ name, type })) });
      const issue = world.issue({ title: "Save button is blue" });
      world.send(issue);
      world.harness.script(issue.identifier, { exit: { kind: "rate_limited", resetsAt: null } });
      await world.tick();
      const writes = writesFrom();

      move(issue);
      await world.tick();
      expect(writes()).toEqual([]);
      expect(world.tracker.stored(issue.id).status).toBe("Planning");
      expect((await world.status()).sessions).toEqual([]);
    });
  }

  test("drops a waiting retry, even while the runner is held", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    world.harness.script(issue.identifier, { exit: { kind: "timed_out" } });
    await world.tick();
    await world.hold();
    await world.tick();
    expect((await world.status()).sessions.map(({ state }) => state)).toEqual(["retry_waiting"]);
    const writes = writesFrom();

    world.tracker.setStatus(issue.id, STATUSES.backlog[0]);
    await world.tick();
    expect((await world.status()).sessions).toEqual([]);
    await world.start();
    world.send(issue);
    await world.tick();
    // A fresh send is a fresh take, with the stage's retry restored.
    expect(world.harness.started).toHaveLength(2);
    expect(world.harness.started[1]!.sessionJson.attempt).toBe(1);
    expect(writes()).toEqual([
      { kind: "move", issue: issue.identifier, status: "Planning" },
    ]);
  });

  test("after an exited exit discards the outbox, with no retry and no pause", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    world.harness.script(issue.identifier, { outbox: BRIEF, exit: { kind: "exited", code: 0 } });
    await world.tick();
    const session = world.harness.started[0]!.session.id;
    const writes = writesFrom();

    world.tracker.deleteIssue(issue.id);
    await world.tick();
    expect(writes()).toEqual([]);
    expect(world.harness.stops).toEqual([]);
    expect(existsSync(sessionFolder(session))).toBe(false);
    expect((await world.status()).sessions).toEqual([]);
  });

  test("leaves a session alone while its issue stays in Planning", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await running(issue);
    await world.tick();
    await world.tick();
    expect(world.harness.stops).toEqual([]);
    expect((await world.status()).sessions.map(({ state }) => state)).toEqual(["running"]);
  });
});
