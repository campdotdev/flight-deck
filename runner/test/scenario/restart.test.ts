// Restarts, crashes, and shutdown (spec 1's "Watchdogs and exits" and "Exits", ADR 0002). Each restart builds a
// new Poll over the same data folder, as launchd does when it starts the runner again. The scripted Harness keeps
// the old runner's sessions, so a session the old runner started is still live after the restart until the new
// runner kills it, or `lose` ends it with nothing reported, as a power loss does.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { outbox, World } from "./world.ts";

let world: World;

beforeEach(async () => {
  world = await World.create();
});

afterEach(async () => {
  await world.cleanup();
});

describe("after a crash", () => {
  test("the new runner kills a live session, by its process ID and start time, and treats it as failed", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    world.harness.script(issue.identifier, {});
    world.harness.script(issue.identifier, {});
    await world.tick();
    const first = world.harness.started[0]!;

    world.restart();
    await world.tick();
    // Its output pipe died with the old runner, so the new one kills it and reports nothing for it.
    expect(world.harness.kills).toEqual([first.handle]);
    expect(world.harness.runningSessions()).not.toContain(first.session.id);
    // The one retry, in place: a fresh session with attempt 2, and no second take.
    expect(world.harness.started).toHaveLength(2);
    expect(world.harness.started[1]!.sessionJson.attempt).toBe(2);
    expect(world.tracker.writes.filter((write) => write.kind === "move")).toEqual([{ kind: "move", issue: issue.identifier, status: "Planning" }]);
    expect(world.tracker.stored(issue.id).status).toBe("Planning");
  });
});

/** The second-failure pause for a session still running when the old runner stopped, with the facts in its fold. */
function cutOffComment(fold: string[]): string {
  return [
    "🟡 Needs your help: plan failed twice",
    "",
    "Plan ran twice, and neither session handed off. The second one was still running when Flight Deck's runner stopped. Its transcript path is under Details.",
    "",
    "Reply with one word:",
    "",
    "- **retry**: plan runs again, with a fresh retry if it fails. Moves the issue to Ready to plan.",
    "",
    "Any other reply leaves the issue paused until you move it.",
    "",
    "+++ Details",
    "",
    ...fold,
    "",
    `Flight Deck ${world.version} · runner`,
    "",
    "+++",
  ].join("\n");
}

describe("after a power loss", () => {
  test("a session with no live process counts as failed, and a second one pauses the issue", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    world.harness.script(issue.identifier, {});
    world.harness.script(issue.identifier, {});
    await world.tick();
    world.harness.lose(world.harness.started[0]!.session.id);

    world.restart();
    await world.tick();
    expect(world.harness.kills).toEqual([]);
    expect(world.harness.started).toHaveLength(2);
    const second = world.harness.started[1]!;
    expect(second.sessionJson.attempt).toBe(2);

    world.harness.lose(second.session.id);
    world.restart();
    await world.tick();
    expect(world.harness.started).toHaveLength(2);
    expect(world.tracker.stored(issue.id).status).toBe("Paused");
    const comments = world.tracker.writes.filter((write) => write.kind === "comment");
    expect(comments).toEqual([
      {
        kind: "comment",
        issue: issue.identifier,
        body: cutOffComment([`- Session: \`${second.session.id}\``, "- Attempt: 2", `- Transcript: \`${second.session.transcript}\``]),
      },
    ]);
    expect((await world.status()).sessions).toEqual([]);
  });
});

