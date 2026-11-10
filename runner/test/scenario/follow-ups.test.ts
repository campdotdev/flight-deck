// Plan files anything it finds outside the brief as an unsent follow-up issue in Triage, related to the
// issue, with no flag (ADRs 0007, 0011, and 0013). Follow-ups are the last writes for every plan outcome.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { StoredIssue, TrackerWrite } from "../../src/tracker/index.ts";
import { outbox, World } from "./world.ts";

const BRIEF = "## Summary\n\nThe settings page's Save button turns red.\n\n## Key interfaces\n\nNone.";
const SUMMARY = "Brief ready: the Save button turns red\n\nIt takes the shared red.";
const FOLLOW_UPS = {
  "follow-ups/1.md": "# The Cancel button is blue too\n\nThe settings page's Cancel button uses the same local style.\n",
  "follow-ups/2.md": "# Flaky settings test\n\n`settings.test.ts` failed once in ten runs.",
};

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

const footer = () => `Flight Deck ${world.version} · plan · follow-up`;

/** The two follow-ups' writes, filed after the issue's last write. */
function filed(issue: StoredIssue, first: string, second: string): TrackerWrite[] {
  return [
    {
      kind: "file",
      issue: first,
      title: "The Cancel button is blue too",
      description: `The settings page's Cancel button uses the same local style.\n\n${footer()}`,
      status: "Triage",
    },
    { kind: "relate", issue: first, other: issue.identifier, relation: "related" },
    { kind: "file", issue: second, title: "Flaky settings test", description: `\`settings.test.ts\` failed once in ten runs.\n\n${footer()}`, status: "Triage" },
    { kind: "relate", issue: second, other: issue.identifier, relation: "related" },
  ];
}

describe("follow-up issues", () => {
  test("are filed in Triage and related after a brief, with no flag", async () => {
    const issue = world.issue({ title: "Save button is blue", description: "It should be red." });
    await planned(issue, { ...outbox.brief({ summary: SUMMARY, brief: BRIEF }), ...FOLLOW_UPS });
    const writes = world.tracker.writes;
    const last = writes.findIndex((write) => write.kind === "move" && write.status === "Ready to build");
    expect(writes.slice(last + 1)).toEqual(filed(issue, "SHA-2", "SHA-3"));
    for (const identifier of ["SHA-2", "SHA-3"]) {
      const followUp = world.tracker.stored(identifier);
      expect([followUp.assignee, followUp.subscribers, followUp.priority]).toEqual([null, [world.appUser], 0]);
    }
  });

  test("are filed after a pause's writes, with no flag of their own", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    const pause = outbox.pause({ summary: "Which red?\n\nThere are two.", pause: "## Question\n\nWhich red?", answers: [], needs: "help" });
    await planned(issue, { ...pause, ...FOLLOW_UPS });
    const writes = world.tracker.writes;
    const last = writes.findIndex((write) => write.kind === "move" && write.status === "Paused");
    expect(writes.slice(last + 1)).toEqual(filed(issue, "SHA-2", "SHA-3"));
    expect(writes.filter((write) => write.kind === "assign").map((write) => write.issue)).toEqual([issue.identifier]);
    expect((await world.status()).flags.map((flag) => flag.issue)).toEqual([issue.identifier]);
  });

  test("are filed after a duplicate mark", async () => {
    const original = world.issue({ title: "Save button is blue", status: "Backlog" });
    const issue = world.issue({ title: "Blue Save button" });
    await planned(issue, { ...outbox.duplicate({ summary: "Same as the open issue\n\nBoth say blue.", of: original.identifier }), ...FOLLOW_UPS });
    const writes = world.tracker.writes;
    const last = writes.findIndex((write) => write.kind === "duplicate");
    expect(writes.slice(last + 1)).toEqual(filed(issue, "SHA-3", "SHA-4"));
  });

  test("are filed in their number's order", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await planned(issue, {
      ...outbox.brief({ summary: SUMMARY, brief: BRIEF }),
      "follow-ups/10.md": "# Tenth\n\nx",
      "follow-ups/2.md": "# Second\n\ny",
    });
    expect(world.tracker.writes.flatMap((write) => (write.kind === "file" ? [write.title] : []))).toEqual(["Second", "Tenth"]);
  });

  test("a follow-up with only a title gets only the footer", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await planned(issue, { ...outbox.brief({ summary: SUMMARY, brief: BRIEF }), "follow-ups/1.md": "# Just a title\n" });
    expect(world.tracker.writes.find((write) => write.kind === "file")).toEqual({ kind: "file", issue: "SHA-2", title: "Just a title", description: footer(), status: "Triage" });
  });
});

describe("a follow-up the Outbox refuses", () => {
  test.each([
    ["isn't named <n>.md", { "follow-ups/cancel.md": "# Cancel\n\nx" }],
    ["doesn't open with a title", { "follow-ups/1.md": "The Cancel button is blue too." }],
    ["has an empty title", { "follow-ups/1.md": "# \n\nx" }],
  ])("that %s fails the outbox before any write", async (_, files) => {
    const issue = world.issue({ title: "Save button is blue" });
    await planned(issue, { ...outbox.brief({ summary: SUMMARY, brief: BRIEF }), ...files });
    expect(world.tracker.writes.map((write) => write.kind)).toEqual(["unsubscribe", "move"]);
  });
});
