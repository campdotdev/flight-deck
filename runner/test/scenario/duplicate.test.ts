// Plan marks a duplicate of an open issue without pausing (ADRs 0006 and 0026).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { StoredIssue } from "../../src/tracker/index.ts";
import { outbox, World } from "./world.ts";
import { STATUSES } from "../statuses.ts";

const SUMMARY = "Same report as the open Save button issue\n\nBoth say the settings page's Save button is blue.";

let world: World;

beforeEach(async () => {
  world = await World.create();
});

afterEach(async () => {
  await world.cleanup();
});

/** Sends the issue, and its plan session leaves the files. Returns the session ID. */
async function planned(issue: StoredIssue, files: Record<string, string | Uint8Array>): Promise<string> {
  world.send(issue);
  world.harness.script(issue.identifier, { outbox: files, exit: { kind: "exited", code: 0 } });
  await world.tick();
  await world.tick();
  return world.harness.started.at(-1)!.session.id;
}

/** The issue's writes after the take. */
function afterTake(issue: StoredIssue) {
  const writes = world.tracker.writes.filter((write) => !("issue" in write) || write.issue === issue.identifier);
  const take = writes.findIndex((write) => write.kind === "move" && write.issue === issue.identifier && write.status === "Planning");
  return writes.slice(take + 1);
}

describe("a duplicate", () => {
  test("is marked, and the comment names and links the open issue, with the footer last and no Details fold", async () => {
    const original = world.issue({ title: "Save button is blue", status: "Ready to build" });
    const issue = world.issue({ title: "Blue Save button", description: "The Save button is blue." });
    const session = await planned(issue, outbox.duplicate({ summary: SUMMARY, of: original.identifier }));
    const comment = [
      "🟢 Marked duplicate: Same report as the open Save button issue",
      "",
      "Both say the settings page's Save button is blue.",
      "",
      `Duplicate of [Save button is blue](https://linear.app/campdotdev/issue/${original.identifier}).`,
      "",
      `Flight Deck ${world.version} · plan · session ${session}`,
    ].join("\n");
    expect(afterTake(issue)).toEqual([
      { kind: "comment", issue: issue.identifier, body: comment },
      { kind: "duplicate", issue: issue.identifier, of: original.identifier, status: "Duplicate" },
    ]);
    expect(world.tracker.stored(issue.id).duplicate_of).toBe(original.id);
    expect(world.tracker.stored(issue.id).assignee).toBeNull();
  });

  test("keeps the link when the summary is left out", async () => {
    const original = world.issue({ title: "Save button is blue", status: "Triage" });
    const issue = world.issue({ title: "Blue Save button" });
    const files = outbox.duplicate({ summary: SUMMARY, of: original.identifier });
    delete files["summary.md"];
    const session = await planned(issue, files);
    expect(afterTake(issue)[0]).toEqual({
      kind: "comment",
      issue: issue.identifier,
      body: `🟢 Marked duplicate\n\nDuplicate of [Save button is blue](https://linear.app/campdotdev/issue/${original.identifier}).\n\nFlight Deck ${world.version} · plan · session ${session}`,
    });
  });

  test.each([
    ["Backlog"],
    ["Triage"],
    ["Ready to plan"],
    ["Paused"],
    ["In Review"],
  ])("of an issue in %s, an open status, is marked", async (status) => {
    const original = world.issue({ title: "Save button is blue", status });
    const issue = world.issue({ title: "Blue Save button" });
    await planned(issue, outbox.duplicate({ summary: SUMMARY, of: original.identifier }));
    expect(afterTake(issue).at(-1)).toEqual({ kind: "duplicate", issue: issue.identifier, of: original.identifier, status: "Duplicate" });
  });
});

describe("a duplicate the Outbox refuses", () => {
  test.each([
    ["a done issue", () => world.issue({ title: "Save button is blue", status: STATUSES.done[0] }).identifier],
    ["a canceled issue", () => world.issue({ title: "Save button is blue", status: STATUSES.canceled[0] }).identifier],
    ["a duplicate issue", () => world.issue({ title: "Save button is blue", status: STATUSES.duplicate[0] }).identifier],
    [
      "another team's issue",
      () => {
        world.tracker.addTeam({ key: "OTH", name: "Other", statuses: [{ name: "Todo", type: "unstarted" }] });
        return world.tracker.addIssue({ team: "OTH", title: "Save button is blue", status: "Todo", creator: world.maintainer.id }).identifier;
      },
    ],
    ["an issue that doesn't exist", () => "SHA-99"],
    ["the issue itself", () => "SELF"],
  ])("of %s writes nothing to the issue", async (_, of) => {
    const target = of();
    const issue = world.issue({ title: "Blue Save button" });
    await planned(issue, outbox.duplicate({ summary: SUMMARY, of: target === "SELF" ? issue.identifier : target }));
    expect(afterTake(issue)).toEqual([]);
    expect(world.tracker.stored(issue.id).status).toBe("Planning");
  });
});
