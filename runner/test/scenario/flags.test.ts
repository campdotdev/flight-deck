// The runner owns an in-flight issue's assignee and subscribers: a flag assigns the maintainer, and every
// other assignee and subscription goes (ADR 0011, spec 1's poll steps 6 and 7).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { StoredIssue } from "../../src/tracker/index.ts";
import { outbox, World } from "./world.ts";

const SUMMARY = "Which red should the Save button use?\n\nThe report asks for red, and the design system has two.";
const ANSWERS = [{ word: "brand", does: "plan uses the brand red", move: "ready_to_plan" as const }];

let world: World;

beforeEach(async () => {
  world = await World.create();
});

afterEach(async () => {
  await world.cleanup();
});

async function paused(issue: StoredIssue): Promise<void> {
  world.send(issue);
  world.harness.script(issue.identifier, {
    outbox: outbox.pause({ summary: SUMMARY, pause: "## Question\n\nWhich red?", answers: ANSWERS, needs: "answer" }),
    exit: { kind: "exited", code: 0 },
  });
  await world.tick();
  await world.tick();
  expect(world.tracker.stored(issue.id).status).toBe("Paused");
}

/** The writes from the next tick. */
async function nextTick(): Promise<unknown[]> {
  const before = world.tracker.writes.length;
  await world.tick();
  return world.tracker.writes.slice(before);
}

describe("flags", () => {
  test("status.json lists each flagged issue with its status line", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await paused(issue);
    const since = world.now.toISOString();
    await world.tick();
    expect((await world.status()).flags).toEqual([
      {
        repo: "campdotdev/shaders",
        issue: issue.identifier,
        title: "Save button is blue",
        url: `https://linear.app/campdotdev/issue/${issue.identifier}`,
        status_line: "🟡 Needs your answer: Which red should the Save button use?",
        since,
      },
    ]);
  });

  test("an answer clears the issue from status.json's flags", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await paused(issue);
    world.reply(issue, "brand");
    await world.tick();
    expect((await world.status()).flags).toEqual([]);
  });

  test("the maintainer moves a paused issue back to Ready to plan, and the flag clears", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await paused(issue);
    world.send(issue);
    expect(await nextTick()).toEqual([
      { kind: "unassign", issue: issue.identifier },
      { kind: "unsubscribe", issue: issue.identifier, user: world.maintainer.id },
      { kind: "move", issue: issue.identifier, status: "Planning" },
    ]);
    expect((await world.status()).flags).toEqual([]);
  });

  test("clearing a flagged issue's assignee by hand clears the flag, the runner doesn't assign again, and the pause still takes an answer", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await paused(issue);
    world.tracker.setAssignee(issue.id, null);
    // Linear keeps the maintainer subscribed, and the issue is now unflagged.
    expect(await nextTick()).toEqual([{ kind: "unsubscribe", issue: issue.identifier, user: world.maintainer.id }]);
    expect(await nextTick()).toEqual([]);
    expect((await world.status()).flags).toEqual([]);

    world.reply(issue, "brand");
    expect(await nextTick()).toEqual([
      { kind: "move", issue: issue.identifier, status: "Ready to plan" },
      { kind: "unsubscribe", issue: issue.identifier, user: world.maintainer.id },
    ]);
  });

  test("assigning a flagged issue to someone else clears the flag and that assignee, and the pause still takes an answer", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await paused(issue);
    world.tracker.setAssignee(issue.id, "someone");
    expect(await nextTick()).toEqual([
      { kind: "unassign", issue: issue.identifier },
      { kind: "unsubscribe", issue: issue.identifier, user: world.maintainer.id },
    ]);
    expect(await nextTick()).toEqual([]);
    expect((await world.status()).flags).toEqual([]);

    world.reply(issue, "brand");
    expect(await nextTick()).toEqual([
      { kind: "move", issue: issue.identifier, status: "Ready to plan" },
      { kind: "unsubscribe", issue: issue.identifier, user: world.maintainer.id },
    ]);
  });

  test("an issue that leaves flight loses its flag and open pause, and keeps its assignee", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await paused(issue);
    world.tracker.setStatus(issue.id, "Backlog");
    expect(await nextTick()).toEqual([]);
    expect((await world.status()).flags).toEqual([]);
    expect(world.tracker.stored(issue.id).assignee).toBe(world.maintainer.id);

    // The pause and the flag are gone, so back in Paused the issue is unflagged, and a reply answers nothing.
    world.tracker.setStatus(issue.id, "Paused");
    world.reply(issue, "brand");
    expect(await nextTick()).toEqual([
      { kind: "unassign", issue: issue.identifier },
      { kind: "unsubscribe", issue: issue.identifier, user: world.maintainer.id },
    ]);
    expect(world.tracker.stored(issue.id).status).toBe("Paused");
  });

  test("an issue canceled while paused leaves flight too", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await paused(issue);
    world.tracker.setStatus(issue.id, "Canceled");
    expect(await nextTick()).toEqual([]);
    expect((await world.status()).flags).toEqual([]);
  });
});

describe("assignees the runner didn't set", () => {
  test("an assignee the maintainer set before the send is cleared at the take", async () => {
    const issue = world.issue({ title: "Save button is blue", assignee: world.maintainer.id });
    world.send(issue);
    world.harness.script(issue.identifier, {});
    expect(await nextTick()).toEqual([
      { kind: "unassign", issue: issue.identifier },
      { kind: "unsubscribe", issue: issue.identifier, user: world.maintainer.id },
      { kind: "move", issue: issue.identifier, status: "Planning" },
    ]);
  });

  test.each([
    ["Planning", "Planning"],
    ["an unflagged Paused issue", "Paused"],
    ["Ready to build", "Ready to build"],
  ])("an assignee set on an issue in %s is cleared at the next poll", async (_, status) => {
    const issue = world.issue({ title: "Save button is blue", status });
    await world.tick();
    world.tracker.setAssignee(issue.id, "someone");
    expect(await nextTick()).toEqual([{ kind: "unassign", issue: issue.identifier }]);
  });

  test("an unsent issue keeps its assignee", async () => {
    world.issue({ title: "Mine", status: "Backlog", assignee: world.maintainer.id });
    world.issue({ title: "Also mine", status: "Triage", assignee: world.maintainer.id });
    await world.tick();
    expect(world.tracker.writes).toEqual([]);
  });

  test("an issue waiting for spec support keeps its assignee and subscription", async () => {
    const issue = world.issue({ title: "Part of a spec", parent: "parent-issue", assignee: world.maintainer.id });
    world.send(issue);
    await world.tick();
    expect(world.tracker.writes).toEqual([]);
  });
});

describe("subscriptions", () => {
  test("the maintainer is unsubscribed from each unflagged issue in a factory status", async () => {
    const issue = world.issue({ title: "Save button is blue", status: "Ready to build" });
    expect(await nextTick()).toEqual([{ kind: "unsubscribe", issue: issue.identifier, user: world.maintainer.id }]);
    world.reply(issue, "Looks good.");
    expect(await nextTick()).toEqual([{ kind: "unsubscribe", issue: issue.identifier, user: world.maintainer.id }]);
    expect(await nextTick()).toEqual([]);
  });

  test("a flagged issue keeps the maintainer subscribed", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await paused(issue);
    world.reply(issue, "Why two reds?");
    expect(await nextTick()).toEqual([]);
    expect(world.tracker.stored(issue.id).subscribers).toContain(world.maintainer.id);
  });
});
