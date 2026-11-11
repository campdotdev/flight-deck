// `flight-deck runner` (spec 1, "Poll", "Exits", and "Tokens"): the process launchd keeps alive. It ticks about
// once a minute, listens on `runner.sock`, writes its own log, and on SIGTERM stops each running session as
// `shutdown`, revokes its Linear token, and exits.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { startRunner, type Runner } from "../../src/runner/index.ts";
import { ask, listen } from "../../src/socket/index.ts";
import { World } from "../scenario/world.ts";

let world: World;
let runner: Runner | null;
let closed: number;

beforeEach(async () => {
  world = await World.create();
  runner = null;
  closed = 0;
});

afterEach(async () => {
  await runner?.terminate();
  await world.cleanup();
});

function start(intervalMs = 60_000): Promise<Runner> {
  return startRunner({
    folders: world.folders,
    version: world.version,
    versionFolder: world.versionFolder,
    tracker: world.tracker,
    harness: world.harness,
    closeHarness: async () => void closed++,
    path: `${join(world.root, "bin")}:${process.env.PATH ?? ""}`,
    clock: () => world.now,
    intervalMs,
  });
}

const socketPath = () => join(world.folders.data, "state", "runner.sock");

/** Waits until `check` holds, for at most 10 seconds. */
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await Bun.sleep(50);
  }
  throw new Error("timed out");
}

test("ticks at its start and then on its interval, answers on the socket, and writes its own log", async () => {
  runner = await start(100);
  await until(() => existsSync(join(world.folders.data, "state", "status.json")));
  expect(await ask(socketPath(), { op: "sessions" }, 5_000)).toEqual({ ok: true, sessions: [] });

  const issue = world.issue({ title: "Save button is blue" });
  world.send(issue);
  world.harness.script(issue.identifier, {});
  await until(() => world.harness.started.length === 1);
  const log = await readFile(join(world.folders.data, "state", "runner.log"), "utf8");
  expect(log).toContain(`runner ${world.version} started, pid ${process.pid}`);
});

test("on SIGTERM, stops each running session as shutdown, revokes its token, and lets the harness go", async () => {
  runner = await start();
  const issue = world.issue({ title: "Save button is blue" });
  world.send(issue);
  world.harness.script(issue.identifier, {});
  await runner.tick();
  expect(world.harness.started).toHaveLength(1);

  await runner.terminate();
  expect(world.harness.stops).toEqual([world.harness.started[0]!.session.id]);
  expect(world.tracker.runnerRevokes).toEqual(["campdotdev"]);
  expect(closed).toBe(1);
  expect(existsSync(socketPath())).toBe(false);
  expect(await readFile(join(world.folders.data, "state", "runner.log"), "utf8")).toContain("runner stopped on SIGTERM");
  // A second SIGTERM does nothing more.
  await runner.terminate();
  expect(closed).toBe(1);

  // The next runner puts the issue back in its queue with no comment, then takes it again in the same poll.
  const before = world.tracker.writes.length;
  world.harness.script(issue.identifier, {});
  world.restart();
  await world.tick();
  expect(world.tracker.writes.slice(before).filter((write) => write.kind === "move" || write.kind === "comment")).toEqual([
    { kind: "move", issue: issue.identifier, status: "Ready to plan" },
    { kind: "move", issue: issue.identifier, status: "Planning" },
  ]);
});

test("refuses to start while another runner listens on the socket", async () => {
  runner = await start();
  await expect(start()).rejects.toThrow("another runner is listening on");
});

test("refuses to start while another runner listens but is too busy to answer", async () => {
  const busy = await listen(socketPath(), () => new Promise<never>(() => {}));
  try {
    await expect(start()).rejects.toThrow("another runner is listening on");
  } finally {
    await busy.close();
  }
});

test("starts over a socket file a dead runner left", async () => {
  // A process that binds the socket and exits without removing it, as a runner that crashed does.
  await mkdir(dirname(socketPath()), { recursive: true });
  const bind = "import socket, sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])";
  expect(Bun.spawnSync(["python3", "-c", bind, socketPath()]).exitCode).toBe(0);
  expect(existsSync(socketPath())).toBe(true);
  runner = await start();
  expect(await ask(socketPath(), { op: "sessions" }, 5_000)).toEqual({ ok: true, sessions: [] });
});