describe("at a restart", () => {
  test("a session that exited before the old runner stopped has its outbox applied as usual", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    world.harness.script(issue.identifier, {
      outbox: outbox.brief({ summary: "Brief ready: the Save button turns red", brief: "## Summary\n\nTurn it red.\n" }),
      exit: { kind: "exited", code: 0 },
    });
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Planning");

    // The old runner stops before its next tick handles the exit. Only exit.json records it.
    world.restart();
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Ready to build");
    expect(world.tracker.stored(issue.id).description).toContain("Turn it red.");
    expect(world.harness.kills).toEqual([]);
    expect(world.harness.started).toHaveLength(1);
    expect((await world.status()).sessions).toEqual([]);
  });

  test("an entry left starting before the take is dropped with no retry used, and the issue is taken afresh", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    // The runner dies between the entry and the take: the take's move never answers, and the poll never ends.
    const move = world.tracker.move;
    let taking: () => void = () => {};
    const taken = new Promise<void>((resolve) => (taking = resolve));
    world.tracker.move = () => {
      taking();
      return new Promise<never>(() => {});
    };
    void world.tick();
    await taken;
    world.tracker.move = move;
    expect(world.tracker.stored(issue.id).status).toBe("Ready to plan");

    world.restart();
    await world.tick();
    expect(world.tracker.writes.filter((write) => write.kind === "move" || write.kind === "comment")).toEqual([{ kind: "move", issue: issue.identifier, status: "Planning" }]);
    expect(world.harness.started).toHaveLength(1);
    expect(world.harness.started[0]!.sessionJson.attempt).toBe(1);
    expect((await world.status()).sessions.map(({ issue, state }) => ({ issue, state }))).toEqual([{ issue: issue.identifier, state: "running" }]);
  });
});

test("a restart leaves alone a take the session list doesn't hold, such as a hand run", async () => {
  const listed = world.issue({ title: "Save button is blue" });
  world.send(listed);
  world.harness.script(listed.identifier, {});
  world.harness.script(listed.identifier, {});
  await world.tick();
  // The maintainer's own agent takes an issue by hand.
  const hand = world.issue({ title: "Cancel button is green", status: "Planning" });
  await world.tick();
  world.harness.lose(world.harness.started[0]!.session.id);

  world.restart();
  await world.tick();
  expect(world.tracker.stored(hand.id).status).toBe("Planning");
  // Step 7's unsubscribe is the only write on it, as on any issue in a factory status.
  expect(world.tracker.writes.filter((write) => "issue" in write && write.issue === hand.identifier).map((write) => write.kind)).toEqual(["unsubscribe"]);
  expect(world.harness.started.map((each) => each.session.issue)).toEqual([listed.identifier, listed.identifier]);
});

describe("SIGTERM from launchd", () => {
  test("stops each running session with no marker and no comment, and the next start requeues each issue with its attempt kept", async () => {
    const retried = world.issue({ title: "Save button is blue" });
    const fresh = world.issue({ title: "Cancel button is green" });
    world.send(retried);
    world.harness.script(retried.identifier, { exit: { kind: "timed_out" } });
    world.harness.script(retried.identifier, {});
    world.harness.script(retried.identifier, {});
    await world.tick();
    await world.tick();
    world.send(fresh);
    world.harness.script(fresh.identifier, {});
    world.harness.script(fresh.identifier, {});
    await world.tick();
    expect(world.harness.started.map(({ session, sessionJson }) => [session.issue, sessionJson.attempt])).toEqual([
      [retried.identifier, 1],
      [retried.identifier, 2],
      [fresh.identifier, 1],
    ]);
    const writesBefore = world.tracker.writes.length;

    await world.shutdown();
    expect(world.harness.stops).toEqual([world.harness.started[1]!.session.id, world.harness.started[2]!.session.id]);
    expect(world.harness.runningSessions()).toEqual([]);
    expect(world.tracker.writes.slice(writesBefore)).toEqual([]);
    expect(world.tracker.runnerRevokes).toEqual(["campdotdev"]);

    world.restart();
    await world.tick();
    // Back in the queue with no comment, then taken again in the same poll, keeping the attempt.
    expect(world.tracker.writes.slice(writesBefore).filter((write) => write.kind === "move" || write.kind === "comment")).toEqual([
      { kind: "move", issue: retried.identifier, status: "Ready to plan" },
      { kind: "move", issue: fresh.identifier, status: "Ready to plan" },
      { kind: "move", issue: retried.identifier, status: "Planning" },
      { kind: "move", issue: fresh.identifier, status: "Planning" },
    ]);
    expect(world.harness.started.slice(3).map(({ session, sessionJson }) => [session.issue, sessionJson.attempt])).toEqual([
      [retried.identifier, 2],
      [fresh.identifier, 1],
    ]);
    expect((await world.status()).runner).toEqual({ state: "working", holds: [] });
  });
});
