// The Linear adapter's `issue`, its team check, and its writes, with the rules it hides: the role map, `+++`
// folds, top-level comments, the write order for flags and unsubscribes, the brief's report, unsigned uploads,
// detach, and duplicates in one request (spec 1, "Tracker (Linear)").
import { afterEach, describe, expect, test } from "bun:test";
import { IssueNotFoundError, TrackerRefused, type LinearTracker } from "../../../src/tracker/index.ts";
import { notFound, type FakeLinear } from "./fake-linear.ts";
import { commentNode, issueNode, page, repo, stateId, TEAM_ID, teamReply, uuid, world } from "./linear-world.ts";
import { STATUS_NAMES } from "../../statuses.ts";

let linear: FakeLinear;
let tracker: LinearTracker;
afterEach(() => linear.stop());

function start(): void {
  ({ linear, tracker } = world());
  linear.on("FlightDeckUpdate", { data: { issueUpdate: { success: true } } });
  linear.on("FlightDeckUnsubscribe", { data: { issueUnsubscribe: { success: true } } });
  linear.on("FlightDeckComment", { data: { commentCreate: { success: true, comment: { id: "comment-1", createdAt: "2026-11-10T09:00:00.000Z" } } } });
}

const ref = { id: uuid(1), repo };

/** The writes, as operation names with their variables, leaving out reads. */
function writes(): [string, Record<string, unknown>][] {
  return linear.requests.filter((request) => request.query.startsWith("mutation")).map((request) => [request.operation, request.variables]);
}

function flagState(assignee: string | null, subscribed: boolean) {
  return { data: { issue: { id: uuid(1), identifier: "SHA-1", assignee: assignee === null ? null : { id: assignee }, subscribers: { nodes: subscribed ? [{ id: repo.maintainer }] : [] } } } };
}

function fullIssue(overrides: Record<string, unknown> = {}) {
  return {
    ...issueNode({ n: 1, status: "Planning" }),
    description: "The button is blue.",
    team: { key: "SHA" },
    creator: { id: "user-sam" },
    syncedWith: null,
    attachments: { nodes: [] },
    comments: page([]),
    ...overrides,
  };
}

describe("issue", () => {
  test("returns the creator, description, and each comment's author, time, parent, and sync origin, oldest first", async () => {
    start();
    linear.on("FlightDeckIssue", {
      data: {
        issue: fullIssue({
          comments: page([commentNode({ id: "c2", createdAt: "2026-11-10T09:02:00.000Z", parent: "c1", user: "user-sam" }), commentNode({ id: "c1", createdAt: "2026-11-10T09:01:00.000Z" })], "more"),
        }),
      },
    });
    linear.on("FlightDeckIssueComments", { data: { issue: { comments: page([commentNode({ id: "c3", createdAt: "2026-11-10T09:03:00.000Z", user: null, externalUser: "ext-1" })]) } } });
    const issue = await tracker.issue(ref);
    expect(linear.sent("FlightDeckIssueComments")[0]!.variables).toEqual({ id: uuid(1), after: "more" });
    expect(issue).toMatchObject({
      id: uuid(1),
      identifier: "SHA-1",
      role: "planning",
      team: "SHA",
      status_type: "started",
      description: "The button is blue.",
      creator: "user-sam",
      synced: false,
      sync_attachment: null,
      archived: false,
      blockers: [],
      unblocks: 0,
    });
    expect(issue.comments).toEqual([
      { id: "c1", author: "user-maintainer", body: "A comment.", created_at: "2026-11-10T09:01:00.000Z", parent: null, synced: false },
      { id: "c2", author: "user-sam", body: "A comment.", created_at: "2026-11-10T09:02:00.000Z", parent: "c1", synced: false },
      { id: "c3", author: "ext-1", body: "A comment.", created_at: "2026-11-10T09:03:00.000Z", parent: null, synced: true },
    ]);
  });

  test("a synced issue returns the GitHub attachment's ID; an archived one says so", async () => {
    start();
    linear.on("FlightDeckIssue", {
      data: {
        issue: fullIssue({
          archivedAt: "2026-11-09T09:00:00.000Z",
          syncedWith: [{ service: "github" }],
          attachments: { nodes: [{ id: "att-figma", url: "https://figma.com/file/x", sourceType: "figma" }, { id: "att-gh", url: "https://github.com/campdotdev/shaders/issues/7", sourceType: "github" }] },
        }),
      },
    });
    expect(await tracker.issue(ref)).toMatchObject({ synced: true, sync_attachment: "att-gh", archived: true });
  });

  test("an issue in another team's status has no role", async () => {
    start();
    linear.on("FlightDeckIssue", { data: { issue: fullIssue({ team: { key: "OPS" }, state: { name: "Todo", type: "unstarted" } }) } });
    expect(await tracker.issue(ref)).toMatchObject({ role: null, team: "OPS", status: "Todo", status_type: "unstarted" });
  });

  test("an issue Linear can't find throws IssueNotFoundError", async () => {
    start();
    linear.on("FlightDeckIssue", notFound());
    expect(await tracker.issue({ id: "SHA-404", repo }).catch((caught: unknown) => caught)).toBeInstanceOf(IssueNotFoundError);
  });
});

