// A session's helpers (spec 1, "Session credentials"): `flight-deck linear-token <session-id>` asks the runner
// for the session's Reader token and prints the `Authorization` header, and `flight-deck api-key` prints the
// Claude API key from `credentials.env`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunnerSocket } from "../../src/runner/index.ts";
import { outbox, World } from "../scenario/world.ts";
import { cli, listen } from "./cli.ts";

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

describe("linear-token", () => {
  test("prints the Authorization header with the session's Reader token, as a JSON object of headers", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    world.harness.script(issue.identifier, {});
    await world.tick();
    socket = await listen(world);
    const id = world.harness.started[0]!.session.id;
    const token = world.tracker.tokens.find((record) => record.session === id)!.token;

    const command = cli(world);
    expect(await command.run("linear-token", id)).toBe(0);
    expect(command.out).toEqual([JSON.stringify({ Authorization: `Bearer ${token}` })]);
    // Asked again, the runner returns the same token while Linear takes it.
    expect(await command.run("linear-token", id)).toBe(0);
    expect(command.out[1]).toBe(command.out[0]!);
    expect(world.tracker.tokens.filter((record) => record.session === id)).toHaveLength(1);
  });

  test("gets a replacement after Linear rejects the token", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    world.harness.script(issue.identifier, {});
    await world.tick();
    socket = await listen(world);
    const id = world.harness.started[0]!.session.id;
    const first = world.tracker.tokens.find((record) => record.session === id)!.token;
    world.tracker.rejectToken(first);

    const command = cli(world);
    expect(await command.run("linear-token", id)).toBe(0);
    const second = world.tracker.tokens.filter((record) => record.session === id).at(-1)!.token;
    expect(second).not.toBe(first);
    expect(command.out).toEqual([JSON.stringify({ Authorization: `Bearer ${second}` })]);
  });

  test("gets no token for a session the list doesn't hold", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    world.harness.script(issue.identifier, { outbox: outbox.brief({ summary: "Brief ready", brief: "## Summary\n\nTurn it red.\n" }), exit: { kind: "exited", code: 0 } });
    await world.tick();
    const ended = world.harness.started[0]!.session.id;
    await world.tick();
    socket = await listen(world);
    const mints = world.tracker.tokens.length;

    const command = cli(world);
    expect(await command.run("linear-token", ended)).toBe(1);
    expect(await command.run("linear-token", "zzzzzz")).toBe(1);
    expect(command.out).toEqual([]);
    expect(command.err).toEqual([
      `The runner gave no Linear token: no session ${ended} is running.`,
      "The runner gave no Linear token: no session zzzzzz is running.",
    ]);
    expect(world.tracker.tokens).toHaveLength(mints);
  });

  test("fails when the runner doesn't answer", async () => {
    const command = cli(world);
    expect(await command.run("linear-token", "abc123")).toBe(1);
    expect(command.err).toEqual(["The runner didn't answer, so there's no Linear token for session abc123."]);
  });
});

describe("api-key", () => {
  test("prints ANTHROPIC_API_KEY from credentials.env", async () => {
    const credentials = await readFile(join(world.folders.config, "credentials.env"), "utf8");
    await world.writeCredentials(`${credentials}ANTHROPIC_API_KEY=sk-ant-test\n`);
    const command = cli(world);
    expect(await command.run("api-key")).toBe(0);
    expect(command.out).toEqual(["sk-ant-test"]);
  });

  test("fails when credentials.env holds no API key", async () => {
    const command = cli(world);
    expect(await command.run("api-key")).toBe(1);
    expect(command.err).toEqual(["credentials.env holds no ANTHROPIC_API_KEY. Run flight-deck install to choose an API key."]);
  });
});
