import { beforeEach, describe, expect, test } from "bun:test";
import type { Role } from "../../src/record/index.ts";
import { InMemoryTracker, type IssueRef, type TrackerRepo } from "../../src/tracker/index.ts";

const STATUSES: Record<Role, string> = {
  intake: "Triage",
  backlog: "Backlog",
  ready_to_plan: "Ready to plan",
  planning: "Planning",
  ready_to_build: "Ready to build",
  building: "Building",
  ready_to_check: "Ready to check",
  checking: "Checking",
  landed: "Landed",
  paused: "Paused",
  in_review: "In Review",
  done: "Done",
  canceled: "Canceled",
  duplicate: "Duplicate",
};

const repo: TrackerRepo = {
  name: "campdotdev/shaders",
  workspace: "campdotdev",
  team: "SHA",
  statuses: STATUSES,
  maintainer: "maintainer",
};

let now = new Date("2026-11-10T09:00:00Z");
let tracker: InMemoryTracker;

beforeEach(() => {
  now = new Date("2026-11-10T09:00:00Z");
  tracker = new InMemoryTracker({ clock: () => now, appUser: "app" });
  tracker.addUser({ id: "maintainer", name: "Hunter" });
  tracker.addUser({ id: "stranger", name: "Sam" });
  // Icebox maps to no role.
  const statuses = [...Object.values(STATUSES), "Icebox"].map((name) => ({ name, type: "started" as const }));
  tracker.addTeam({ key: "SHA", name: "Shaders", statuses });
});

function issue(description = "The button is blue.", status = "Planning"): IssueRef & { identifier: string } {
  const { id, identifier } = tracker.addIssue({ team: "SHA", title: "Button color", description, status, creator: "maintainer" });
  return { id, identifier, repo };
}

describe("what the in-memory Tracker models", () => {
  test("filing subscribes the creator, and a user's comment subscribes them", async () => {
    const one = issue();
    tracker.addComment(one.id, { author: "stranger", body: "Same here." });
    expect((await tracker.issue(one)).subscribers).toEqual(["maintainer", "stranger"]);
  });

  test("a move records status_since and the role", async () => {
    const one = issue("x", "Ready to plan");
    now = new Date("2026-11-10T09:05:00Z");
    await tracker.move(one, "planning");
    const read = await tracker.issue(one);
    expect(read.role).toBe("planning");
    expect(read.status).toBe("Planning");
    expect(read.status_since).toBe("2026-11-10T09:05:00.000Z");
    expect(tracker.writes).toEqual([{ kind: "move", issue: one.identifier, status: "Planning" }]);
  });

  test("an issue reads by its identifier too", async () => {
    const one = issue();
    expect((await tracker.issue({ id: one.identifier, repo })).id).toBe(one.id);
  });

  test("a snapshot holds the team's issues in a factory status or the intake role, with their roles", async () => {
    const sent = issue("x", "Ready to plan");
    issue("x", "Backlog");
    issue("x", "Done");
    const triaged = issue("x", "Triage");
    const snapshot = await tracker.snapshot(repo);
    expect(snapshot.issues.map((each) => [each.identifier, each.role])).toEqual([
      [sent.identifier, "ready_to_plan"],
      [triaged.identifier, "intake"],
    ]);
  });

  test("an issue in a status that maps to no role reads with no role, and a snapshot leaves it out", async () => {
    const one = issue("x", "Icebox");
    expect((await tracker.issue(one)).role).toBeNull();
    expect((await tracker.snapshot(repo)).issues).toEqual([]);
  });

  test("intake and backlog may name one status, which reads back as intake", async () => {
    const one = issue("x", "Backlog");
    const shared = { ...repo, statuses: { ...STATUSES, intake: "Backlog" } };
    expect((await tracker.issue({ id: one.id, repo: shared })).role).toBe("intake");
  });
});