describe("checkTeam", () => {
  test("passes when every status the role map names is on the team", async () => {
    start();
    expect(await tracker.checkTeam(repo)).toEqual({ ok: true });
    expect(linear.sent("FlightDeckTeam")[0]!.variables).toEqual({ key: "SHA" });
  });

  test("lists the roles whose status is missing, in the record's role order", async () => {
    start();
    linear.on("FlightDeckTeam", teamReply(Object.values(STATUS_NAMES).filter((name) => name !== "Paused" && name !== "Triage")));
    expect(await tracker.checkTeam(repo)).toEqual({ ok: false, reason: "missing", roles: ["intake", "paused"] });
  });

  test("a team the app can't read, by that key, is unreadable", async () => {
    start();
    linear.on("FlightDeckTeam", { data: { teams: { nodes: [] } } });
    expect(await tracker.checkTeam(repo)).toEqual({ ok: false, reason: "unreadable" });
  });

  test("a status the cached team lacks is read again once: found, the move lands; still missing, it's refused", async () => {
    start();
    linear.on("FlightDeckTeam", teamReply(["Planning"]));
    await tracker.checkTeam(repo);
    linear.once("FlightDeckTeam", teamReply(["Planning", "Paused"]));
    await tracker.move(ref, "paused");
    await expect(tracker.move(ref, "landed")).rejects.toThrow(new TrackerRefused("team SHA has no status Landed"));
    expect(linear.operations()).toEqual(["FlightDeckTeam", "FlightDeckTeam", "FlightDeckUpdate", "FlightDeckTeam"]);
    expect(writes()).toEqual([["FlightDeckUpdate", { id: uuid(1), input: { stateId: stateId("Paused") } }]]);
  });
});

