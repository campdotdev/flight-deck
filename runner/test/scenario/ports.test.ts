// Each session of a repo with an app gets a free port of its own, and a single-instance app runs one session at a
// time on its default port, which the runner tests before each take (spec 1's "Workspace" and "Starts", ADR 0003).
// The ports here are real: each test picks ports nothing on the Mac holds, so parallel suites don't collide.
import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import type { StoredIssue } from "../../src/tracker/index.ts";
import { outbox, SHADERS_APP_RECORD, World } from "./world.ts";

/** Shaders' record with a single-instance app on `port`. */
function singleInstance(port: number): string {
  return SHADERS_APP_RECORD.replace("default_port = 3000", `default_port = ${port}`).replace("single_instance = false", "single_instance = true");
}

let world: World | undefined;
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  await world?.cleanup();
  world = undefined;
});

/** Listens on `host` and `port`, as another process such as the maintainer's dev server would. `null` when it can't. */
function listen(host: string, port: number): Promise<Server | null> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(null));
    server.listen({ host, port, ipv6Only: host.includes(":") }, () => {
      servers.push(server);
      resolve(server);
    });
  });
}

/** A port nothing listens on, from the system's ephemeral range, so no other suite's session range picks it. */
async function freePort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve) => server.listen({ host: "0.0.0.0", port: 0 }, () => resolve((server.address() as { port: number }).port)));
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function close(server: Server | null): Promise<void> {
  if (server === null) return;
  servers.splice(servers.indexOf(server), 1);
  await new Promise((resolve) => server.close(resolve));
}

function sent(input: { title: string; priority?: number }): StoredIssue {
  world!.now = new Date(world!.now.getTime() + 60_000);
  const issue = world!.issue(input);
  world!.send(issue);
  return issue;
}

describe("session ports", () => {
  test("two sessions of a repo with an app get different free ports in 4400 to 4999, with app_url on that port", async () => {
    world = await World.create({ record: SHADERS_APP_RECORD });
    // The lowest port in the range that's free now, held as another process would hold it.
    let held: Server | null = null;
    let heldPort = 4400;
    for (; heldPort <= 4999 && held === null; heldPort++) held = await listen("127.0.0.1", heldPort);
    heldPort--;
    expect(held).not.toBeNull();
    sent({ title: "Save button is blue" });
    sent({ title: "Slider jumps" });
    await world.tick();

    const [first, second] = world.harness.started.map((each) => each.sessionJson);
    expect(world.harness.started).toHaveLength(2);
    for (const json of [first!, second!]) {
      expect(json.port).toBeGreaterThan(heldPort);
      expect(json.port).toBeLessThanOrEqual(4999);
      expect(json.app_url).toBe(`http://localhost:${json.port}/`);
    }
    // The first session doesn't listen yet, so only the session list keeps the second off its port.
    expect(second!.port).not.toBe(first!.port);
  });

  test("a session skips a port in the range that another process listens on at 0.0.0.0", async () => {
    world = await World.create({ record: SHADERS_APP_RECORD });
    // On macOS a test bind on 127.0.0.1 succeeds beside a listener on 0.0.0.0, as a dev server's often is.
    let held: Server | null = null;
    let heldPort = 4400;
    for (; heldPort <= 4999 && held === null; heldPort++) held = await listen("0.0.0.0", heldPort);
    heldPort--;
    expect(held).not.toBeNull();
    sent({ title: "Save button is blue" });
    await world.tick();

    expect(world.harness.started[0]!.sessionJson.port).toBeGreaterThan(heldPort);
  });

  test("a repo with no app gets a null port and app_url", async () => {
    world = await World.create();
    sent({ title: "Save button is blue" });
    await world.tick();
    expect(world.harness.started[0]!.sessionJson.port).toBeNull();
    expect(world.harness.started[0]!.sessionJson.app_url).toBeNull();
  });
});

/** The port pause's comment, with nothing in its fold but the runner footer. */
function portComment(port: number): string {
  return [
    `🟡 Needs your help: port ${port} is in use`,
    "",
    `This repo's app runs only on port ${port}, so plan can't start while something else on the Mac uses it. Stop whatever uses port ${port}, such as your own dev server, then reply.`,
    "",
    "Reply with one word:",
    "",
    "- **retry**: Flight Deck tests the port again. Moves the issue to Ready to plan.",
    "",
    "Any other reply leaves the issue paused until you move it.",
    "",
    "+++ Details",
    "",
    `Flight Deck ${world!.version} · runner`,
    "",
    "+++",
  ].join("\n");
}

