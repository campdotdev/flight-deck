// When the daily sweep runs, and what it leaves alone (spec 1, "Workspace"). Times are in the Mac's time zone.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { World } from "./world.ts";

setDefaultTimeout(30_000);

let world: World;

beforeEach(async () => {
  world = await World.create();
});

afterEach(async () => {
  await world.cleanup();
});

/** A worktree and a session folder that no session in the session list holds, as a crash leaves them. */
async function strays(): Promise<string[]> {
  const left = [join(world.folders.sessionRoot, "worktrees", "zzzzzz"), join(world.folders.sessionRoot, "sessions", "zzzzzz")];
  for (const folder of left) await mkdir(folder, { recursive: true });
  return left;
}

const local = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute);

describe("the daily sweep", () => {
  test("runs at the first poll after 03:00, and leaves a running session's worktree and session folder", async () => {
    await world.tick(local(11, 1));
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    await world.tick(local(11, 1, 1));
    const session = world.harness.started[0]!.session;

    const left = await strays();
    await world.tick(local(11, 2, 59));
    for (const folder of left) expect(existsSync(folder)).toBe(true);

    await world.tick(local(11, 3, 1));
    for (const folder of left) expect(existsSync(folder)).toBe(false);
    expect(existsSync(session.worktree)).toBe(true);
    expect(existsSync(session.sessionFolder)).toBe(true);

    // Once a day.
    const later = await strays();
    await world.tick(local(11, 3, 2));
    for (const folder of later) expect(existsSync(folder)).toBe(true);
  });

  test("runs at a start only when the last sweep was more than 24 hours ago", async () => {
    await world.tick(local(11, 4));
    const left = await strays();
    world.restart();
    await world.tick(local(11, 20));
    for (const folder of left) expect(existsSync(folder)).toBe(true);

    world.restart();
    await world.tick(local(12, 4, 1));
    for (const folder of left) expect(existsSync(folder)).toBe(false);
  });
});
