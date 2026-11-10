// The dependency cache at the seam: a refresh before a repo's first session and after its default branch
// moves, the sessions a running refresh holds back, and a failed refresh (spec 1, "Workspace" and "Starts").
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SHADERS_RECORD, World } from "./world.ts";

// Each of these runs several real refreshes and many polls.
setDefaultTimeout(30_000);

let world: World;

afterEach(async () => {
  await world.cleanup();
});

const HOUR = 60 * 60_000;

const takes = () => world.tracker.writes.filter((write) => write.kind === "move");

/** The test record with another dependency install. */
const withInstall = (command: string) => SHADERS_RECORD.replace(/^command = .*$/m, `command = '${command}'`);

describe("the dependency cache", () => {
  test("a repo's first session waits for its first refresh, which shows under jobs", async () => {
    world = await World.create({ cache: false });
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);

    await world.tick();
    expect(world.harness.started).toEqual([]);
    expect(takes()).toEqual([]);
    let status = await world.status();
    expect(status.jobs).toEqual([{ kind: "cache_refresh", repo: world.repo, started_at: world.now.toISOString() }]);
    expect(status.repos.map((repo) => repo.cache)).toEqual(["refreshing"]);

    await world.poll.refreshesEnded();
    await world.tick();
    expect(world.harness.started.map((start) => start.session.issue)).toEqual([issue.identifier]);
    status = await world.status();
    expect(status.jobs).toEqual([]);
    expect(status.repos.map((repo) => repo.cache)).toEqual(["ok"]);
    // The session's node_modules is its own clone of the cache.
    const worktree = world.harness.started[0]!.session.worktree;
    expect(await readFile(join(worktree, "node_modules", "pkg", "index.js"), "utf8")).toBe("installed\n");
  });

  test("a repo with a good cache starts sessions at once and runs no refresh", async () => {
    world = await World.create();
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    await world.tick();
    expect(world.harness.started.map((start) => start.session.issue)).toEqual([issue.identifier]);
    const status = await world.status();
    expect(status.jobs).toEqual([]);
    expect(status.repos.map((repo) => repo.cache)).toEqual(["ok"]);
  });

  test("a moved default branch refreshes the cache, and the repo starts no session while it runs", async () => {
    world = await World.create();
    await world.push({ "src/a.ts": "export {};\n" }, "Change", { refresh: false });
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);

    await world.tick();
    expect(world.harness.started).toEqual([]);
    expect((await world.status()).jobs).toEqual([{ kind: "cache_refresh", repo: world.repo, started_at: world.now.toISOString() }]);

    await world.poll.refreshesEnded();
    await world.tick();
    expect(world.harness.started.map((start) => start.session.issue)).toEqual([issue.identifier]);
    expect((await world.status()).jobs).toEqual([]);
  });

  test("a retry waiting for its place doesn't start while the repo's refresh runs", async () => {
    world = await World.create();
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    world.harness.script(issue.identifier, { exit: { kind: "timed_out" } });
    world.harness.script(issue.identifier, {});
    await world.tick();
    await world.push({ "src/a.ts": "export {};\n" }, "Change", { refresh: false });

    await world.tick();
    expect(world.harness.started).toHaveLength(1);
    expect((await world.status()).sessions.map(({ state }) => state)).toEqual(["retry_waiting"]);

    await world.poll.refreshesEnded();
    await world.tick();
    expect(world.harness.started.map((start) => start.sessionJson.attempt)).toEqual([1, 2]);
  });

  test("a failed refresh keeps the last good cache, shows failed, and runs again only after an hour", async () => {
    world = await World.create();
    await world.push({ ".flight-deck/record.toml": withInstall("mkdir -p node_modules/pkg && echo broken > node_modules/pkg/index.js && exit 1") }, "Break", { refresh: false });

    await world.tick();
    const failedAt = world.now;
    await world.poll.refreshesEnded();
    await world.tick();
    let status = await world.status();
    expect(status.repos.map((repo) => repo.cache)).toEqual(["failed"]);
    expect(status.jobs).toEqual([]);

    // Sessions still start, from the last good cache.
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    await world.tick();
    const worktree = world.harness.started[0]!.session.worktree;
    expect(await readFile(join(worktree, "node_modules", "pkg", "index.js"), "utf8")).toBe("installed\n");

    // Not at every poll.
    await world.tick(new Date(failedAt.getTime() + HOUR - 60_000));
    expect((await world.status()).jobs).toEqual([]);

    await world.tick(new Date(failedAt.getTime() + HOUR));
    status = await world.status();
    expect(status.jobs).toEqual([{ kind: "cache_refresh", repo: world.repo, started_at: world.now.toISOString() }]);
    expect(status.repos.map((repo) => repo.cache)).toEqual(["refreshing"]);
    await world.poll.refreshesEnded();
  });

  test("after a failed refresh, a move of the default branch refreshes again at once", async () => {
    world = await World.create();
    await world.push({ ".flight-deck/record.toml": withInstall("exit 1") }, "Break", { refresh: false });
    await world.tick();
    await world.poll.refreshesEnded();
    await world.tick();
    expect((await world.status()).repos.map((repo) => repo.cache)).toEqual(["failed"]);

    await world.push({ ".flight-deck/record.toml": SHADERS_RECORD }, "Fix", { refresh: false });
    await world.tick();
    expect((await world.status()).jobs).toEqual([{ kind: "cache_refresh", repo: world.repo, started_at: world.now.toISOString() }]);
    await world.poll.refreshesEnded();
    await world.tick();
    expect((await world.status()).repos.map((repo) => repo.cache)).toEqual(["ok"]);
  });

  test("a repo with no record on its default branch gets no refresh", async () => {
    world = await World.create({ record: null });
    await world.tick();
    const status = await world.status();
    expect(status.jobs).toEqual([]);
    expect(status.repos.map((repo) => repo.cache)).toEqual(["missing"]);
  });
});
