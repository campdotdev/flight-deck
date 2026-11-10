// Linear tokens (spec 1, "Tokens" and "Session credentials", ADR 0005). The runner holds one Flight Deck app token
// per workspace and mints one read-only Reader token per session. A failed mint holds new work in that workspace,
// retries with backoff, and files one trouble issue once a mint works, when the failure lasted 15 minutes or more.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { ExitKind } from "../../src/harness/index.ts";
import { outbox, World } from "./world.ts";

// Many ticks, each with a real git fetch.
setDefaultTimeout(60_000);

let world: World;

beforeEach(async () => {
  world = await World.create();
});

afterEach(async () => {
  await world.cleanup();
});

const NOTIFICATION = "Flight Deck can't get a Linear token for campdotdev. It keeps trying.";
const BRIEF = outbox.brief({ summary: "Brief ready", brief: "## Summary\n\nThe button." });

/** The writes from the next tick. */
async function nextTick(at?: Date): Promise<unknown[]> {
  const before = world.tracker.writes.length;
  await world.tick(at);
  return world.tracker.writes.slice(before);
}

function mintsOf(app: "flight_deck" | "reader") {
  return world.tracker.mints.filter((mint) => mint.app === app);
}

describe("the runner's token", () => {
  test("is minted at the first poll, once per workspace, and held after", async () => {
    await world.tick();
    await world.tick();
    expect(mintsOf("flight_deck")).toEqual([{ app: "flight_deck", workspace: "campdotdev", session: null, ok: true }]);
  });

  test("is revoked for each workspace, and the next poll mints a new one", async () => {
    await world.addRepo({ name: "acme/site", team: "WEB", workspace: "acme" });
    await world.tick();
    await world.poll.revokeRunnerTokens();
    expect(world.tracker.runnerTokens.map(({ workspace, revoked }) => ({ workspace, revoked }))).toEqual([
      { workspace: "campdotdev", revoked: true },
      { workspace: "acme", revoked: true },
    ]);
    await world.tick();
    expect(world.tracker.runnerTokens.filter((token) => !token.revoked).map((token) => token.workspace)).toEqual(["campdotdev", "acme"]);
  });
});

describe("a failed Flight Deck app mint", () => {
  test("holds the workspace, retries after 1, 2, 4, and 8 minutes, then every 15, and files one issue once a mint works", async () => {
    world.tracker.failMints("flight_deck", "campdotdev");
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    world.harness.script(issue.identifier, { outbox: BRIEF });

    const tried: number[] = [];
    for (let minute = 0; minute < 30; minute++) {
      const before = world.tracker.mints.length;
      // Every Linear step of the poll is skipped: no unsubscribe, no take, no trouble issue.
      expect(await nextTick()).toEqual([]);
      if (world.tracker.mints.length > before) tried.push(minute);
    }
    expect(tried).toEqual([0, 1, 3, 7, 15]);
    expect(world.harness.started).toEqual([]);
    expect(await world.notifications()).toEqual([NOTIFICATION]);
    const status = await world.status();
    expect(status.runner).toEqual({ state: "working", holds: [{ cause: "linear_token", scope: "workspace", name: "campdotdev", since: "2026-11-10T09:01:00.000Z", until: null }] });
    expect(status.trouble).toEqual([{ cause: "linear_token", repos: ["campdotdev/shaders"], issue_url: null, since: "2026-11-10T09:01:00.000Z" }]);

    // The retry at 30 minutes works: the poll runs, takes the sent issue, and files the trouble issue at step 10.
    world.tracker.failMints("flight_deck", "campdotdev", false);
    const writes = await nextTick();
    const title = "Flight Deck couldn't get a Linear token for 30 minutes";
    expect(writes).toEqual([
      { kind: "unsubscribe", issue: issue.identifier, user: world.maintainer.id },
      { kind: "move", issue: issue.identifier, status: "Planning" },
      {
        kind: "file",
        issue: "SHA-2",
        title,
        status: "Triage",
        description: [
          "Flight Deck held new work in campdotdev from 2026-11-10 09:01 UTC to 09:31 UTC, because Linear refused to mint a token from the Flight Deck app. Flight Deck skipped every Linear step for the workspace's repos while it waited. A mint works again, so the factory runs as usual.",
          "",
          "From the Mac, four causes look the same. If it happens again, check each one:",
          "",
          "1. A full token pool. Linear holds at most 1,000 active tokens per app. A runner that crashes leaves its sessions' Reader tokens live until they expire after 30 days, so check `runner.log` for restarts.",
          "2. A rotated client secret. If someone rotated the app's secret in Linear, run `flight-deck login linear campdotdev` and enter the new one.",
          "3. A deleted app. If the app is gone from the workspace's settings in Linear, create it again, then run `flight-deck login linear campdotdev`.",
          "4. A Linear outage. Check Linear's status page. Flight Deck keeps trying on its own.",
          "",
          "Close the issue once you've read it.",
          "",
          "+++ Details",
          "",
          "- Cause: `linear_token`",
          "- Workspace: `campdotdev`",
          "- App: Flight Deck",
          "",
          "The last mint failed with:",
          "",
          "```text",
          "Linear refused to mint a Flight Deck token for campdotdev",
          "```",
          "",
          "Flight Deck 0.1.0 · runner",
          "",
          "+++",
        ].join("\n"),
      },
      { kind: "assign", issue: "SHA-2", user: world.maintainer.id },
    ]);
    expect(world.harness.started.map((each) => each.session.issue)).toEqual([issue.identifier]);
    expect((await world.status()).runner.holds).toEqual([]);
    // The notification above is the only one: the filed issue posts none, and no cleared comment follows.
    expect(await world.notifications()).toEqual([NOTIFICATION]);
    expect(await nextTick()).toEqual([]);
  });

  test("shorter than 15 minutes files nothing", async () => {
    world.tracker.failMints("flight_deck", "campdotdev");
    await world.tick();
    await world.tick();
    world.tracker.failMints("flight_deck", "campdotdev", false);
    await world.tick();
    await world.tick();
    expect(world.tracker.writes).toEqual([]);
    expect(await world.notifications()).toEqual([NOTIFICATION]);
    expect((await world.status()).runner.holds).toEqual([]);
    expect((await world.status()).trouble).toEqual([]);
  });

  test("a session that exits during the hold waits, and its outbox applies once a mint works", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    world.harness.script(issue.identifier, { outbox: BRIEF });
    await world.tick();
    const session = world.harness.started[0]!.session.id;

    // Linear rejects the runner's token, as with a 401, and the mint of a new one fails.
    world.tracker.rejectToken(world.tracker.runnerTokens[0]!.token);
    world.tracker.failMints("flight_deck", "campdotdev");
    world.harness.finish(session, { kind: "exited", code: 0 });
    expect(await nextTick()).toEqual([]);
    expect(world.tracker.stored(issue.id).status).toBe("Planning");
    // The Reader token goes at the exit all the same.
    expect(world.tracker.tokens.map(({ session, revoked }) => ({ session, revoked }))).toEqual([{ session, revoked: true }]);

    world.tracker.failMints("flight_deck", "campdotdev", false);
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Ready to build");
  });

  test("leaves another workspace's factory running", async () => {
    await world.addRepo({ name: "acme/site", team: "WEB", workspace: "acme" });
    world.tracker.failMints("flight_deck", "campdotdev");
    const held = world.issue({ title: "Save button is blue" });
    const other = world.issue({ title: "Footer overlaps", team: "WEB" });
    world.send(held);
    world.send(other);
    expect(await nextTick()).toEqual([
      { kind: "unsubscribe", issue: other.identifier, user: world.maintainer.id },
      { kind: "move", issue: other.identifier, status: "Planning" },
    ]);
    expect(world.harness.started.map((each) => each.session.issue)).toEqual([other.identifier]);
    expect((await world.status()).runner.holds.map(({ cause, scope, name }) => ({ cause, scope, name }))).toEqual([
      { cause: "linear_token", scope: "workspace", name: "campdotdev" },
    ]);
  });
});

