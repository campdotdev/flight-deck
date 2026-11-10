// The usage holds (spec 1's "Holds" and "Exits", ADRs 0002 and 0007): the runner holds itself short of the
// plan limits on a subscription, keeps under the spending caps on an API key, and restarts a session that hit a
// plan limit without using the stage's retry.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RateLimitEvent } from "../../src/harness/index.ts";
import type { StoredIssue } from "../../src/tracker/index.ts";
import { outbox, World } from "./world.ts";

let world: World;

beforeEach(async () => {
  world = await World.create();
});

afterEach(async () => {
  await world.cleanup();
});

const HOUR = 3_600_000;

function later(ms: number): Date {
  return new Date(world.now.getTime() + ms);
}

/** The Tracker writes on the issue, as kinds and statuses. */
function moves(issue: StoredIssue): string[] {
  return world.tracker.writes.filter((write) => write.kind === "move" && write.issue === issue.identifier).map((write) => (write as { status: string }).status);
}

/** A `rate_limit_event` with each window's utilization and reset time. */
function usageEvent(fiveHour: [number, Date], weekly: [number, Date]): RateLimitEvent {
  return {
    status: "allowed",
    type: "five_hour",
    resetsAt: fiveHour[1].toISOString(),
    windows: {
      five_hour: { utilization: fiveHour[0], resetsAt: fiveHour[1].toISOString(), status: "allowed" },
      seven_day: { utilization: weekly[0], resetsAt: weekly[1].toISOString(), status: "allowed" },
    },
  };
}

/** Sends a new issue whose session reports these events and runs until it's finished. */
function sendReporting(title: string, ...events: RateLimitEvent[]): StoredIssue {
  const issue = world.issue({ title });
  world.send(issue);
  world.harness.script(issue.identifier, { rateLimits: events });
  return issue;
}

/** Sessions pay with an API key, under these caps. */
async function useApiKey(api: { session_budget_usd: number; daily_cap_usd: number; monthly_cap_usd: number }): Promise<void> {
  world.config.auth = "api_key";
  world.config.api = api;
  await world.writeConfig();
}

function comments(): unknown[] {
  return world.tracker.writes.filter((write) => write.kind === "comment");
}

describe("a session that exits rate_limited", () => {
  test("holds until resetsAt, requeues the issue with no comment, and restarts it without using the retry", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    const resetsAt = later(2 * HOUR + 60_000).toISOString();
    world.harness.script(issue.identifier, { exit: { kind: "rate_limited", resetsAt } });
    await world.tick();
    expect(world.harness.started).toHaveLength(1);

    await world.tick();
    expect(moves(issue)).toEqual(["Planning", "Ready to plan"]);
    expect(comments()).toEqual([]);
    const status = await world.status();
    expect(status.runner).toEqual({ state: "held", holds: [{ cause: "plan_limit", scope: "runner", name: null, since: world.now.toISOString(), until: resetsAt }] });
    expect(status.sessions).toEqual([]);

    // Held: the issue waits in Ready to plan until the reset.
    await world.tick(new Date(new Date(resetsAt).getTime() - 1000));
    expect(world.harness.started).toHaveLength(1);
    expect(world.tracker.stored(issue.id).status).toBe("Ready to plan");

    // At the reset the hold ends, and the next take starts at attempt 1.
    world.harness.script(issue.identifier, { exit: { kind: "timed_out" } });
    world.harness.script(issue.identifier, {});
    await world.tick(new Date(resetsAt));
    expect((await world.status()).runner).toEqual({ state: "working", holds: [] });
    expect(world.harness.started).toHaveLength(2);
    expect(world.harness.started[1]!.sessionJson.attempt).toBe(1);
    expect(moves(issue)).toEqual(["Planning", "Ready to plan", "Planning"]);

    // That session's failure still gets the stage's one retry.
    await world.tick();
    await world.tick();
    expect(world.harness.started).toHaveLength(3);
    expect(world.harness.started[2]!.sessionJson.attempt).toBe(2);
    expect(comments()).toEqual([]);
  });
});