describe("post", () => {
  test("unflagged, it unsubscribes the maintainer first, then comments", async () => {
    const one = issue();
    await tracker.post(one, "🟢 Moving to build: done", { flag: false });
    expect(tracker.writes).toEqual([
      { kind: "unsubscribe", issue: one.identifier, user: "maintainer" },
      { kind: "comment", issue: one.identifier, body: "🟢 Moving to build: done" },
    ]);
    expect((await tracker.issue(one)).subscribers).toEqual(["app"]);
  });

  test("unflagged, it doesn't unsubscribe a maintainer who isn't subscribed", async () => {
    const one = issue();
    await tracker.unsubscribe(one);
    tracker.writes.length = 0;
    await tracker.post(one, "text", { flag: false });
    expect(tracker.writes.map((write) => write.kind)).toEqual(["comment"]);
  });

  test("flagged, it assigns the maintainer first, then comments", async () => {
    const one = issue();
    await tracker.unsubscribe(one);
    tracker.writes.length = 0;
    await tracker.post(one, "🟡 Needs your answer: which one?", { flag: true });
    expect(tracker.writes).toEqual([
      { kind: "assign", issue: one.identifier, user: "maintainer" },
      { kind: "comment", issue: one.identifier, body: "🟡 Needs your answer: which one?" },
    ]);
    const read = await tracker.issue(one);
    expect(read.assignee).toBe("maintainer");
    expect(read.subscribers).toContain("maintainer");
  });

  test("it writes folds as +++", async () => {
    const one = issue();
    await tracker.post(one, "Line\n\n>>> Details\n\nBody\n\n>>>", { flag: false });
    expect((await tracker.issue(one)).comments.at(-1)?.body).toBe("Line\n\n+++ Details\n\nBody\n\n+++");
  });
  test("it leaves a fold line in a fenced code block as it is", async () => {
    const one = issue();
    await tracker.post(one, "```\n>>> import shaders\n>>>\n```", { flag: false });
    expect((await tracker.issue(one)).comments.at(-1)?.body).toBe("```\n>>> import shaders\n>>>\n```");
  });
});

