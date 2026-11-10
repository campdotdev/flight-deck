// `hold`, `start`, and `stop` (spec 1's "Holds", ADRs 0007 and 0021): a held runner lets running sessions
// finish and starts no new one, and `stop` also stops every session and pauses its issue with the ⚪ text.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { StoredIssue } from "../../src/tracker/index.ts";
import { outbox, World } from "./world.ts";

let world: World;

beforeEach(async () => {
  world = await World.create();
});

afterEach(async () => {
  await world.cleanup();
});

const BRIEF = outbox.brief({ summary: "Brief ready: the Save button turns red", brief: "## Summary\n\nTurn it red.\n" });

describe("hold", () => {
  test("lets a running session finish and starts no new one, and start ends it", async () => {
    const first = world.issue({ title: "Save button is blue" });
    world.send(first);
    world.harness.script(first.identifier, { outbox: BRIEF });
    await world.tick();
    expect(world.harness.started).toHaveLength(1);

    await world.hold();
    const second = world.issue({ title: "Cancel button is green" });
    world.send(second);
    world.harness.finish(world.harness.started[0]!.session.id, { kind: "exited", code: 0 });
    await world.tick();
    // The held runner still applies the finished session's outbox, and takes nothing.
    expect(world.tracker.stored(first.id).status).toBe("Ready to build");
    expect(world.tracker.stored(second.id).status).toBe("Ready to plan");
    expect(world.harness.started).toHaveLength(1);
    expect((await world.status()).runner).toEqual({
      state: "held",
      holds: [{ cause: "maintainer", scope: "runner", name: null, since: "2026-11-10T09:01:00.000Z", until: null }],
    });

    await world.start();
    await world.tick();
    expect(world.harness.started.map((each) => each.session.issue)).toEqual([first.identifier, second.identifier]);
    expect((await world.status()).runner).toEqual({ state: "working", holds: [] });
  });
});

/** The writes on the issue after its last move to Planning. */
function afterTake(issue: StoredIssue) {
  const writes = world.tracker.writes.filter((write) => "issue" in write && write.issue === issue.identifier);
  const take = writes.findLastIndex((write) => write.kind === "move" && write.status === "Planning");
  return writes.slice(take + 1);
}

/** The ⚪ stop pause, with the facts in its fold. */
function stopComment(facts: string[]): string {
  return [
    "⚪ Stopped: you stopped Flight Deck while plan ran",
    "",
    "Reply with one word:",
    "",
    "- **retry**: plan runs again. Moves the issue to Ready to plan.",
    "",
    "Any other reply leaves the issue paused until you move it.",
    "",
    "+++ Details",
    "",
    ...facts,
    "",
    `Flight Deck ${world.version} · runner`,
    "",
    "+++",
  ].join("\n");
}