describe("a single-instance app", () => {
  test("with its port in use, pauses the first issue in the order from Ready to plan, and the others wait under waiting_for_port", async () => {
    const port = await freePort();
    world = await World.create({ record: singleInstance(port) });
    const devServer = await listen("127.0.0.1", port);
    const low = sent({ title: "Slider jumps", priority: 4 });
    const urgent = sent({ title: "Save button is blue", priority: 1 });
    const medium = sent({ title: "Docs typo", priority: 3 });
    await world.tick();

    expect(world.harness.started).toEqual([]);
    expect(world.tracker.stored(urgent.id).status).toBe("Paused");
    expect(world.tracker.stored(urgent.id).assignee).toBe(world.maintainer.id);
    expect(world.tracker.writes.filter((write) => write.kind === "comment")).toEqual([{ kind: "comment", issue: urgent.identifier, body: portComment(port) }]);
    expect(world.tracker.stored(medium.id).status).toBe("Ready to plan");
    expect(world.tracker.stored(low.id).status).toBe("Ready to plan");
    let status = await world.status();
    expect(status.repos[0]!.waiting_for_port).toEqual({ port, issues: [medium.identifier, low.identifier] });
    expect(status.flags.map(({ issue, status_line }) => ({ issue, status_line }))).toEqual([
      { issue: urgent.identifier, status_line: `🟡 Needs your help: port ${port} is in use` },
    ]);

    // While the pause stands and the port stays in use, the others wait, and nothing else pauses.
    await world.tick();
    expect(world.harness.started).toEqual([]);
    expect(world.tracker.writes.filter((write) => write.kind === "comment")).toHaveLength(1);
    expect((await world.status()).repos[0]!.waiting_for_port).toEqual({ port, issues: [medium.identifier, low.identifier] });

    // Once the port is free, the next poll takes the waiting issues one at a time, on the app's own port.
    await close(devServer);
    world.harness.script(medium.identifier, { outbox: outbox.brief({ summary: "Brief ready", brief: "## Summary\n\nDocs." }), exit: { kind: "exited", code: 0 } });
    await world.tick();
    expect(world.harness.started.map((each) => each.session.issue)).toEqual([medium.identifier]);
    expect(world.harness.started[0]!.sessionJson.port).toBe(port);
    expect(world.tracker.stored(low.id).status).toBe("Ready to plan");
    status = await world.status();
    expect(status.repos[0]!.waiting_for_port).toBeNull();

    await world.tick();
    expect(world.tracker.stored(medium.id).status).toBe("Ready to build");
    expect(world.harness.started.map((each) => each.session.issue)).toEqual([medium.identifier, low.identifier]);
  });
});

describe("two single-instance apps on one port", () => {
  test("the second repo's take waits while the first repo's session holds the port, with no pause", async () => {
    const port = await freePort();
    world = await World.create({ record: singleInstance(port) });
    await world.addRepo({ name: "campdotdev/docs", team: "DOC", record: singleInstance(port) });
    const shaders = sent({ title: "Save button is blue", priority: 1 });
    world.now = new Date(world.now.getTime() + 60_000);
    const docs = world.issue({ team: "DOC", title: "Docs typo", priority: 2 });
    world.send(docs);
    await world.tick();

    // The first session doesn't listen on the port yet, so only the session list keeps the second repo off it.
    expect(world.harness.started.map((each) => each.session.issue)).toEqual([shaders.identifier]);
    expect(world.harness.started[0]!.sessionJson.port).toBe(port);
    expect(world.tracker.stored(docs.id).status).toBe("Ready to plan");
    expect(world.tracker.writes.filter((write) => write.kind === "comment")).toEqual([]);
    const status = await world.status();
    expect(status.repos.find((repo) => repo.name === "campdotdev/docs")!.waiting_for_port).toEqual({ port, issues: [docs.identifier] });
  });
});

describe("the port test", () => {
  test.each(["0.0.0.0", "::", "::1"])("counts a listener on %s as in use", async (host) => {
    const port = await freePort();
    world = await World.create({ record: singleInstance(port) });
    expect(await listen(host, port)).not.toBeNull();
    const issue = sent({ title: "Save button is blue" });
    await world.tick();
    expect(world.harness.started).toEqual([]);
    expect(world.tracker.stored(issue.id).status).toBe("Paused");
  });

  test("runs again after the pause's retry, and pauses the first issue in the order while the port stays in use", async () => {
    const port = await freePort();
    world = await World.create({ record: singleInstance(port) });
    const devServer = await listen("127.0.0.1", port);
    const first = sent({ title: "Save button is blue", priority: 2 });
    const second = sent({ title: "Slider jumps", priority: 3 });
    await world.tick();
    expect(world.tracker.stored(first.id).status).toBe("Paused");

    world.reply(first, "retry");
    await world.tick();
    expect(world.tracker.stored(first.id).status).toBe("Ready to plan");
    // The port is still in use, so the next take pauses the first issue in the order again.
    await world.tick();
    expect(world.tracker.stored(first.id).status).toBe("Paused");
    expect(world.tracker.stored(second.id).status).toBe("Ready to plan");
    expect(world.tracker.writes.filter((write) => write.kind === "comment").map((write) => write.issue)).toEqual([first.identifier, first.identifier]);
    expect((await world.status()).repos[0]!.waiting_for_port).toEqual({ port, issues: [second.identifier] });

    // A free port ends the wait at the same poll as the answer, so the waiting issue goes first, and the answered
    // one waits behind its session.
    await close(devServer);
    world.reply(first, "retry");
    await world.tick();
    expect(world.harness.started.map((each) => each.session.issue)).toEqual([second.identifier]);
    expect((await world.status()).repos[0]!.waiting_for_port).toBeNull();
    await world.tick();
    expect(world.tracker.stored(first.id).status).toBe("Ready to plan");
    expect(world.harness.started).toHaveLength(1);
  });

  test("waits while the runner is held, which takes nothing", async () => {
    const port = await freePort();
    world = await World.create({ record: singleInstance(port) });
    expect(await listen("127.0.0.1", port)).not.toBeNull();
    const issue = sent({ title: "Save button is blue" });
    await world.hold();
    await world.tick();
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Ready to plan");
    expect(world.tracker.writes.filter((write) => write.kind === "comment")).toEqual([]);

    await world.start();
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Paused");
  });
});