describe("on an API key, a session that exits rate_limited", () => {
  test("holds under rate_limit, for 1 minute when the exit carries no resetsAt", async () => {
    await useApiKey({ session_budget_usd: 5, daily_cap_usd: 100, monthly_cap_usd: 1000 });
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    world.harness.script(issue.identifier, { exit: { kind: "rate_limited", resetsAt: null } });
    await world.tick();
    await world.tick();
    const until = later(60_000).toISOString();
    expect((await world.status()).runner).toEqual({ state: "held", holds: [{ cause: "rate_limit", scope: "runner", name: null, since: world.now.toISOString(), until }] });
    expect(world.tracker.stored(issue.id).status).toBe("Ready to plan");

    world.harness.script(issue.identifier, {});
    await world.tick(later(59_000));
    expect(world.harness.started).toHaveLength(1);
    await world.tick(new Date(until));
    expect(world.harness.started).toHaveLength(2);
    expect((await world.status()).runner).toEqual({ state: "working", holds: [] });
  });
});

describe("a plan limit after a first failure", () => {
  test("keeps attempt 2 at the next take, so a second failure then pauses", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    const resetsAt = later(HOUR).toISOString();
    world.harness.script(issue.identifier, { exit: { kind: "timed_out" } });
    world.harness.script(issue.identifier, { exit: { kind: "rate_limited", resetsAt } });
    await world.tick();
    await world.tick();
    expect(world.harness.started.map((each) => each.sessionJson.attempt)).toEqual([1, 2]);

    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Ready to plan");

    world.harness.script(issue.identifier, { exit: { kind: "timed_out" } });
    await world.tick(new Date(resetsAt));
    expect(world.harness.started.map((each) => each.sessionJson.attempt)).toEqual([1, 2, 2]);
    await world.tick();
    expect(world.harness.started).toHaveLength(3);
    expect(world.tracker.stored(issue.id).status).toBe("Paused");
    expect(comments()).toHaveLength(1);
  });

  test("starts over at attempt 1 when the maintainer moves the requeued issue out of its queue and sends it again", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    world.harness.script(issue.identifier, { exit: { kind: "timed_out" } });
    world.harness.script(issue.identifier, { exit: { kind: "rate_limited", resetsAt: null } });
    await world.tick();
    await world.tick();
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Ready to plan");

    // Held for the minute: the maintainer moves the issue back to Backlog, then sends it again.
    world.tracker.setStatus(issue.id, "Backlog");
    await world.tick(later(30_000));
    world.send(issue);
    world.harness.script(issue.identifier, {});
    await world.tick();
    expect(world.harness.started.map((each) => each.sessionJson.attempt)).toEqual([1, 2, 1]);
  });
});

describe("the plan-limit hold", () => {
  beforeEach(async () => {
    world.config.concurrency_cap = 5;
    await world.writeConfig();
  });

  test("starts at 80% of the five-hour window, and ends at its resetsAt", async () => {
    const fiveHourReset = later(3 * HOUR);
    const weekReset = later(100 * HOUR);
    sendReporting("First", usageEvent([0.79, fiveHourReset], [0.3, weekReset]));
    await world.tick();
    let status = await world.status();
    expect(status.runner).toEqual({ state: "working", holds: [] });
    expect(status.usage).toEqual({
      auth: "subscription",
      five_hour: { utilization: 0.79, resets_at: fiveHourReset.toISOString() },
      weekly: { utilization: 0.3, resets_at: weekReset.toISOString() },
    });

    sendReporting("Second", usageEvent([0.8, fiveHourReset], [0.3, weekReset]));
    await world.tick();
    expect(world.harness.started).toHaveLength(2);
    expect((await world.status()).runner).toEqual({
      state: "held",
      holds: [{ cause: "plan_limit", scope: "runner", name: null, since: world.now.toISOString(), until: fiveHourReset.toISOString() }],
    });

    sendReporting("Third");
    await world.tick();
    await world.tick(new Date(fiveHourReset.getTime() - 1000));
    expect(world.harness.started).toHaveLength(2);

    // Past its reset, the window counts as 0 until a newer event arrives.
    await world.tick(fiveHourReset);
    expect(world.harness.started).toHaveLength(3);
    status = await world.status();
    expect(status.runner).toEqual({ state: "working", holds: [] });
    expect(status.usage).toEqual({
      auth: "subscription",
      five_hour: { utilization: 0, resets_at: fiveHourReset.toISOString() },
      weekly: { utilization: 0.3, resets_at: weekReset.toISOString() },
    });
  });

  test("starts at 70% of the week, and ends at its resetsAt", async () => {
    const fiveHourReset = later(3 * HOUR);
    const weekReset = later(30 * HOUR);
    sendReporting("First", usageEvent([0.1, fiveHourReset], [0.69, weekReset]));
    await world.tick();
    expect((await world.status()).runner.holds).toEqual([]);

    sendReporting("Second", usageEvent([0.1, fiveHourReset], [0.7, weekReset]));
    await world.tick();
    expect((await world.status()).runner.holds).toEqual([
      { cause: "plan_limit", scope: "runner", name: null, since: world.now.toISOString(), until: weekReset.toISOString() },
    ]);

    sendReporting("Third");
    await world.tick(fiveHourReset);
    expect(world.harness.started).toHaveLength(2);
    await world.tick(weekReset);
    expect(world.harness.started).toHaveLength(3);
    expect((await world.status()).runner.holds).toEqual([]);
  });

  test("shows no usage before the first rate_limit_event", async () => {
    await world.tick();
    expect((await world.status()).usage).toEqual({ auth: "subscription", five_hour: null, weekly: null });
  });
});

