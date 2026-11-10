// A poll Linear doesn't take for one repo, such as `RATELIMITED`, skips that repo until the next poll and logs
// it, and every other repo polls as usual (spec 1, "Polls", ADR 0002).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
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
  const log = await Bun.file(join(world.folders.data, "state", "runner.log")).text();
  expect(log).toContain("campdotdev/shaders: Linear didn't take the poll (rate_limited), so the repo waits for the next poll");

  await world.tick();
  expect(world.harness.started.map((each) => each.session.issue)).toEqual([docs.identifier, shaders.identifier]);
}, 30_000);