describe("a failed Reader mint", () => {
  test("after the take puts the issue back in Ready to plan with no comment, and only starts wait", async () => {
    world.tracker.failMints("reader", "campdotdev");
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    world.harness.script(issue.identifier, { outbox: BRIEF });

    expect(await nextTick()).toEqual([
      { kind: "unsubscribe", issue: issue.identifier, user: world.maintainer.id },
      { kind: "move", issue: issue.identifier, status: "Planning" },
      { kind: "move", issue: issue.identifier, status: "Ready to plan" },
    ]);
    expect(world.harness.started).toEqual([]);
    expect(world.tracker.tokens).toEqual([]);
    expect((await world.status()).sessions).toEqual([]);
    expect((await world.status()).runner.holds.map(({ cause, scope, name }) => ({ cause, scope, name }))).toEqual([
      { cause: "linear_token", scope: "workspace", name: "campdotdev" },
    ]);
    expect(await world.notifications()).toEqual([NOTIFICATION]);

    // The poll still runs, on the Flight Deck app's token. The retry at 1 minute mints a Reader token for no
    // session, and fails again.
    const second = world.issue({ title: "Footer overlaps" });
    world.send(second);
    expect(await nextTick()).toEqual([{ kind: "unsubscribe", issue: second.identifier, user: world.maintainer.id }]);
    expect(mintsOf("reader")).toEqual([
      { app: "reader", workspace: "campdotdev", session: world.tracker.mints.find((mint) => mint.app === "reader")!.session, ok: false },
      { app: "reader", workspace: "campdotdev", session: null, ok: false },
    ]);

    // The next retry, 2 minutes later, works, and the same poll takes the issue as attempt 1.
    world.tracker.failMints("reader", "campdotdev", false);
    expect(await nextTick()).toEqual([]);
    expect(mintsOf("reader")).toHaveLength(2);
    await world.tick();
    expect(world.harness.started.map((each) => [each.session.issue, each.sessionJson.attempt])).toEqual([
      [issue.identifier, 1],
      [second.identifier, 1],
    ]);
    expect(world.tracker.tokens.map((token) => token.revoked)).toEqual([false, false]);
    expect((await world.status()).runner.holds).toEqual([]);
    // A failure under 15 minutes files nothing.
    expect(world.tracker.writes.filter((write) => write.kind === "file")).toEqual([]);
  });
});

describe("each session's Reader token", () => {
  const ENDINGS: [string, ExitKind][] = [
    ["exits", { kind: "exited", code: 0 }],
    ["is stopped", { kind: "stopped" }],
    ["is killed at its time limit", { kind: "timed_out" }],
  ];
  for (const [when, exit] of ENDINGS) {
    test(`is revoked when the session ${when}`, async () => {
      const issue = world.issue({ title: "Save button is blue" });
      world.send(issue);
      world.harness.script(issue.identifier, {});
      await world.tick();
      const session = world.harness.started[0]!.session.id;
      expect(world.tracker.tokens.map(({ session, revoked }) => ({ session, revoked }))).toEqual([{ session, revoked: false }]);
      world.harness.finish(session, exit);
      await world.tick();
      // A failed session's retry starts in the same poll, with a token of its own.
      expect(world.tracker.tokens.filter((token) => token.session === session).map((token) => token.revoked)).toEqual([true]);
    });
  }
});