describe("stop", () => {
  test("stops every session, pauses each running and retry-waiting issue with the ⚪ text and no flag, and revokes the runner's token", async () => {
    const running = world.issue({ title: "Save button is blue" });
    const retrying = world.issue({ title: "Cancel button is green" });
    world.send(running);
    world.send(retrying);
    world.harness.script(running.identifier, {});
    world.harness.script(retrying.identifier, { exit: { kind: "timed_out" } });
    await world.tick();
    const [first, second] = world.harness.started.map((each) => each.session);
    // One place, which the running session holds, so the failed one's retry waits.
    world.config.concurrency_cap = 1;
    await world.writeConfig();
    await world.tick();
    expect((await world.status()).sessions.map(({ issue, state }) => ({ issue, state }))).toEqual([
      { issue: running.identifier, state: "running" },
      { issue: retrying.identifier, state: "retry_waiting" },
    ]);

    const stoppedAt = world.now.toISOString();
    await world.stop();
    expect(world.harness.stops).toEqual([first!.id]);
    expect(world.tracker.runnerRevokes).toEqual(["campdotdev"]);
    // The retry-waiting issue has no session to stop, so it pauses at once.
    expect(afterTake(retrying)).toEqual([
      { kind: "comment", issue: retrying.identifier, body: stopComment([`- Session: \`${second!.id}\``, "- Attempt: 2"]) },
      { kind: "move", issue: retrying.identifier, status: "Paused" },
    ]);

    await world.tick();
    expect(afterTake(running)).toEqual([
      {
        kind: "comment",
        issue: running.identifier,
        body: stopComment(["- Exit: `stopped`", `- Session: \`${first!.id}\``, "- Attempt: 1", `- Transcript: \`${first!.transcript}\``]),
      },
      { kind: "move", issue: running.identifier, status: "Paused" },
    ]);
    expect(world.tracker.stored(running.id).assignee).toBeNull();
    expect(world.harness.started).toHaveLength(2);
    const status = await world.status();
    expect(status.runner).toEqual({ state: "stopped", holds: [{ cause: "stop", scope: "runner", name: null, since: stoppedAt, until: null }] });
    expect(status.sessions).toEqual([]);
    expect(status.flags).toEqual([]);
  });

  test("leaves the issue paused until its retry, which a started runner takes with attempt 1", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    world.harness.script(issue.identifier, {});
    await world.tick();
    await world.stop();
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Paused");

    world.reply(issue, "retry");
    await world.tick();
    // A stopped runner still takes answers, and starts nothing.
    expect(world.tracker.stored(issue.id).status).toBe("Ready to plan");
    expect(world.harness.started).toHaveLength(1);

    await world.start();
    await world.tick();
    expect(world.harness.started).toHaveLength(2);
    expect(world.harness.started[1]!.sessionJson.attempt).toBe(1);
    expect((await world.status()).runner).toEqual({ state: "working", holds: [] });
  });

  test("pauses with the ⚪ text, not a retry, a session that failed just before the stop reached it", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    world.harness.script(issue.identifier, {});
    await world.tick();
    const session = world.harness.started[0]!.session;
    world.harness.finish(session.id, { kind: "timed_out" });
    await world.stop();
    await world.tick();
    expect(afterTake(issue)).toEqual([
      {
        kind: "comment",
        issue: issue.identifier,
        body: stopComment(["- Exit: `timed_out`", `- Session: \`${session.id}\``, "- Attempt: 1", `- Transcript: \`${session.transcript}\``]),
      },
      { kind: "move", issue: issue.identifier, status: "Paused" },
    ]);
    expect((await world.status()).sessions).toEqual([]);
  });

  test("replaces a hold's marker, and a later hold leaves the stop in place", async () => {
    await world.hold();
    await world.tick();
    const stoppedAt = world.now.toISOString();
    await world.stop();
    await world.hold();
    await world.tick();
    expect((await world.status()).runner).toEqual({ state: "stopped", holds: [{ cause: "stop", scope: "runner", name: null, since: stoppedAt, until: null }] });
  });
});

describe("a runner that starts under a stop marker", () => {
  test("treats each listed session as stopped: it pauses the issue with the ⚪ text and uses no retry", async () => {
    const running = world.issue({ title: "Save button is blue" });
    const retrying = world.issue({ title: "Cancel button is green" });
    world.send(running);
    world.send(retrying);
    world.harness.script(running.identifier, {});
    world.harness.script(retrying.identifier, { exit: { kind: "timed_out" } });
    await world.tick();
    const [first, second] = world.harness.started.map((each) => each.session);
    world.config.concurrency_cap = 1;
    await world.writeConfig();
    await world.tick();

    // The runner didn't answer `flight-deck stop`, so the command wrote the marker, and launchd restarted the runner.
    const stoppedAt = world.now.toISOString();
    await world.writeHoldMarker("stop");
    world.restart();
    await world.tick();
    expect(afterTake(running)).toEqual([
      {
        kind: "comment",
        issue: running.identifier,
        body: stopComment([`- Session: \`${first!.id}\``, "- Attempt: 1", `- Transcript: \`${first!.transcript}\``]),
      },
      { kind: "move", issue: running.identifier, status: "Paused" },
    ]);
    expect(afterTake(retrying)).toEqual([
      { kind: "comment", issue: retrying.identifier, body: stopComment([`- Session: \`${second!.id}\``, "- Attempt: 2"]) },
      { kind: "move", issue: retrying.identifier, status: "Paused" },
    ]);
    expect(world.harness.started).toHaveLength(2);
    const status = await world.status();
    expect(status.sessions).toEqual([]);
    expect(status.runner).toEqual({ state: "stopped", holds: [{ cause: "stop", scope: "runner", name: null, since: stoppedAt, until: null }] });
  });

  test("under a hold's marker stays held, pauses nothing, and starts nothing", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    world.harness.script(issue.identifier, {});
    await world.tick();
    await world.writeHoldMarker("hold");
    const queued = world.issue({ title: "Cancel button is green" });
    world.send(queued);
    world.restart();
    await world.tick();
    expect(world.tracker.writes.filter((write) => write.kind === "comment")).toEqual([]);
    expect(world.tracker.stored(queued.id).status).toBe("Ready to plan");
    expect(world.harness.started).toHaveLength(1);
    expect((await world.status()).runner.state).toBe("held");
  });
});