describe("after a restart", () => {
  test("a new Poll over the same data folder keeps the plan-limit hold and the latest event", async () => {
    world.config.concurrency_cap = 5;
    await world.writeConfig();
    const fiveHourReset = later(3 * HOUR);
    const weekReset = later(100 * HOUR);
    const first = sendReporting("First", usageEvent([0.85, fiveHourReset], [0.3, weekReset]));
    await world.tick();
    const held = (await world.status()).runner;
    expect(held.state).toBe("held");

    world.restart();
    const second = sendReporting("Second");
    await world.tick();
    expect(world.harness.started).toHaveLength(1);
    const status = await world.status();
    expect(status.runner).toEqual(held);
    expect(status.usage).toEqual({
      auth: "subscription",
      five_hour: { utilization: 0.85, resets_at: fiveHourReset.toISOString() },
      weekly: { utilization: 0.3, resets_at: weekReset.toISOString() },
    });

    await world.tick(fiveHourReset);
    // The restart killed the first session, which the old runner started, so its retry starts first (FLD-108).
    expect(world.harness.started.map(({ session, sessionJson }) => [session.issue, sessionJson.attempt])).toEqual([
      [first.identifier, 1],
      [first.identifier, 2],
      [second.identifier, 1],
    ]);
    expect(world.harness.kills).toEqual([world.harness.started[0]!.handle]);
  });

  test("a new Poll keeps a rate_limited exit's hold until its resetsAt", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    const resetsAt = later(HOUR).toISOString();
    world.harness.script(issue.identifier, { exit: { kind: "rate_limited", resetsAt } });
    await world.tick();
    await world.tick();

    world.restart();
    world.harness.script(issue.identifier, {});
    await world.tick();
    expect(world.harness.started).toHaveLength(1);
    expect((await world.status()).runner.holds.map(({ cause, until }) => ({ cause, until }))).toEqual([{ cause: "plan_limit", until: resetsAt }]);
    await world.tick(new Date(resetsAt));
    expect(world.harness.started).toHaveLength(2);
  });
});

/** The start of the next local day, or the next local month, after the world's clock: the Mac's time zone. */
function nextLocal(unit: "day" | "month"): Date {
  const now = world.now;
  return unit === "day" ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) : new Date(now.getFullYear(), now.getMonth() + 1, 1);
}

/** Sends a new issue whose session hands off a brief once it's finished. */
function sendBriefed(title: string): StoredIssue {
  const issue = world.issue({ title });
  world.send(issue);
  world.harness.script(issue.identifier, { outbox: outbox.brief({ summary: "Brief ready", brief: "## Brief\n" }) });
  return issue;
}

