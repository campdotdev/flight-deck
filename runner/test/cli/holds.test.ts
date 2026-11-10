// `flight-deck hold`, `start`, and `stop` (spec 1, "The runner's socket" and "Holds"): each one asks the runner
// over `runner.sock`, and when the runner doesn't answer, writes or removes the hold marker itself, which the
// runner reads at its next start.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { outbox, World } from "../scenario/world.ts";
import { cli, listen } from "./cli.ts";
import type { RunnerSocket } from "../../src/runner/index.ts";
import type { StatusHold } from "../../src/state/index.ts";

let world: World;
let socket: RunnerSocket | null;

beforeEach(async () => {
  world = await World.create();
  socket = null;
});

afterEach(async () => {
  await socket?.close();
  await world.cleanup();
});

const HELD: StatusHold = { cause: "maintainer", scope: "runner", name: null, since: "2026-11-10T09:00:00.000Z", until: null };

describe("over the socket", () => {
  test("hold holds the runner, and start ends the hold", async () => {
    socket = await listen(world);
    const command = cli(world);
    expect(await command.run("hold")).toBe(0);
    await world.tick();
    expect((await world.status()).runner).toEqual({ state: "held", holds: [HELD] });

    expect(await command.run("start")).toBe(0);
    await world.tick();
    expect((await world.status()).runner).toEqual({ state: "working", holds: [] });
    expect(command.out).toEqual([
      "Flight Deck is held: running sessions finish, and no new session starts. Run flight-deck start to end the hold.",
      "Flight Deck is working: the hold has ended.",
    ]);
  });

  test("stop stops each running session at once, with no confirmation", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    world.harness.script(issue.identifier, {});
    await world.tick();
    socket = await listen(world);

    expect(await cli(world).run("stop")).toBe(0);
    expect(world.harness.stops).toEqual([world.harness.started[0]!.session.id]);
    await world.tick();
    expect((await world.status()).runner.state).toBe("stopped");
    expect(world.tracker.stored(issue.id).status).toBe("Paused");
  });
});

describe("when the runner doesn't answer", () => {
  test("hold writes the marker, and the next runner starts held", async () => {
    const command = cli(world);
    expect(await command.run("hold")).toBe(0);
    expect(command.out).toEqual([
      "The runner didn't answer, so Flight Deck wrote the hold marker. The runner reads it at its next start.",
    ]);
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    world.restart();
    await world.tick();
    expect((await world.status()).runner).toEqual({ state: "held", holds: [HELD] });
    expect(world.harness.started).toHaveLength(0);
  });

  test("hold keeps a stop's marker", async () => {
    const command = cli(world);
    expect(await command.run("stop")).toBe(0);
    expect(await command.run("hold")).toBe(0);
    await world.tick();
    expect((await world.status()).runner.state).toBe("stopped");
  });

  test("stop writes the stop marker, and the next runner pauses each listed session as stopped", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    world.harness.script(issue.identifier, { outbox: outbox.brief({ summary: "Brief ready", brief: "## Summary\n\nTurn it red.\n" }) });
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Planning");

    const command = cli(world);
    expect(await command.run("stop")).toBe(0);
    expect(command.out).toEqual([
      "The runner didn't answer, so Flight Deck wrote the stop marker. The runner stops every session at its next start.",
    ]);
    world.restart();
    await world.tick();
    expect((await world.status()).runner.state).toBe("stopped");
    expect(world.tracker.stored(issue.id).status).toBe("Paused");
  });

  test("start removes the marker", async () => {
    const command = cli(world);
    await command.run("hold");
    expect(await command.run("start")).toBe(0);
    expect(command.out.at(-1)).toBe("The runner didn't answer, so Flight Deck removed the hold marker. The runner starts work at its next poll.");
    await world.tick();
    expect((await world.status()).runner).toEqual({ state: "working", holds: [] });
  });
});
