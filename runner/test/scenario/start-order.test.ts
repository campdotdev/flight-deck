// The runner starts at most `concurrency_cap` sessions across every repo on the Mac, highest priority first, then
// the issue that unblocks the most, then the oldest (spec 1's "Starts", ADR 0002). Below the pinned Claude Code
// version it starts nothing (ADR 0015).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { NewIssue, StoredIssue } from "../../src/tracker/index.ts";
import { outbox, World } from "./world.ts";

let world: World;

/** Two repos fetch and prepare with real git at every tick, so these scenarios take longer than one repo's. */
const TWO_REPOS_MS = 30_000;

beforeEach(async () => {
  world = await World.create();
});

afterEach(async () => {
  await world.cleanup();
});

/** Files and sends an issue, a minute after the last one, so creation times differ. */
function sent(input: Partial<NewIssue> & { title: string }): StoredIssue {
  world.now = new Date(world.now.getTime() + 60_000);
  const issue = world.issue(input);
  world.send(issue);
  return issue;
}

function startedIssues(): string[] {
  return world.harness.started.map((each) => each.session.issue);
}

describe("the start order", () => {
  test("follows priority, with no priority after Low, then unblocks, then creation time, across every repo", async () => {
    await world.addRepo({ name: "campdotdev/docs", team: "DOC" });
    world.config.concurrency_cap = 10;
    await world.writeConfig();
    const none = sent({ title: "No priority" });
    const low = sent({ title: "Low", priority: 4, team: "DOC" });
    const highOld = sent({ title: "High, older", priority: 2 });
    const highUnblocks = sent({ title: "High, unblocks one", priority: 2, team: "DOC" });
    const highNew = sent({ title: "High, newer", priority: 2 });
    const urgent = sent({ title: "Urgent", priority: 1, team: "DOC" });
    const waiting = world.issue({ title: "Waits on the high one", team: "DOC" });
    world.tracker.addBlocker(waiting.id, highUnblocks.id);
    await world.tick();
    expect(startedIssues()).toEqual([urgent, highUnblocks, highOld, highNew, low, none].map((issue) => issue.identifier));
  }, TWO_REPOS_MS);
});

describe("the concurrency cap", () => {
  test("holds across two repos, and a freed place goes to the next issue in the order", async () => {
    await world.addRepo({ name: "campdotdev/docs", team: "DOC" });
    const first = sent({ title: "Shaders, high", priority: 2 });
    const second = sent({ title: "Docs, high", priority: 2, team: "DOC" });
    const third = sent({ title: "Docs, medium", priority: 3, team: "DOC" });
    world.harness.script(second.identifier, { outbox: outbox.brief({ summary: "Brief ready", brief: "## Summary\n\nDocs." }) });
    await world.tick();
    expect(startedIssues()).toEqual([first.identifier, second.identifier]);
    expect(world.tracker.stored(third.id).status).toBe("Ready to plan");
    await world.tick();
    expect(startedIssues()).toHaveLength(2);

    world.harness.finish(world.harness.started[1]!.session.id, { kind: "exited", code: 0 });
    await world.tick();
    expect(startedIssues()).toEqual([first.identifier, second.identifier, third.identifier]);
    expect(world.tracker.stored(second.id).status).toBe("Ready to build");
    expect(world.harness.started[2]!.session.repo).toBe("campdotdev/docs");
    expect((await world.status()).sessions).toHaveLength(2);
  }, TWO_REPOS_MS);
});

describe("the Claude Code version check", () => {
  test("starts nothing below data/claude-code.toml's min_version, still runs the blocker test, and starts once claude is updated", async () => {
    world.harness.claudeCodeVersion = "2.1.99";
    const issue = sent({ title: "Save button is blue" });
    const blocked = sent({ title: "Waits on a canceled one" });
    world.tracker.addBlocker(blocked.id, world.issue({ title: "Canceled", status: "Canceled" }).id);
    await world.tick();
    expect(world.harness.started).toEqual([]);
    expect(world.tracker.stored(issue.id).status).toBe("Ready to plan");
    expect(world.tracker.stored(blocked.id).status).toBe("Paused");

    world.harness.claudeCodeVersion = "2.10.0";
    await world.tick();
    expect(startedIssues()).toEqual([issue.identifier]);
  });
});