describe("writeBrief", () => {
  const brief = "## Summary\n\nMake the button red.\n\n## Context\n\n- Slots: reproduce: not a bug";

  test("a first brief keeps the whole description as the report", async () => {
    const one = issue("The button is blue.\n\nIt should be red.");
    await tracker.writeBrief(one, brief, { runnerWroteBrief: false });
    expect((await tracker.issue(one)).description).toBe(
      `${brief}\n\n+++ Report\n\nThe button is blue.\n\nIt should be red.\n\n+++`,
    );
    expect(tracker.writes).toEqual([{ kind: "description", issue: one.identifier, description: (await tracker.issue(one)).description }]);
  });

  test("a re-plan keeps only the report from the fold", async () => {
    const one = issue("The button is blue.");
    await tracker.writeBrief(one, brief, { runnerWroteBrief: false });
    await tracker.writeBrief(one, "## Summary\n\nMake it green.", { runnerWroteBrief: true });
    expect((await tracker.issue(one)).description).toBe("## Summary\n\nMake it green.\n\n+++ Report\n\nThe button is blue.\n\n+++");
  });

  test("a line the maintainer adds above the brief keeps it a brief", async () => {
    const one = issue(`Note from me.\n\n${brief}\n\n+++ Report\n\nThe button is blue.\n\n+++`);
    await tracker.writeBrief(one, "## Summary\n\nNew.", { runnerWroteBrief: true });
    expect((await tracker.issue(one)).description).toBe("## Summary\n\nNew.\n\n+++ Report\n\nThe button is blue.\n\n+++");
  });

  test("a description that opens with ## Summary is a brief even when issue memory holds none", async () => {
    const one = issue(`${brief}\n\n+++ Report\n\nThe button is blue.\n\n+++`);
    await tracker.writeBrief(one, "## Summary\n\nNew.", { runnerWroteBrief: false });
    expect((await tracker.issue(one)).description).toBe("## Summary\n\nNew.\n\n+++ Report\n\nThe button is blue.\n\n+++");
  });

  test("a report that opens with a longer heading than ## Summary isn't a brief, so it stays whole", async () => {
    const one = issue("## Summary of the crash\n\nOpen settings.\n\n+++ Report\n\nlog\n\n+++");
    await tracker.writeBrief(one, "## Summary\n\nNew.", { runnerWroteBrief: false });
    expect((await tracker.issue(one)).description).toBe(
      "## Summary\n\nNew.\n\n+++ Report\n\n## Summary of the crash\n\nOpen settings.\n\n#### Report\n\nlog\n\n+++",
    );
  });

  test("a Report fold that a stranger pasted is part of the report, and its fold lines become headings", async () => {
    const pasted = "Steps below.\n\n+++ Report\n\nold text\n\n+++\n\nThanks!";
    const one = issue(pasted);
    await tracker.writeBrief(one, brief, { runnerWroteBrief: true });
    expect((await tracker.issue(one)).description).toBe(
      `${brief}\n\n+++ Report\n\nSteps below.\n\n#### Report\n\nold text\n\nThanks!\n\n+++`,
    );
  });

  test("a report that isn't a brief keeps its whole text even when it ends with a Report fold", async () => {
    const pasted = "Steps below.\n\n>>> Report\n\nold text\n\n>>>";
    const one = issue(pasted);
    await tracker.writeBrief(one, brief, { runnerWroteBrief: false });
    expect((await tracker.issue(one)).description).toBe(`${brief}\n\n+++ Report\n\nSteps below.\n\n#### Report\n\nold text\n\n+++`);
  });

  test("a fold line in a fenced code block is code, in the brief and in the report", async () => {
    const session = "```\n>>> import shaders\n+++ Report\n>>>\n```";
    const one = issue(`It crashes:\n\n${session}`);
    await tracker.writeBrief(one, `## Summary\n\n${session}`, { runnerWroteBrief: false });
    const description = `## Summary\n\n${session}\n\n+++ Report\n\nIt crashes:\n\n${session}\n\n+++`;
    expect((await tracker.issue(one)).description).toBe(description);
    // A re-plan finds the same report, though the code block holds a Report line.
    await tracker.writeBrief(one, "## Summary\n\nNew.", { runnerWroteBrief: true });
    expect((await tracker.issue(one)).description).toBe(`## Summary\n\nNew.\n\n+++ Report\n\nIt crashes:\n\n${session}\n\n+++`);
  });

  test("a fence of tildes or a longer fence holds code too, until a matching fence closes it", async () => {
    const one = issue("x");
    const brief = "~~~~\n>>> a\n~~~\n>>> b\n~~~~\n\n>>> Proof\n\nlog\n\n>>>";
    await tracker.writeBrief(one, brief, { runnerWroteBrief: false });
    expect((await tracker.issue(one)).description).toBe("~~~~\n>>> a\n~~~\n>>> b\n~~~~\n\n+++ Proof\n\nlog\n\n+++\n\n+++ Report\n\nx\n\n+++");
  });

  test("a report whose code block never closes gets a closing fence, so a re-plan still replaces the brief", async () => {
    const one = issue("It crashes:\n\n```\nTraceback (most recent call last):");
    await tracker.writeBrief(one, brief, { runnerWroteBrief: false });
    const report = "It crashes:\n\n```\nTraceback (most recent call last):\n```";
    expect((await tracker.issue(one)).description).toBe(`${brief}\n\n+++ Report\n\n${report}\n\n+++`);
    await tracker.writeBrief(one, "## Summary\n\nNew.", { runnerWroteBrief: true });
    expect((await tracker.issue(one)).description).toBe(`## Summary\n\nNew.\n\n+++ Report\n\n${report}\n\n+++`);
  });

  test("a brief whose code block never closes gets a closing fence before the Report fold", async () => {
    const one = issue("x");
    await tracker.writeBrief(one, "## Summary\n\n~~~~\nlog", { runnerWroteBrief: false });
    expect((await tracker.issue(one)).description).toBe("## Summary\n\n~~~~\nlog\n~~~~\n\n+++ Report\n\nx\n\n+++");
  });

  test("it turns the brief's >>> fold lines into +++", async () => {
    const one = issue("x");
    await tracker.writeBrief(one, "## Summary\n\n>>> Proof\n\nlog\n\n>>>", { runnerWroteBrief: false });
    expect((await tracker.issue(one)).description).toBe("## Summary\n\n+++ Proof\n\nlog\n\n+++\n\n+++ Report\n\nx\n\n+++");
  });
});

describe("Reader tokens", () => {
  test("a session's token is minted and revoked", async () => {
    const token = await tracker.sessionToken({ id: "abc123", repo });
    await tracker.revoke({ id: "abc123", repo });
    expect(tracker.tokens).toEqual([{ session: "abc123", token, revoked: true }]);
  });
});