describe("on an API key", () => {
  test("a start goes ahead only when each cap covers the budget of every running session plus this one", async () => {
    await useApiKey({ session_budget_usd: 5, daily_cap_usd: 12, monthly_cap_usd: 1000 });
    world.config.concurrency_cap = 5;
    await world.writeConfig();
    sendBriefed("First");
    sendBriefed("Second");
    sendBriefed("Third");
    await world.tick();
    // Two budgets fit under 12, and a third would pass it.
    expect(world.harness.started).toHaveLength(2);
    let status = await world.status();
    const since = world.now.toISOString();
    expect(status.runner).toEqual({ state: "held", holds: [{ cause: "api_cap", scope: "runner", name: null, since, until: nextLocal("day").toISOString() }] });
    expect(status.usage).toEqual({ auth: "api_key", day_usd: 0, month_usd: 0, daily_cap_usd: 12, monthly_cap_usd: 1000 });

    // One session's result event cost 1.5. The other ended with no result event, so it counts its whole budget.
    const [first, second] = world.harness.started;
    world.harness.finish(first!.session.id, { kind: "exited", code: 0 }, { costUsd: 1.5 });
    world.harness.finish(second!.session.id, { kind: "exited", code: 0 });
    sendBriefed("Fourth");
    await world.tick();
    // 5.5 is left: one budget fits, and a second doesn't.
    expect(world.harness.started).toHaveLength(3);
    status = await world.status();
    expect(status.usage).toEqual({ auth: "api_key", day_usd: 6.5, month_usd: 6.5, daily_cap_usd: 12, monthly_cap_usd: 1000 });
    expect(status.runner.holds).toEqual([{ cause: "api_cap", scope: "runner", name: null, since: world.now.toISOString(), until: nextLocal("day").toISOString() }]);
  });

  test("the daily cap's hold ends at the next local day, and the month's spending carries on", async () => {
    await useApiKey({ session_budget_usd: 5, daily_cap_usd: 12, monthly_cap_usd: 1000 });
    sendBriefed("First");
    sendBriefed("Second");
    await world.tick();
    for (const each of world.harness.started) world.harness.finish(each.session.id, { kind: "exited", code: 0 }, { costUsd: 4 });
    sendBriefed("Third");
    await world.tick();
    // 4 is left, under one budget.
    expect(world.harness.started).toHaveLength(2);
    const midnight = nextLocal("day");
    expect((await world.status()).runner.holds.map(({ cause, until }) => ({ cause, until }))).toEqual([{ cause: "api_cap", until: midnight.toISOString() }]);

    await world.tick(new Date(midnight.getTime() - 1000));
    expect(world.harness.started).toHaveLength(2);
    await world.tick(midnight);
    expect(world.harness.started).toHaveLength(3);
    const status = await world.status();
    expect(status.runner.holds).toEqual([]);
    expect(status.usage).toEqual({ auth: "api_key", day_usd: 0, month_usd: 8, daily_cap_usd: 12, monthly_cap_usd: 1000 });
  });

  test("the monthly cap's hold ends at the next local month", async () => {
    await useApiKey({ session_budget_usd: 5, daily_cap_usd: 100, monthly_cap_usd: 8 });
    sendBriefed("First");
    sendBriefed("Second");
    await world.tick();
    expect(world.harness.started).toHaveLength(1);
    expect((await world.status()).runner.holds.map(({ cause, until }) => ({ cause, until }))).toEqual([
      { cause: "api_cap", until: nextLocal("month").toISOString() },
    ]);
  });

  test("a raised cap ends the hold at the next poll", async () => {
    await useApiKey({ session_budget_usd: 5, daily_cap_usd: 8, monthly_cap_usd: 1000 });
    sendBriefed("First");
    sendBriefed("Second");
    await world.tick();
    expect(world.harness.started).toHaveLength(1);
    world.config.api = { session_budget_usd: 5, daily_cap_usd: 10, monthly_cap_usd: 1000 };
    await world.writeConfig();
    await world.tick();
    expect(world.harness.started).toHaveLength(2);
    expect((await world.status()).runner.holds).toEqual([]);
  });

  test("a session the runner lost at a restart ended with no result event, so it counts its whole budget", async () => {
    await useApiKey({ session_budget_usd: 5, daily_cap_usd: 100, monthly_cap_usd: 1000 });
    const issue = world.issue({ title: "First" });
    world.send(issue);
    world.harness.script(issue.identifier, {});
    await world.tick();
    world.harness.lose(world.harness.started[0]!.session.id);
    world.restart();
    await world.tick();
    expect((await world.status()).usage).toEqual({ auth: "api_key", day_usd: 5, month_usd: 5, daily_cap_usd: 100, monthly_cap_usd: 1000 });
  });

  test("spending survives a restart", async () => {
    await useApiKey({ session_budget_usd: 5, daily_cap_usd: 8, monthly_cap_usd: 1000 });
    sendBriefed("First");
    await world.tick();
    world.harness.finish(world.harness.started[0]!.session.id, { kind: "exited", code: 0 }, { costUsd: 4 });
    await world.tick();
    world.restart();
    sendBriefed("Second");
    await world.tick();
    expect(world.harness.started).toHaveLength(1);
    const status = await world.status();
    expect(status.usage).toEqual({ auth: "api_key", day_usd: 4, month_usd: 4, daily_cap_usd: 8, monthly_cap_usd: 1000 });
    expect(status.runner.holds.map(({ cause }) => cause)).toEqual(["api_cap"]);
  });
});
