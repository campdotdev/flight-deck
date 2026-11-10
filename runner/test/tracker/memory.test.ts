import { beforeEach, describe, expect, test } from "bun:test";
import { InMemoryTracker, IssueNotFoundError, MintFailed, TrackerUnavailable, unsigned, type IssueRef, type TrackerRepo } from "../../src/tracker/index.ts";
import { STATUS_NAMES } from "../statuses.ts";

const repo: TrackerRepo = {
  name: "campdotdev/shaders",
  workspace: "campdotdev",
  team: "SHA",
  statuses: STATUS_NAMES,
  maintainer: "maintainer",
};

let now = new Date("2026-11-10T09:00:00Z");
let tracker: InMemoryTracker;

beforeEach(() => {
  now = new Date("2026-11-10T09:00:00Z");
  tracker = new InMemoryTracker({ clock: () => now, appUser: "app" });
  tracker.addUser({ id: "maintainer", name: "Hunter" });
  tracker.addUser({ id: "stranger", name: "Sam" });
  tracker.addTeam({ key: "SHA", name: "Shaders", statuses: Object.values(STATUS_NAMES).map((name) => ({ name, type: "started" })) });
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

  test("intake and backlog may name one status, which reads back as intake", async () => {
    const one = issue("x", "Backlog");
    const shared = { ...repo, statuses: { ...STATUS_NAMES, intake: "Backlog" } };
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
});

describe("clearFlag", () => {
  test("clears the assignee, then unsubscribes the maintainer, because Linear keeps an assignee subscribed", async () => {
    const one = issue();
    await tracker.post(one, "🟡 Needs your answer: which one?", { flag: true });
    tracker.writes.length = 0;
    await tracker.clearFlag(one);
    expect(tracker.writes).toEqual([
      { kind: "unassign", issue: one.identifier },
      { kind: "unsubscribe", issue: one.identifier, user: "maintainer" },
    ]);
    const read = await tracker.issue(one);
    expect(read.assignee).toBeNull();
    expect(read.subscribers).not.toContain("maintainer");
  });

  test("on an issue with no assignee, it only unsubscribes, and only a subscribed maintainer", async () => {
    const one = issue();
    await tracker.clearFlag(one);
    await tracker.clearFlag(one);
    expect(tracker.writes).toEqual([{ kind: "unsubscribe", issue: one.identifier, user: "maintainer" }]);
  });

  test("clears an assignee who isn't the maintainer", async () => {
    const { id, identifier } = tracker.addIssue({ team: "SHA", title: "x", status: "Planning", creator: "maintainer", assignee: "stranger" });
    await tracker.clearFlag({ id, repo });
    expect(tracker.writes[0]).toEqual({ kind: "unassign", issue: identifier });
    expect((await tracker.issue({ id, repo })).assignee).toBeNull();
  });
});

describe("flag", () => {
  test("assigns the maintainer, which subscribes them, and posts nothing", async () => {
    const { id, identifier } = tracker.addIssue({ team: "SHA", title: "Trouble", status: "Triage", creator: "app" });
    await tracker.flag({ id, repo });
    expect(tracker.writes).toEqual([{ kind: "assign", issue: identifier, user: "maintainer" }]);
    const read = await tracker.issue({ id, repo });
    expect(read.assignee).toBe("maintainer");
    expect(read.subscribers).toContain("maintainer");
    expect(read.comments).toEqual([]);
  });
});

describe("checkTeam", () => {
  test("passes when the team has every status the role map names", async () => {
    expect(await tracker.checkTeam(repo)).toEqual({ ok: true });
  });

  test("names each missing status's role, in role order", async () => {
    tracker.renameStatus("SHA", "Paused", "On hold");
    tracker.renameStatus("SHA", "Triage", "Inbox");
    expect(await tracker.checkTeam(repo)).toEqual({ ok: false, reason: "missing", roles: ["intake", "paused"] });
  });

  test("a team that doesn't exist or that the app can't read is unreadable", async () => {
    expect(await tracker.checkTeam({ ...repo, team: "NOPE" })).toEqual({ ok: false, reason: "unreadable" });
    tracker.setReadable("SHA", false);
    expect(await tracker.checkTeam(repo)).toEqual({ ok: false, reason: "unreadable" });
  });
});

describe("snapshot comments", () => {
  test("holds every comment created at or after `since`, replies included, with the issue each sits on", async () => {
    const one = issue("x", "Paused");
    const early = tracker.addComment(one.id, { author: "maintainer", body: "early" });
    now = new Date("2026-11-10T09:05:00Z");
    const top = tracker.addComment(one.id, { author: "maintainer", body: "top" });
    const reply = tracker.addComment(one.id, { author: "stranger", body: "reply", parent: top.id });
    expect((await tracker.snapshot(repo)).comments.map((comment) => comment.id)).toEqual([early.id, top.id, reply.id]);
    const since = await tracker.snapshot(repo, { since: "2026-11-10T09:05:00.000Z" });
    expect(since.comments).toEqual([
      { ...top, issue: one.id },
      { ...reply, issue: one.id },
    ]);
  });

  test("returns a comment's body as it stands, so an edit shows", async () => {
    const one = issue("x", "Paused");
    const comment = tracker.addComment(one.id, { author: "maintainer", body: "Which red?" });
    tracker.editComment(comment.id, "retry");
    expect((await tracker.snapshot(repo)).comments[0]?.body).toBe("retry");
  });

  test("leaves out comments on issues the snapshot doesn't hold", async () => {
    const one = issue("x", "Backlog");
    tracker.addComment(one.id, { author: "maintainer", body: "x" });
    expect((await tracker.snapshot(repo)).comments).toEqual([]);
  });
});

describe("post's result", () => {
  test("is the comment's ID and creation time", async () => {
    const one = issue();
    const posted = await tracker.post(one, "text", { flag: true });
    const stored = (await tracker.issue(one)).comments.at(-1)!;
    expect(posted).toEqual({ id: stored.id, created_at: "2026-11-10T09:00:00.000Z" });
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

  test("it turns the brief's >>> fold lines into +++", async () => {
    const one = issue("x");
    await tracker.writeBrief(one, "## Summary\n\n>>> Proof\n\nlog\n\n>>>", { runnerWroteBrief: false });
    expect((await tracker.issue(one)).description).toBe("## Summary\n\n+++ Proof\n\nlog\n\n+++\n\n+++ Report\n\nx\n\n+++");
  });
});

describe("issue", () => {
  test("returns the team, the status type, and a status with no role as a null role", async () => {
    tracker.addTeam({ key: "OTH", name: "Other", statuses: [{ name: "Todo", type: "unstarted" }] });
    const other = tracker.addIssue({ team: "OTH", title: "Elsewhere", status: "Todo", creator: "maintainer" });
    const read = await tracker.issue({ id: other.identifier, repo });
    expect([read.team, read.status, read.status_type, read.role]).toEqual(["OTH", "Todo", "unstarted", null]);
  });

  test("an unknown issue throws IssueNotFoundError", async () => {
    await expect(tracker.issue({ id: "SHA-99", repo })).rejects.toBeInstanceOf(IssueNotFoundError);
  });

  test("a synced issue returns its sync attachment, and each comment says whether the sync brought it", async () => {
    const { id } = tracker.addIssue({ team: "SHA", title: "From GitHub", status: "Planning", creator: "maintainer", synced: true });
    tracker.addComment(id, { author: "github-user", body: "Me too.", synced: true });
    const read = await tracker.issue({ id, repo });
    expect(read.synced).toBe(true);
    expect(read.sync_attachment).toMatch(/^attachment-/);
    expect(read.comments.map((comment) => comment.synced)).toEqual([true]);
    const plain = await tracker.issue(issue());
    expect([plain.synced, plain.sync_attachment]).toEqual([false, null]);
  });
});

describe("detach", () => {
  test("turns off the sync and keeps the attachment", async () => {
    const stored = tracker.addIssue({ team: "SHA", title: "From GitHub", status: "Planning", creator: "maintainer", synced: true });
    const read = await tracker.issue({ id: stored.id, repo });
    await tracker.detach({ id: stored.id, repo, sync_attachment: read.sync_attachment! });
    expect((await tracker.issue({ id: stored.id, repo })).synced).toBe(false);
    expect(tracker.stored(stored.id).sync_attachment).toBe(read.sync_attachment);
    expect(tracker.writes).toEqual([{ kind: "detach", issue: stored.identifier, attachment: read.sync_attachment! }]);
  });

  test("refuses an issue that isn't synced", async () => {
    const one = issue();
    await expect(tracker.detach({ ...one, sync_attachment: "attachment-1" })).rejects.toThrow("isn't synced");
  });
});

describe("upload", () => {
  test("returns the asset URL without its ?signature= query", async () => {
    const url = await tracker.upload({ repo, name: "before.png", contentType: "image/png", data: new Uint8Array([1, 2, 3]) });
    expect(url).toMatch(/^https:\/\/uploads\.linear\.app\/[^?]+\/before\.png$/);
    expect(tracker.writes).toEqual([{ kind: "upload", name: "before.png", url }]);
    expect(tracker.uploads.get(url)).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("unsigned strips ?signature= wherever it is in the query", () => {
    expect(unsigned("https://uploads.linear.app/a/b.png?signature=x")).toBe("https://uploads.linear.app/a/b.png");
    expect(unsigned("https://uploads.linear.app/a/b.png?w=2&signature=x&h=3")).toBe("https://uploads.linear.app/a/b.png?w=2&h=3");
    expect(unsigned("![x](https://uploads.linear.app/a/b.png?signature=x)")).toBe("![x](https://uploads.linear.app/a/b.png)");
  });
});

describe("signed upload URLs", () => {
  const SIGNED = "![before](https://uploads.linear.app/ws/abc/before.png?signature=eyJhbGciOi)";
  const UNSIGNED = "![before](https://uploads.linear.app/ws/abc/before.png)";

  test("post strips ?signature= from the comment", async () => {
    const one = issue();
    await tracker.post(one, `It looks like this.\n\n${SIGNED}`, { flag: false });
    expect(tracker.writes.at(-1)).toEqual({ kind: "comment", issue: one.identifier, body: `It looks like this.\n\n${UNSIGNED}` });
  });

  test("writeBrief strips ?signature= from the description", async () => {
    const one = issue(`The button is blue.\n\n${SIGNED}`);
    await tracker.writeBrief(one, `## Summary\n\n${SIGNED}`, { runnerWroteBrief: false });
    expect(tracker.stored(one.id).description).toBe(`## Summary\n\n${UNSIGNED}\n\n+++ Report\n\nThe button is blue.\n\n${UNSIGNED}\n\n+++`);
  });

  test("file strips ?signature= from the title and the description", async () => {
    const filed = await tracker.file({ repo, title: "See https://uploads.linear.app/ws/abc/a.png?signature=x", description: SIGNED }, "intake");
    const read = await tracker.issue({ id: filed.id, repo });
    expect([read.title, read.description]).toEqual(["See https://uploads.linear.app/ws/abc/a.png", UNSIGNED]);
  });
});

describe("file", () => {
  test("files the draft in the role's status as the actor, with no label, priority, assignee, or delegate", async () => {
    const filed = await tracker.file({ repo, title: "Flaky test", description: "It fails one run in ten." }, "intake");
    const read = await tracker.issue({ id: filed.id, repo });
    expect([read.identifier, read.title, read.description, read.status, read.role]).toEqual([filed.identifier, "Flaky test", "It fails one run in ten.", "Triage", "intake"]);
    expect([read.creator, read.assignee, read.priority, read.subscribers]).toEqual(["app", null, 0, ["app"]]);
    expect(filed.url).toBe(`https://linear.app/campdotdev/issue/${filed.identifier}`);
    expect(tracker.writes).toEqual([{ kind: "file", issue: filed.identifier, title: "Flaky test", description: "It fails one run in ten.", status: "Triage" }]);
  });
});

describe("relate", () => {
  test("relates two issues", async () => {
    const one = issue();
    const two = issue();
    await tracker.relate(one, two, "related");
    expect(tracker.stored(one.id).relations).toEqual([{ kind: "related", issue: two.id }]);
    expect(tracker.writes).toEqual([{ kind: "relate", issue: one.identifier, other: two.identifier, relation: "related" }]);
  });
});

describe("Reader tokens", () => {
  test("a session's token is minted and revoked", async () => {
    const token = await tracker.sessionToken({ id: "abc123", repo });
    await tracker.revoke({ id: "abc123", repo });
    expect(tracker.tokens).toEqual([{ session: "abc123", token, revoked: true }]);
    expect(tracker.mints).toEqual([{ app: "reader", workspace: "campdotdev", session: "abc123", ok: true }]);
  });

  test("asking again returns the same token, and a replacement only once Linear rejects it", async () => {
    const first = await tracker.sessionToken({ id: "abc123", repo });
    expect(await tracker.sessionToken({ id: "abc123", repo })).toBe(first);
    tracker.rejectToken(first);
    const second = await tracker.sessionToken({ id: "abc123", repo });
    expect(second).not.toBe(first);
    expect(await tracker.sessionToken({ id: "abc123", repo })).toBe(second);
    expect(tracker.tokens).toEqual([
      { session: "abc123", token: first, revoked: true },
      { session: "abc123", token: second, revoked: false },
    ]);
  });

  test("a failed mint throws MintFailed, a kind of TrackerUnavailable, and mints nothing", async () => {
    tracker.failMints("reader", "campdotdev");
    const error = await tracker.sessionToken({ id: "abc123", repo }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MintFailed);
    expect(error).toBeInstanceOf(TrackerUnavailable);
    expect([(error as MintFailed).app, (error as MintFailed).workspace, (error as MintFailed).reason]).toEqual(["reader", "campdotdev", "mint"]);
    expect(tracker.tokens).toEqual([]);
    expect(tracker.mints).toEqual([{ app: "reader", workspace: "campdotdev", session: "abc123", ok: false }]);

    tracker.failMints("reader", "campdotdev", false);
    await tracker.tryReaderMint("campdotdev");
    expect(tracker.mints.at(-1)).toEqual({ app: "reader", workspace: "campdotdev", session: null, ok: true });
    expect(tracker.tokens).toEqual([]);
  });
});

describe("the runner's token", () => {
  test("is minted once per workspace, and again after a revoke", async () => {
    await tracker.runnerToken("campdotdev");
    await tracker.runnerToken("campdotdev");
    await tracker.runnerToken("other");
    await tracker.revokeRunnerToken("campdotdev");
    await tracker.runnerToken("campdotdev");
    expect(tracker.mints).toEqual([
      { app: "flight_deck", workspace: "campdotdev", session: null, ok: true },
      { app: "flight_deck", workspace: "other", session: null, ok: true },
      { app: "flight_deck", workspace: "campdotdev", session: null, ok: true },
    ]);
    expect(tracker.runnerTokens.map(({ workspace, revoked }) => ({ workspace, revoked }))).toEqual([
      { workspace: "campdotdev", revoked: true },
      { workspace: "other", revoked: false },
      { workspace: "campdotdev", revoked: false },
    ]);
    expect(tracker.runnerRevokes).toEqual(["campdotdev"]);
  });

  test("is minted again once Linear rejects it, as after a 401", async () => {
    await tracker.runnerToken("campdotdev");
    tracker.rejectToken(tracker.runnerTokens[0]!.token);
    await tracker.runnerToken("campdotdev");
    await tracker.runnerToken("campdotdev");
    expect(tracker.mints.map((mint) => mint.app)).toEqual(["flight_deck", "flight_deck"]);
  });

  test("a failed mint throws MintFailed for that workspace only", async () => {
    tracker.failMints("flight_deck", "campdotdev");
    const error = await tracker.runnerToken("campdotdev").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MintFailed);
    expect((error as MintFailed).app).toBe("flight_deck");
    await tracker.runnerToken("other");
    // The Reader app is a separate app, so its mints still work.
    await tracker.sessionToken({ id: "abc123", repo });
    expect(tracker.runnerTokens.map(({ workspace }) => workspace)).toEqual(["other"]);
  });
});

describe("refuse", () => {
  test("makes the next calls of a write fail as Linear being unavailable, records nothing for them, then lets one land", async () => {
    const issue = tracker.addIssue({ team: "SHA", title: "x", status: "Planning", creator: "maintainer" });
    tracker.refuse("post", { times: 2 });
    for (let i = 0; i < 2; i++) {
      const error = await tracker.post({ id: issue.id, repo }, "hi", { flag: true }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TrackerUnavailable);
      expect((error as TrackerUnavailable).reason).toBe("server");
    }
    expect(tracker.writes).toEqual([]);
    await tracker.post({ id: issue.id, repo }, "hi", { flag: true });
    expect(tracker.writes.map((write) => write.kind)).toEqual(["assign", "comment"]);
  });
});

describe("snapshot blockers and unblocks", () => {
  beforeEach(() => {
    tracker.addTeam({
      key: "OPS",
      name: "Ops",
      statuses: [
        { name: "Todo", type: "unstarted" },
        { name: "Done", type: "completed" },
        { name: "Canceled", type: "canceled" },
        { name: "Duplicate", type: "duplicate" },
      ],
    });
    tracker.addTeam({ key: "SEC", name: "Security", statuses: [{ name: "Todo", type: "unstarted" }], readable: false });
  });

  function ops(status: string, title = `Ops ${status}`) {
    return tracker.addIssue({ team: "OPS", title, status, creator: "maintainer" });
  }

  async function read(id: string) {
    const found = (await tracker.snapshot(repo)).issues.find((each) => each.id === id);
    if (found === undefined) throw new Error(`no ${id} in the snapshot`);
    return found;
  }

  test("lists each blocker of an issue in Ready to plan, on any team, with its title, URL, status, and status type", async () => {
    const blocked = issue("x", "Ready to plan");
    const todo = ops("Todo", "Rotate keys");
    const local = tracker.addIssue({ team: "SHA", title: "Landed work", status: "Landed", creator: "maintainer" });
    tracker.addBlocker(blocked.id, todo.id);
    tracker.addBlocker(blocked.id, local.id);
    expect((await read(blocked.id)).blockers).toEqual([
      { readable: true, identifier: todo.identifier, title: "Rotate keys", url: `https://linear.app/campdotdev/issue/${todo.identifier}`, status: "Todo", status_type: "unstarted", original: null },
      { readable: true, identifier: local.identifier, title: "Landed work", url: `https://linear.app/campdotdev/issue/${local.identifier}`, status: "Landed", status_type: "started", original: null },
    ]);
  });

  test("gives a blocker the app can't read only its identifier", async () => {
    const blocked = issue("x", "Ready to plan");
    const secret = tracker.addIssue({ team: "SEC", title: "Private", status: "Todo", creator: "maintainer" });
    tracker.addBlocker(blocked.id, secret.id);
    expect((await read(blocked.id)).blockers).toEqual([{ readable: false, identifier: secret.identifier }]);
  });

  test("follows a duplicate blocker through further duplicates to its original, and stops at a loop", async () => {
    const blocked = issue("x", "Ready to plan");
    const first = ops("Canceled", "First");
    const middle = ops("Duplicate", "Middle");
    const original = ops("Done", "Original");
    tracker.setDuplicate(first.id, middle.id);
    tracker.setDuplicate(middle.id, original.id);
    const looped = ops("Duplicate", "Looped");
    const other = ops("Duplicate", "Other");
    tracker.setDuplicate(looped.id, other.id);
    tracker.setDuplicate(other.id, looped.id);
    const orphan = ops("Duplicate", "Orphan");
    for (const each of [first, looped, orphan]) tracker.addBlocker(blocked.id, each.id);
    const [viaChain, viaLoop, viaNothing] = (await read(blocked.id)).blockers;
    expect(viaChain).toMatchObject({ identifier: first.identifier, status_type: "canceled", original: { readable: true, identifier: original.identifier, title: "Original", status: "Done", status_type: "completed" } });
    expect(viaLoop).toMatchObject({ identifier: looped.identifier, original: null });
    expect(viaNothing).toMatchObject({ identifier: orphan.identifier, status_type: "duplicate", original: null });
  });

  test("leaves blockers and unblocks empty outside Ready to plan", async () => {
    const planning = issue("x", "Planning");
    const blocker = ops("Todo");
    tracker.addBlocker(planning.id, blocker.id);
    const blocks = ops("Todo");
    tracker.addBlocker(blocks.id, planning.id);
    expect(await read(planning.id)).toMatchObject({ blockers: [], unblocks: 0 });
  });

  test("counts the open issues an issue blocks that have no other open blocker", async () => {
    const one = issue("x", "Ready to plan");
    const alone = ops("Todo");
    const doneOther = ops("Todo");
    const openOther = ops("Todo");
    const closed = ops("Done");
    tracker.addBlocker(alone.id, one.id);
    tracker.addBlocker(doneOther.id, one.id);
    tracker.addBlocker(doneOther.id, ops("Done").id);
    tracker.addBlocker(openOther.id, one.id);
    tracker.addBlocker(openOther.id, ops("Todo").id);
    tracker.addBlocker(closed.id, one.id);
    expect((await read(one.id)).unblocks).toBe(2);
  });
});
