// The Linear adapter's snapshot: one filtered query per repo per poll, paged under the cap, with the comments
// since the cursor and each sent issue's blockers (spec 1, "Tracker (Linear)").
import { afterEach, describe, expect, test } from "bun:test";
import { TrackerUnavailable, type LinearTracker } from "../../../src/tracker/index.ts";
import { RATELIMITED, type FakeLinear } from "./fake-linear.ts";
import { commentNode, issueNode, page, repo, state, uuid, world } from "./linear-world.ts";

let linear: FakeLinear;
let tracker: LinearTracker;
afterEach(() => linear.stop());

function start(): void {
  ({ linear, tracker } = world());
  linear.on("FlightDeckComments", { data: { comments: page([]) } });
}

describe("the issues", () => {
  test("come from one filtered query on the team's snapshot statuses, page after page", async () => {
    start();
    linear.once("FlightDeckSnapshot", { data: { issues: page([issueNode({ n: 1, status: "Planning", assignee: "user-maintainer", subscribers: ["user-maintainer", "user-sam"], priority: 2 })], "cursor-1") } });
    linear.once("FlightDeckSnapshot", { data: { issues: page([issueNode({ n: 2, status: "Triage", parent: uuid(9), children: 2 })]) } });
    const snapshot = await tracker.snapshot(repo, { since: null });

    const requests = linear.sent("FlightDeckSnapshot");
    expect(requests.map((request) => request.variables.after)).toEqual([null, "cursor-1"]);
    expect(requests[0]!.variables.filter).toEqual({
      team: { key: { eq: "SHA" } },
      state: { name: { in: ["Triage", "Ready to plan", "Planning", "Ready to build", "Building", "Ready to check", "Checking", "Landed", "Paused"] } },
    });
    expect(snapshot.issues).toEqual([
      {
        id: uuid(1),
        repo,
        identifier: "SHA-1",
        title: "Issue 1",
        url: "https://linear.app/campdotdev/issue/SHA-1/issue-1",
        role: "planning",
        status: "Planning",
        status_since: "2026-11-02T09:00:00.000Z",
        assignee: "user-maintainer",
        subscribers: ["user-maintainer", "user-sam"],
        parent: null,
        children: 0,
        priority: 2,
        created_at: "2026-11-01T09:00:00.000Z",
        blockers: [],
        unblocks: 0,
      },
      expect.objectContaining({ identifier: "SHA-2", role: "intake", parent: uuid(9), children: 2 }),
    ]);
  });

  test("status_since is the start of the open span in the issue's state history", async () => {
    start();
    const spans = [
      { startedAt: "2026-11-03T09:00:00.000Z", endedAt: "2026-11-04T09:00:00.000Z" },
      { startedAt: "2026-11-04T09:00:00.000Z", endedAt: null },
    ];
    linear.on("FlightDeckSnapshot", { data: { issues: page([issueNode({ n: 1, spans }), issueNode({ n: 2, spans: [] })]) } });
    const { issues } = await tracker.snapshot(repo);
    expect(issues.map((issue) => issue.status_since)).toEqual(["2026-11-04T09:00:00.000Z", "2026-11-01T09:00:00.000Z"]);
  });

  test("an archived issue, or one in a status no snapshot role names, is left out", async () => {
    start();
    linear.on("FlightDeckSnapshot", { data: { issues: page([issueNode({ n: 1, archivedAt: "2026-11-05T09:00:00.000Z" }), issueNode({ n: 2, status: "Done" }), issueNode({ n: 3 })]) } });
    expect((await tracker.snapshot(repo)).issues.map((issue) => issue.identifier)).toEqual(["SHA-3"]);
  });

  test("RATELIMITED is a snapshot Linear didn't take", async () => {
    start();
    linear.on("FlightDeckSnapshot", RATELIMITED);
    const error = (await tracker.snapshot(repo).catch((caught: unknown) => caught)) as TrackerUnavailable;
    expect(error).toBeInstanceOf(TrackerUnavailable);
    expect(error.reason).toBe("rate_limited");
  });
});

