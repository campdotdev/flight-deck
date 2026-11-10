// `runner.sock` (spec 1, "The runner's socket"): one line of JSON per request and per reply, mode `0600`, with
// every op spec 1 lists. `hold`, `start`, `stop`, and `linear_token` are tested through their commands in
// `test/cli/`; this file covers the ops no maintainer command sends on its own.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { paths } from "../../src/folders/index.ts";
import type { RunnerSocket } from "../../src/runner/index.ts";
import { readJson } from "../../src/state/index.ts";
import { ask, type Reply, type Request } from "../../src/socket/index.ts";
import { listen } from "../cli/cli.ts";
import { World } from "../scenario/world.ts";

let world: World;
let socket: RunnerSocket;

beforeEach(async () => {
  world = await World.create();
  socket = await listen(world);
});

afterEach(async () => {
  await socket.close();
  await world.cleanup();
});

function socketPath(): string {
  return join(world.folders.data, "state", "runner.sock");
}

function send(request: Request): Promise<Reply | null> {
  return ask(socketPath(), request, 5_000);
}

test("the socket has mode 0600, and close removes it", async () => {
  expect((await stat(socketPath())).mode & 0o777).toBe(0o600);
  await socket.close();
  await expect(stat(socketPath())).rejects.toThrow();
  socket = await listen(world);
});

test("a line that isn't a request, and an op the runner doesn't have, get an error reply", async () => {
  const reply = await new Promise<string>((resolve) => {
    const connection = createConnection(socketPath(), () => connection.write("not json\n"));
    connection.setEncoding("utf8");
    connection.on("data", (chunk: string) => {
      resolve(chunk);
      connection.destroy();
    });
  });
  expect(JSON.parse(reply)).toEqual({ ok: false, error: "the request isn't one line of JSON" });
  expect(await send({ op: "dance" })).toEqual({ ok: false, error: 'the runner has no op "dance"' });
});

describe("the update hold", () => {
  test("holds the runner until its release, and a new runner doesn't keep it", async () => {
    expect(await send({ op: "hold", cause: "update" })).toEqual({ ok: true });
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    await world.tick();
    expect(world.harness.started).toHaveLength(0);
    expect((await world.status()).runner).toEqual({
      state: "held",
      holds: [{ cause: "update", scope: "runner", name: null, since: "2026-11-10T09:00:00.000Z", until: null }],
    });

    expect(await send({ op: "release", cause: "update" })).toEqual({ ok: true });
    world.harness.script(issue.identifier, {});
    await world.tick();
    expect(world.harness.started).toHaveLength(1);
    expect((await world.status()).runner).toEqual({ state: "working", holds: [] });

    // The new runner ends the update hold at its start.
    expect(await send({ op: "hold", cause: "update" })).toEqual({ ok: true });
    world.restart();
    await world.tick();
    expect((await world.status()).runner.holds).toEqual([]);
  });

  test("release names only the update cause, and hold no other cause", async () => {
    expect(await send({ op: "release", cause: "maintainer" })).toEqual({ ok: false, error: 'only flight-deck update releases a hold, with cause "update"' });
    expect(await send({ op: "hold", cause: "plan_limit" })).toEqual({ ok: false, error: 'hold takes no cause but "update"' });
  });
});

test("sessions returns the session list", async () => {
  expect(await send({ op: "sessions" })).toEqual({ ok: true, sessions: [] });
  const issue = world.issue({ title: "Save button is blue" });
  world.send(issue);
  world.harness.script(issue.identifier, {});
  await world.tick();
  const reply = await send({ op: "sessions" });
  expect(reply).toMatchObject({ ok: true, sessions: [{ id: world.harness.started[0]!.session.id, issue: issue.identifier, state: "running", stage: "plan" }] });
});

test("trial returns once the trial ends, with its result", async () => {
  world.harness.script("", { outbox: { "summary.md": "The trial ran.\n" }, exit: { kind: "exited", code: 0 } });
  let reply: Reply | null | undefined;
  const asked = ask(socketPath(), { op: "trial" }, 30_000).then((each) => (reply = each));
  for (let i = 0; i < 5 && reply === undefined; i++) {
    await Bun.sleep(50);
    await world.tick();
  }
  await asked;
  expect(reply).toEqual({ ok: true, result: "passed", session: expect.any(String), exit: { kind: "exited", code: 0 } });
  // Install's trial step is done once state/trial.json names the running version.
  const session = world.harness.started[0]!.session.id;
  expect(await readJson<unknown>(paths.trial(world.folders), null)).toEqual({ version: world.version, claude_code_version: "2.1.321", session, passed_at: world.now.toISOString() });
});

test("a trial that fails returns its exit, and records no pass", async () => {
  world.harness.script("", { exit: { kind: "no_init" } });
  let reply: Reply | null | undefined;
  const asked = ask(socketPath(), { op: "trial" }, 30_000).then((each) => (reply = each));
  for (let i = 0; i < 5 && reply === undefined; i++) {
    await Bun.sleep(50);
    await world.tick();
  }
  await asked;
  expect(reply).toEqual({ ok: true, result: "failed", session: expect.any(String), exit: { kind: "no_init" } });
  expect(await readJson(paths.trial(world.folders), null)).toBeNull();
});

test("notify posts a macOS notification", async () => {
  expect(await send({ op: "notify", text: "Flight Deck can notify you." })).toEqual({ ok: true });
  expect(await world.notifications()).toEqual(["Flight Deck can notify you."]);
});

describe("issue_memory", () => {
  test("merges a hand run's write into the issue's memory, which the next poll publishes", async () => {
    const issue = world.issue({ title: "Save button is blue", status: "Paused" });
    // A flagged issue is assigned to the maintainer, or the poll takes the flag as cleared.
    world.tracker.setAssignee(issue.id, world.maintainer.id);
    const flag = { cause: "pause", status_line: "🟡 Needs your help: which color?", since: "2026-11-10T08:59:00.000Z", issue: issue.identifier, title: issue.title, url: "https://linear.app/x" };
    expect(await send({ op: "issue_memory", repo: world.repo, issue: issue.id, write: { flag } })).toEqual({ ok: true });
    await world.tick();
    expect((await world.status()).flags).toEqual([
      { repo: world.repo, issue: issue.identifier, title: issue.title, url: expect.any(String), status_line: flag.status_line, since: flag.since },
    ]);
  });

  test("refuses an unregistered repo, an issue that isn't a UUID, and a field issue memory doesn't have", async () => {
    expect(await send({ op: "issue_memory", repo: "campdotdev/other", issue: "abc", write: { brief: "x" } })).toEqual({
      ok: false,
      error: "campdotdev/other isn't registered on this Mac",
    });
    expect(await send({ op: "issue_memory", repo: world.repo, issue: "../../x", write: { brief: "x" } })).toEqual({ ok: false, error: 'issue "../../x" isn\'t an issue UUID' });
    expect(await send({ op: "issue_memory", repo: world.repo, issue: "abc", write: { color: "red" } })).toEqual({ ok: false, error: "issue memory has no field color" });
  });
});
