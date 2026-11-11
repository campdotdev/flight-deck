// A poll Linear doesn't take for one repo, such as `RATELIMITED`, skips that repo until the next poll and logs
// it, and every other repo polls as usual (spec 1, "Polls", ADR 0002).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { World } from "./world.ts";

let world: World;

beforeEach(async () => {
  world = await World.create();
});

afterEach(async () => {
  await world.cleanup();
});

test("a rate-limited snapshot skips its repo until the next poll, and the other repo still starts", async () => {
  await world.addRepo({ name: "campdotdev/docs", team: "DOC" });
  world.config.concurrency_cap = 10;
  await world.writeConfig();
  const shaders = world.issue({ title: "Shaders" });
  const docs = world.issue({ title: "Docs", team: "DOC" });
  world.send(shaders);
  world.send(docs);
  world.tracker.refuse("snapshot", { reason: "rate_limited" });

  await world.tick();
  expect(world.harness.started.map((each) => each.session.issue)).toEqual([docs.identifier]);
  expect(world.tracker.stored(shaders.id).status).toBe("Ready to plan");

  await world.tick();
  expect(world.harness.started.map((each) => each.session.issue)).toEqual([docs.identifier, shaders.identifier]);
});

test("a take Linear doesn't take holds no place under the cap, and the next poll takes the issue", async () => {
  world.config.concurrency_cap = 1;
  await world.writeConfig();
  const first = world.issue({ title: "First", priority: 1 });
  const second = world.issue({ title: "Second", priority: 2 });
  world.send(first);
  world.send(second);
  world.harness.script(first.identifier, {});
  world.tracker.refuse("move");

  await world.tick();
  expect(world.harness.started).toEqual([]);
  expect(world.tracker.stored(first.id).status).toBe("Ready to plan");

  await world.tick();
  expect(world.harness.started.map((each) => each.session.issue)).toEqual([first.identifier]);
  expect(world.tracker.stored(first.id).status).toBe("Planning");
  expect((await world.status()).sessions.map(({ issue, state }) => [issue, state])).toEqual([[first.identifier, "running"]]);
});

test("a requeue Linear doesn't take keeps the session's entry and exit, and the next poll requeues the issue", async () => {
  const issue = world.issue({ title: "Save button is blue" });
  world.send(issue);
  world.harness.script(issue.identifier, { exit: { kind: "rate_limited", resetsAt: null } });
  await world.tick();
  expect(world.harness.started).toHaveLength(1);

  world.tracker.refuse("move", { times: 1 });
  await world.tick();
  expect(world.tracker.stored(issue.id).status).toBe("Planning");
  expect((await world.status()).sessions.map(({ issue }) => issue)).toEqual([issue.identifier]);

  await world.tick();
  expect(world.tracker.stored(issue.id).status).toBe("Ready to plan");
  expect((await world.status()).sessions).toEqual([]);
});

test("an exit whose handling Linear doesn't take leaves the next session's exit handled", async () => {
  world.config.concurrency_cap = 2;
  await world.writeConfig();
  const first = world.issue({ title: "First", priority: 1 });
  const second = world.issue({ title: "Second", priority: 2 });
  world.send(first);
  world.send(second);
  world.harness.script(first.identifier, { exit: { kind: "rate_limited", resetsAt: null } });
  world.harness.script(second.identifier, { exit: { kind: "login_expired" } });
  await world.tick();
  expect(world.harness.started).toHaveLength(2);

  // One exit's requeue move fails, and the other's still lands.
  world.tracker.refuse("move", { times: 1 });
  await world.tick();
  expect([first, second].map((issue) => world.tracker.stored(issue.id).status).sort()).toEqual(["Planning", "Ready to plan"]);

  await world.tick();
  expect([first, second].map((issue) => world.tracker.stored(issue.id).status)).toEqual(["Ready to plan", "Ready to plan"]);
});