describe("the comments", () => {
  test("are those created at or after the cursor, on the snapshot's issues, oldest first, with their sync origin", async () => {
    ({ linear, tracker } = world());
    linear.on("FlightDeckSnapshot", { data: { issues: page([issueNode({ n: 1 })]) } });
    linear.once("FlightDeckComments", {
      data: {
        comments: page(
          [
            commentNode({ id: "c3", issue: 1, createdAt: "2026-11-10T09:03:00.000Z", body: "From GitHub.", user: null, externalUser: "ext-1" }),
            commentNode({ id: "c2", issue: 1, createdAt: "2026-11-10T09:02:00.000Z", parent: "c1" }),
          ],
          "cursor-c",
        ),
      },
    });
    linear.once("FlightDeckComments", {
      data: {
        comments: page([
          commentNode({ id: "c1", issue: 1, createdAt: "2026-11-10T09:01:00.000Z", syncedWith: true }),
          commentNode({ id: "c9", issue: 7, createdAt: "2026-11-10T09:04:00.000Z" }),
        ]),
      },
    });
    const { comments } = await tracker.snapshot(repo, { since: "2026-11-10T09:00:00.000Z" });

    const requests = linear.sent("FlightDeckComments");
    expect(requests.map((request) => request.variables.after)).toEqual([null, "cursor-c"]);
    expect(requests[0]!.variables.filter).toEqual({
      issue: { team: { key: { eq: "SHA" } }, state: { name: { in: expect.any(Array) } } },
      createdAt: { gte: "2026-11-10T09:00:00.000Z" },
    });
    expect(comments).toEqual([
      { id: "c1", issue: uuid(1), author: "user-maintainer", body: "A comment.", created_at: "2026-11-10T09:01:00.000Z", parent: null, synced: true },
      { id: "c2", issue: uuid(1), author: "user-maintainer", body: "A comment.", created_at: "2026-11-10T09:02:00.000Z", parent: "c1", synced: false },
      { id: "c3", issue: uuid(1), author: "ext-1", body: "From GitHub.", created_at: "2026-11-10T09:03:00.000Z", parent: null, synced: true },
    ]);
  });

  test("no cursor reads every comment", async () => {
    start();
    linear.on("FlightDeckSnapshot", { data: { issues: page([]) } });
    await tracker.snapshot(repo, { since: null });
    expect(linear.sent("FlightDeckComments")[0]!.variables.filter).not.toHaveProperty("createdAt");
  });
});

/** A sent issue, blocker, or blocked issue, as the blocker query reads it. */
function linked(n: number, status: string, duplicateOf: number | null = null) {
  return {
    id: uuid(n),
    identifier: `SHA-${n}`,
    title: `Issue ${n}`,
    url: `https://linear.app/campdotdev/issue/SHA-${n}`,
    state: state(status),
    relations: { nodes: duplicateOf === null ? [] : [{ type: "duplicate", relatedIssue: { id: uuid(duplicateOf), identifier: `SHA-${duplicateOf}` } }] },
  };
}

/** An issue the app can see but not read. */
function unreadable(n: number) {
  return { id: uuid(n), identifier: `PRIV-${n}`, title: null, url: null, state: null, relations: null };
}

function blocked(n: number, status: string, blockers: { n: number; status: string | null }[]) {
  return {
    type: "blocks",
    relatedIssue: {
      id: uuid(n),
      state: { type: state(status).type },
      inverseRelations: { nodes: blockers.map((each) => ({ type: "blocks", issue: { id: uuid(each.n), state: each.status === null ? null : { type: state(each.status).type } } })) },
    },
  };
}

