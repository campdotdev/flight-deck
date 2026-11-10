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
}, 30_000);

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
}, 30_000);