describe("the writes", () => {
  test("move sets the status the record names for the role", async () => {
    start();
    await tracker.move(ref, "ready_to_build");
    expect(writes()).toEqual([["FlightDeckUpdate", { id: uuid(1), input: { stateId: stateId("Ready to build") } }]]);
  });

  test("a flagged post assigns the maintainer, then comments, top-level, with every fold as +++", async () => {
    start();
    linear.on("FlightDeckFlagState", flagState(null, false));
    const posted = await tracker.post({ id: "SHA-1", repo }, "🟡 Needs your answer.\n\n>>> Details\n\nx\n\n>>>", { flag: true });
    expect(posted).toEqual({ id: "comment-1", created_at: "2026-11-10T09:00:00.000Z" });
    expect(linear.sent("FlightDeckFlagState")[0]!.variables).toEqual({ id: "SHA-1", user: repo.maintainer });
    expect(writes()).toEqual([
      ["FlightDeckUpdate", { id: uuid(1), input: { assigneeId: repo.maintainer } }],
      ["FlightDeckComment", { input: { issueId: uuid(1), body: "🟡 Needs your answer.\n\n+++ Details\n\nx\n\n+++" } }],
    ]);
  });

  test("an unflagged post unsubscribes a subscribed maintainer first, so the comment notifies nobody", async () => {
    start();
    linear.on("FlightDeckFlagState", flagState("user-sam", true));
    await tracker.post(ref, "🟢 Brief ready.", { flag: false });
    expect(writes()).toEqual([
      ["FlightDeckUnsubscribe", { id: uuid(1), user: repo.maintainer }],
      ["FlightDeckComment", { input: { issueId: uuid(1), body: "🟢 Brief ready." } }],
    ]);
  });

  test("an unflagged post on an issue the runner flagged, or one the maintainer isn't subscribed to, only comments", async () => {
    start();
    linear.once("FlightDeckFlagState", flagState(repo.maintainer, true));
    linear.once("FlightDeckFlagState", flagState(null, false));
    await tracker.post(ref, "Cleared.", { flag: false });
    await tracker.post(ref, "Cleared.", { flag: false });
    expect(writes().map(([operation]) => operation)).toEqual(["FlightDeckComment", "FlightDeckComment"]);
  });

  test("clearFlag clears the assignee, then unsubscribes the maintainer Linear kept subscribed", async () => {
    start();
    linear.once("FlightDeckFlagState", flagState(repo.maintainer, false));
    await tracker.clearFlag(ref);
    expect(writes()).toEqual([
      ["FlightDeckUpdate", { id: uuid(1), input: { assigneeId: null } }],
      ["FlightDeckUnsubscribe", { id: uuid(1), user: repo.maintainer }],
    ]);
  });

  test("clearFlag on an issue with no assignee and no subscription writes nothing", async () => {
    start();
    linear.on("FlightDeckFlagState", flagState(null, false));
    await tracker.clearFlag(ref);
    expect(writes()).toEqual([]);
  });

  test("flag assigns the maintainer and posts nothing", async () => {
    start();
    await tracker.flag(ref);
    expect(writes()).toEqual([["FlightDeckUpdate", { id: uuid(1), input: { assigneeId: repo.maintainer } }]]);
  });

  test("unsubscribe calls issueUnsubscribe only when the maintainer is subscribed", async () => {
    start();
    linear.once("FlightDeckFlagState", flagState(null, false));
    linear.once("FlightDeckFlagState", flagState(null, true));
    await tracker.unsubscribe(ref);
    await tracker.unsubscribe(ref);
    expect(writes()).toEqual([["FlightDeckUnsubscribe", { id: uuid(1), user: repo.maintainer }]]);
  });

  test("writeBrief writes the brief with +++ folds, then the old description, flattened, in a Report fold", async () => {
    start();
    linear.on("FlightDeckDescription", { data: { issue: { id: uuid(1), description: "The button is blue.\n\n>>> Logs\n\nx\n\n>>>" } } });
    await tracker.writeBrief(ref, "## Summary\n\nMake it red.\n\n>>> Notes\n\ny\n\n>>>", { runnerWroteBrief: false });
    expect(writes()).toEqual([
      ["FlightDeckUpdate", { id: uuid(1), input: { description: "## Summary\n\nMake it red.\n\n+++ Notes\n\ny\n\n+++\n\n+++ Report\n\nThe button is blue.\n\n#### Logs\n\nx\n\n+++" } }],
    ]);
  });

  test("writeBrief over a brief keeps only the old Report fold's text", async () => {
    start();
    linear.on("FlightDeckDescription", { data: { issue: { id: uuid(1), description: "A line I added.\n\n## Summary\n\nOld.\n\n+++ Report\n\nThe button is blue.\n\n+++" } } });
    await tracker.writeBrief(ref, "## Summary\n\nNew.", { runnerWroteBrief: true });
    expect(writes()[0]![1]).toEqual({ id: uuid(1), input: { description: "## Summary\n\nNew.\n\n+++ Report\n\nThe button is blue.\n\n+++" } });
  });

  test("markDuplicate makes the relation and moves to the duplicate role's status in one request", async () => {
    start();
    linear.on("FlightDeckIssueId", (variables) => ({ data: { issue: { id: variables.id === "SHA-1" ? uuid(1) : uuid(2) } } }));
    linear.on("FlightDeckDuplicate", { data: { relation: { success: true }, update: { success: true } } });
    await tracker.markDuplicate({ id: "SHA-1", repo }, { id: "SHA-2", repo });
    expect(writes()).toEqual([
      ["FlightDeckDuplicate", { relation: { issueId: uuid(1), relatedIssueId: uuid(2), type: "duplicate" }, id: uuid(1), input: { stateId: stateId("Duplicate") } }],
    ]);
  });

  test("markDuplicate refuses an issue as its own original, before any write", async () => {
    start();
    linear.on("FlightDeckIssueId", { data: { issue: { id: uuid(1) } } });
    await expect(tracker.markDuplicate({ id: "SHA-1", repo }, ref)).rejects.toBeInstanceOf(TrackerRefused);
    expect(writes()).toEqual([]);
  });

  test("file names the role's status and team, and sets nothing else", async () => {
    start();
    linear.on("FlightDeckFile", { data: { issueCreate: { success: true, issue: { id: uuid(5), identifier: "SHA-5", url: "https://linear.app/campdotdev/issue/SHA-5/x" } } } });
    const filed = await tracker.file({ repo, title: "Follow-up", description: "Text." }, "intake");
    expect(filed).toEqual({ id: uuid(5), repo, identifier: "SHA-5", url: "https://linear.app/campdotdev/issue/SHA-5/x" });
    expect(writes()).toEqual([["FlightDeckFile", { input: { teamId: TEAM_ID, stateId: stateId("Triage"), title: "Follow-up", description: "Text." } }]]);
  });

  test("post, writeBrief, and file strip ?signature= from every URL they write", async () => {
    start();
    const signed = "![x](https://uploads.linear.app/ws/abc/x.png?signature=eyJhbGciOi)";
    const plain = "![x](https://uploads.linear.app/ws/abc/x.png)";
    linear.on("FlightDeckFlagState", flagState(null, false));
    linear.on("FlightDeckDescription", { data: { issue: { id: uuid(1), description: "The button is blue." } } });
    linear.on("FlightDeckFile", { data: { issueCreate: { success: true, issue: { id: uuid(5), identifier: "SHA-5", url: "https://linear.app/campdotdev/issue/SHA-5/x" } } } });
    await tracker.post(ref, `See ${signed}`, { flag: false });
    await tracker.writeBrief(ref, `## Summary\n\n${signed}`, { runnerWroteBrief: false });
    await tracker.file({ repo, title: "Follow-up", description: signed }, "intake");
    expect(writes()).toEqual([
      ["FlightDeckComment", { input: { issueId: uuid(1), body: `See ${plain}` } }],
      ["FlightDeckUpdate", { id: uuid(1), input: { description: `## Summary\n\n${plain}\n\n+++ Report\n\nThe button is blue.\n\n+++` } }],
      ["FlightDeckFile", { input: { teamId: TEAM_ID, stateId: stateId("Triage"), title: "Follow-up", description: plain } }],
    ]);
  });

  test("relate makes a related relation", async () => {
    start();
    linear.on("FlightDeckRelate", { data: { issueRelationCreate: { success: true } } });
    await tracker.relate({ id: uuid(5), repo }, ref, "related");
    expect(writes()).toEqual([["FlightDeckRelate", { input: { issueId: uuid(5), relatedIssueId: uuid(1), type: "related" } }]]);
  });

  test("detach turns off the sync through the sync attachment", async () => {
    start();
    linear.on("FlightDeckDetach", { data: { issueExternalSyncDisable: { success: true } } });
    await tracker.detach({ ...ref, sync_attachment: "att-gh" });
    expect(writes()).toEqual([["FlightDeckDetach", { attachment: "att-gh" }]]);
  });

  test("upload asks fileUpload for a URL, puts the file there, and returns the asset URL without its signature", async () => {
    start();
    linear.on("FlightDeckUpload", {
      data: {
        fileUpload: {
          success: true,
          uploadFile: {
            uploadUrl: `${linear.url}/upload/abc?X-Goog-Signature=s1`,
            assetUrl: "https://uploads.linear.app/ws/abc/before.png?signature=eyJhbGciOi",
            headers: [{ key: "x-goog-content-length-range", value: "3,3" }],
          },
        },
      },
    });
    const url = await tracker.upload({ repo, name: "before.png", contentType: "image/png", data: new Uint8Array([1, 2, 3]) });
    expect(url).toBe("https://uploads.linear.app/ws/abc/before.png");
    expect(writes()).toEqual([["FlightDeckUpload", { contentType: "image/png", filename: "before.png", size: 3 }]]);
    expect(linear.puts).toHaveLength(1);
    expect(linear.puts[0]!.headers).toMatchObject({ "content-type": "image/png", "x-goog-content-length-range": "3,3" });
    expect([...linear.puts[0]!.body]).toEqual([1, 2, 3]);
  });
});