describe("a sent issue's blockers and unblocks", () => {
  test("come with each blocker's original through duplicate chains, and unblocks counts what only it blocks", async () => {
    start();
    linear.on("FlightDeckSnapshot", { data: { issues: page([issueNode({ n: 1, status: "Ready to plan" }), issueNode({ n: 2, status: "Planning" })]) } });
    linear.on("FlightDeckBlockers", {
      data: {
        issues: {
          nodes: [
            {
              id: uuid(1),
              inverseRelations: {
                nodes: [
                  { type: "blocks", issue: linked(10, "Done") },
                  { type: "blocks", issue: linked(11, "Duplicate", 12) },
                  { type: "blocks", issue: linked(20, "Duplicate", 21) },
                  { type: "blocks", issue: unreadable(30) },
                  { type: "blocks", issue: linked(40, "Canceled", 41) },
                  { type: "related", issue: linked(50, "Planning") },
                ],
              },
              relations: {
                nodes: [
                  blocked(60, "Backlog", [{ n: 1, status: "Ready to plan" }]),
                  blocked(61, "Backlog", [{ n: 1, status: "Ready to plan" }, { n: 70, status: "Planning" }]),
                  blocked(62, "Backlog", [{ n: 1, status: "Ready to plan" }, { n: 71, status: "Done" }]),
                  blocked(63, "Done", [{ n: 1, status: "Ready to plan" }]),
                  blocked(64, "Backlog", [{ n: 1, status: "Ready to plan" }, { n: 72, status: null }]),
                  { type: "related", relatedIssue: { id: uuid(65), state: { type: "backlog" }, inverseRelations: { nodes: [] } } },
                ],
              },
            },
          ],
        },
      },
    });
    // 11 → 12 → 13 ends at 13; 20 → 21 → 20 loops; 40 → 41 stops at 41, which the app can't read.
    linear.once("FlightDeckDuplicates", { data: { issues: { nodes: [linked(12, "Duplicate", 13), linked(21, "Duplicate", 20)] } } });
    linear.once("FlightDeckDuplicates", { data: { issues: { nodes: [linked(13, "Backlog")] } } });
    const { issues } = await tracker.snapshot(repo);

    expect(linear.sent("FlightDeckBlockers").map((request) => request.variables.ids)).toEqual([[uuid(1)]]);
    expect(linear.sent("FlightDeckDuplicates").map((request) => request.variables.ids)).toEqual([
      [uuid(12), uuid(21), uuid(41)],
      [uuid(13)],
    ]);
    const sent = issues[0]!;
    const readable = (n: number, status: string) => ({ readable: true as const, identifier: `SHA-${n}`, title: `Issue ${n}`, url: `https://linear.app/campdotdev/issue/SHA-${n}`, status, status_type: state(status).type });
    expect(sent.blockers as unknown[]).toEqual([
      { ...readable(10, "Done"), original: null },
      { ...readable(11, "Duplicate"), original: readable(13, "Backlog") },
      { ...readable(20, "Duplicate"), original: null },
      { readable: false, identifier: "PRIV-30" },
      { ...readable(40, "Canceled"), original: { readable: false, identifier: "SHA-41" } },
    ]);
    expect(sent.unblocks).toBe(2);
    expect(issues[1]!.blockers).toEqual([]);
  });

  test("are read a few sent issues to a request, never one query per issue", async () => {
    start();
    const sent = Array.from({ length: 7 }, (_, i) => issueNode({ n: i + 1, status: "Ready to plan" }));
    linear.on("FlightDeckSnapshot", { data: { issues: page(sent) } });
    linear.on("FlightDeckBlockers", (variables) => ({
      data: { issues: { nodes: (variables.ids as string[]).map((id) => ({ id, inverseRelations: { nodes: [] }, relations: { nodes: [] } })) } },
    }));
    await tracker.snapshot(repo);
    expect(linear.sent("FlightDeckBlockers").map((request) => (request.variables.ids as string[]).length)).toEqual([5, 2]);
  });
});
