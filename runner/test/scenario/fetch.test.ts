// A failed fetch keeps the last fetched commit and logs the error (spec 1, "Workspace"), so sessions go on starting
// from that commit while the remote can't be reached.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { outbox, World } from "./world.ts";

let world: World | undefined;

afterEach(async () => {
  await world?.cleanup();
  world = undefined;
});

test("a failed fetch keeps the last fetched commit, and a sent issue starts from it", async () => {
  world = await World.create();
  await world.tick();
  // A remote that's gone fails the fetch without an authentication error, so nothing holds the runner.
  world.config.repos[0]!.remote = join(world.root, "nowhere.git");
  await world.writeConfig();
  const issue = world.issue({ title: "Save button is blue", description: "It should be red." });
  world.send(issue);
  world.harness.script(issue.identifier, { outbox: outbox.brief({ summary: "Brief ready: red", brief: "## Summary\n\nRed." }) });
  await world.tick();

  expect(world.harness.started.map((each) => each.sessionJson.commit)).toEqual([world.commit]);
  expect((await world.status()).repos[0]!.record).toBe("ok");
});

test("a retry starts from the last fetched commit while the fetch fails", async () => {
  world = await World.create();
  const issue = world.issue({ title: "Save button is blue", description: "It should be red." });
  world.send(issue);
  world.harness.script(issue.identifier, { exit: { kind: "exited", code: 1 } });
  await world.tick();
  world.config.repos[0]!.remote = join(world.root, "nowhere.git");
  await world.writeConfig();
  world.harness.script(issue.identifier, {});
  await world.tick();

  expect(world.harness.started.map((each) => [each.sessionJson.commit, each.sessionJson.attempt])).toEqual([
    [world.commit, 1],
    [world.commit, 2],
  ]);
});
