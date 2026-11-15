// A GitHub-synced issue is detached before the runner writes its brief or marks it a duplicate, so neither
// reaches the GitHub issue (ADR 0008), and never otherwise.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { StoredIssue } from "../../src/tracker/index.ts";
import { outbox, World } from "./world.ts";

const BRIEF = "## Summary\n\nThe settings page's Save button turns red.\n\n## Key interfaces\n\nNone.";
const SUMMARY = "Brief ready: the Save button turns red\n\nIt takes the shared red.";
const PAUSE = "## Question\n\nWhich red?";

let world: World;

beforeEach(async () => {
  world = await World.create();
});

afterEach(async () => {
  await world.cleanup();
});

async function planned(issue: StoredIssue, files: Record<string, string>): Promise<void> {
  world.send(issue);
  world.harness.script(issue.identifier, { outbox: files, exit: { kind: "exited", code: 0 } });
  await world.tick();
  await world.tick();
}

/** The kinds of the issue's writes after the take. */
function afterTake(issue: StoredIssue): string[] {
  const writes = world.tracker.writes.filter((write) => "issue" in write && write.issue === issue.identifier);
  const take = writes.findIndex((write) => write.kind === "move" && write.status === "Planning");
  return writes.slice(take + 1).map((write) => write.kind);
}

describe("a synced issue", () => {
  test("is detached before its brief", async () => {
    const issue = world.issue({ title: "Save button is blue", description: "It should be red.", status: "Triage", synced: true });
    const attachment = world.tracker.stored(issue.id).sync_attachment!;
    await planned(issue, outbox.brief({ summary: SUMMARY, brief: BRIEF }));
    expect(afterTake(issue)).toEqual(["detach", "description", "comment", "move"]);
    expect(world.tracker.writes).toContainEqual({ kind: "detach", issue: issue.identifier, attachment });
    expect(world.tracker.stored(issue.id).synced).toBe(false);
    expect(world.tracker.stored(issue.id).sync_attachment).toBe(attachment);
  });

  test("is detached before a duplicate mark", async () => {
    const original = world.issue({ title: "Save button is blue", status: "Backlog" });
    const issue = world.issue({ title: "Blue Save button", status: "Triage", synced: true });
    await planned(issue, outbox.duplicate({ summary: "Same as the open issue\n\nBoth say blue.", of: original.identifier }));
    expect(afterTake(issue)).toEqual(["detach", "comment", "duplicate"]);
  });

  test("isn't detached for a pause", async () => {
    const issue = world.issue({ title: "Save button is blue", status: "Triage", synced: true });
    await planned(issue, outbox.pause({ summary: "Which red?\n\nThere are two.", pause: PAUSE, answers: [{ word: "brand", does: "uses brand red", move: "ready_to_plan" }], needs: "answer" }));
    expect(afterTake(issue)).toEqual(["assign", "comment", "move"]);
    expect(world.tracker.stored(issue.id).synced).toBe(true);
  });

  test("a second brief after the detach detaches nothing", async () => {
    const issue = world.issue({ title: "Save button is blue", status: "Triage", synced: true });
    await planned(issue, outbox.brief({ summary: SUMMARY, brief: BRIEF }));
    await planned(issue, outbox.brief({ summary: SUMMARY, brief: BRIEF.replace("red", "dark red") }));
    expect(world.tracker.writes.filter((write) => write.kind === "detach")).toHaveLength(1);
  });
});

describe("an issue that isn't synced", () => {
  test("is never detached", async () => {
    const issue = world.issue({ title: "Save button is blue", description: "It should be red." });
    await planned(issue, outbox.brief({ summary: SUMMARY, brief: BRIEF }));
    expect(afterTake(issue)).toEqual(["description", "comment", "move"]);
  });
});
