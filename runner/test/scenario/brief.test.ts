// A sent issue gets a brief: the tracer bullet through the runner, at the one seam.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { outbox, World } from "./world.ts";

const REPORT = "The Save button is blue on the settings page.\n\nIt should be red, like every other Save button.";

const BRIEF = `## Summary

The settings page's Save button turns red.

## Current behavior

The Save button on the settings page is blue.

## Desired behavior

It is red, like every other Save button.

## Key interfaces

None.

## Acceptance criteria

- The settings page's Save button is red. Proof: unit.

## Out of scope

None.

## Context

- Slots: reproduce: reproduced with \`pnpm test\`

### Design

- design not checked`;

const SUMMARY = "Brief ready: the settings Save button turns red\n\nThe button takes its color from a local style. The brief swaps it for the shared one.";

let world: World;

beforeEach(async () => {
  world = await World.create();
});

afterEach(async () => {
  await world.cleanup();
});

describe("a sent issue gets a brief", () => {
  test("the take, the brief above the report fold, an unsubscribe before the unflagged comment, and the move", async () => {
    const issue = world.issue({ title: "Save button is blue", description: REPORT });
    world.send(issue);
    world.harness.script(issue.identifier, { outbox: outbox.brief({ summary: SUMMARY, brief: BRIEF }), exit: { kind: "exited", code: 0 } });

    // The poll unsubscribes the maintainer from the sent issue before it takes it.
    await world.tick();
    expect(world.tracker.writes).toEqual([
      { kind: "unsubscribe", issue: issue.identifier, user: world.maintainer.id },
      { kind: "move", issue: issue.identifier, status: "Planning" },
    ]);
    expect(world.harness.started.map((start) => start.session.issue)).toEqual([issue.identifier]);
    const session = world.harness.started[0]!.session.id;

    // A comment while plan runs subscribes the maintainer again, so the handoff unsubscribes them before its comment.
    world.reply(issue, "Thanks.");
    await world.tick();
    const description = `${BRIEF}\n\n+++ Report\n\n${REPORT}\n\n+++`;
    const comment = [
      "🟢 Moving to build: Brief ready: the settings Save button turns red",
      "",
      "The button takes its color from a local style. The brief swaps it for the shared one.",
      "",
      "+++ Details",
      "",
      BRIEF,
      "",
      `Flight Deck ${world.version} · plan · session ${session}`,
      "",
      "+++",
    ].join("\n");
    expect(world.tracker.writes.slice(2)).toEqual([
      { kind: "description", issue: issue.identifier, description },
      { kind: "unsubscribe", issue: issue.identifier, user: world.maintainer.id },
      { kind: "comment", issue: issue.identifier, body: comment },
      { kind: "move", issue: issue.identifier, status: "Ready to build" },
    ]);
    expect([...comment.split("\n")[0]!].length).toBeLessThan(80);
    expect(world.tracker.stored(issue.id).assignee).toBeNull();
  });

  test("the session's Reader token is minted at the start and revoked at the exit", async () => {
    const issue = world.issue({ title: "Save button is blue", description: REPORT });
    world.send(issue);
    world.harness.script(issue.identifier, { outbox: outbox.brief({ summary: SUMMARY, brief: BRIEF }), exit: { kind: "exited", code: 0 } });

    await world.tick();
    const session = world.harness.started[0]!.session.id;
    expect(world.tracker.tokens.map(({ session, revoked }) => ({ session, revoked }))).toEqual([{ session, revoked: false }]);
    await world.tick();
    expect(world.tracker.tokens.map(({ session, revoked }) => ({ session, revoked }))).toEqual([{ session, revoked: true }]);
  });

  test("a re-plan keeps only the report in the fold, and the inbox holds the previous brief", async () => {
    const issue = world.issue({ title: "Save button is blue", description: REPORT });
    world.send(issue);
    world.harness.script(issue.identifier, { outbox: outbox.brief({ summary: SUMMARY, brief: BRIEF }), exit: { kind: "exited", code: 0 } });
    await world.tick();
    await world.tick();
    expect(world.harness.started[0]!.inbox).toEqual({ "synced-comments.json": "[]" });

    const second = BRIEF.replace("turns red", "turns red on hover too");
    world.send(issue);
    world.harness.script(issue.identifier, { outbox: outbox.brief({ summary: SUMMARY, brief: second }), exit: { kind: "exited", code: 0 } });
    await world.tick();
    expect(world.harness.started[1]!.inbox).toEqual({ "previous-brief.md": BRIEF, "synced-comments.json": "[]" });
    await world.tick();
    expect(world.tracker.stored(issue.id).description).toBe(`${second}\n\n+++ Report\n\n${REPORT}\n\n+++`);
  });
});

describe("issues the maintainer hasn't sent", () => {
  test("are never touched", async () => {
    world.issue({ title: "In triage", status: "Triage" });
    world.issue({ title: "In the backlog", status: "Backlog" });
    world.issue({ title: "Already done", status: "Done" });
    world.issue({ title: "In review", status: "In Review" });
    await world.tick();
    await world.tick();
    expect(world.tracker.writes).toEqual([]);
    expect(world.harness.started).toEqual([]);
  });
});

describe("session.json", () => {
  test("holds every field spec 1 lists for a plan session", async () => {
    const issue = world.issue({ title: "Save button is blue", description: REPORT });
    const synced = world.tracker.addComment(issue.id, { author: "github-user", body: "Me too.", synced: true });
    world.tracker.addComment(issue.id, { author: world.maintainer.id, body: "Please plan this." });
    world.send(issue);
    world.harness.script(issue.identifier, {});
    await world.tick();

    const start = world.harness.started[0]!;
    const id = start.session.id;
    expect(id).toMatch(/^[0-9a-z]{6}$/);
    const folder = `${world.folders.sessionRoot}/sessions/${id}`;
    expect(start.sessionJson).toEqual({
      version: world.version,
      session: id,
      stage: "plan",
      mode: "issue",
      repo: "campdotdev/shaders",
      issue: issue.identifier,
      branch: "main",
      base: "main",
      commit: world.commit,
      worktree: `${world.folders.sessionRoot}/worktrees/${id}`,
      deadline: new Date(world.now.getTime() + 30 * 60_000).toISOString(),
      port: null,
      app_url: null,
      inbox: `${folder}/inbox`,
      outbox: `${folder}/outbox`,
      skills: `${world.versionFolder}/skills`,
      slots: { reproduce: [`${world.versionFolder}/skills/reproducing-bugs/SKILL.md`], design: [] },
      maintainer: { id: world.maintainer.id, name: world.maintainer.name },
      app_user: world.appUser,
      team: "SHA",
      plugin: `${world.versionFolder}/plugin`,
      attempt: 1,
      agents_md: null,
    });
    expect(start.session.sessionJson).toBe(`${folder}/session.json`);
    expect(start.inbox).toEqual({ "synced-comments.json": JSON.stringify([synced.id]) });
    expect(start.worktreeHead).toBe(world.commit);
  });
});

describe("status.json", () => {
  test("shows the running session while it runs, and the list is empty after its exit", async () => {
    const issue = world.issue({ title: "Save button is blue", description: REPORT });
    world.send(issue);
    world.harness.script(issue.identifier, {});
    await world.tick();
    const startedAt = world.now.toISOString();
    const id = world.harness.started[0]!.session.id;

    let status = await world.status();
    expect(status.sessions).toEqual([
      {
        id,
        repo: "campdotdev/shaders",
        issue: issue.identifier,
        title: "Save button is blue",
        stage: "plan",
        state: "running",
        started_at: startedAt,
        deadline: new Date(world.now.getTime() + 30 * 60_000).toISOString(),
      },
    ]);
    await world.tick();
    expect((await world.status()).sessions).toHaveLength(1);

    world.harness.finish(id, { kind: "exited", code: 0 });
    await world.tick();
    status = await world.status();
    expect(status.sessions).toEqual([]);
    expect(status.polled_at).toBe(world.now.toISOString());
    expect(status.heartbeat_at).toBe(world.now.toISOString());
  });

  test("holds the overview's top-level keys", async () => {
    await world.tick();
    const status = await world.status();
    expect(Object.keys(status)).toEqual([
      "version",
      "heartbeat_at",
      "polled_at",
      "runner",
      "sessions",
      "jobs",
      "usage",
      "flags",
      "trouble",
      "stale_takes",
      "repos",
    ]);
    expect(status.version).toBe(world.version);
    expect(status.runner).toEqual({ state: "working", holds: [] });
    expect(status.usage).toEqual({ auth: "subscription", five_hour: null, weekly: null });
    expect(status.repos).toEqual([
      { name: "campdotdev/shaders", record: "ok", cache: "missing", waiting_for_specs: [], waiting_for_blockers: [], waiting_for_port: null },
    ]);
  });
});

describe("a handoff the Outbox refuses", () => {
  const good = () => outbox.brief({ summary: SUMMARY, brief: BRIEF });
  test.each([
    ["another version", () => ({ ...good(), "outcome.json": JSON.stringify({ version: "0.0.9", stage: "plan", move: "ready_to_build" }) })],
    ["another stage", () => ({ ...good(), "outcome.json": JSON.stringify({ version: "0.1.0", stage: "build", move: "ready_to_build" }) })],
    ["a move Lifecycle doesn't allow", () => ({ ...good(), "outcome.json": JSON.stringify({ version: "0.1.0", stage: "plan", move: "building" }) })],
    ["no brief.md", () => ({ "outcome.json": good()["outcome.json"]!, "summary.md": SUMMARY })],
    ["a second handoff file", () => ({ ...good(), "pause.md": "Which red?" })],
    ["a file outside the envelope", () => ({ ...good(), "notes.txt": "scratch" })],
    ["a key outcome.json doesn't have", () => ({ ...good(), "outcome.json": JSON.stringify({ version: "0.1.0", stage: "plan", move: "ready_to_build", of: "SHA-9" }) })],
    ["a break not marked accepted", () => ({ ...good(), "brief.md": BRIEF.replace("## Key interfaces\n\nNone.", "## Key interfaces\n\n- `Button`: break, drops the color prop") })],
    ["a Report fold in the brief", () => ({ ...good(), "brief.md": `${BRIEF}\n\n>>> Report\n\nold\n\n>>>` })],
  ])("with %s writes nothing to the issue", async (_, files) => {
    const issue = world.issue({ title: "Save button is blue", description: REPORT });
    world.send(issue);
    world.harness.script(issue.identifier, { outbox: files(), exit: { kind: "exited", code: 0 } });
    await world.tick();
    await world.tick();
    expect(world.tracker.writes).toEqual([
      { kind: "unsubscribe", issue: issue.identifier, user: world.maintainer.id },
      { kind: "move", issue: issue.identifier, status: "Planning" },
    ]);
  });

  test("an accepted break passes", async () => {
    const issue = world.issue({ title: "Save button is blue", description: REPORT });
    world.send(issue);
    const brief = BRIEF.replace("## Key interfaces\n\nNone.", "## Key interfaces\n\n- `Button`: break (accepted), drops the color prop\n- `theme.save`: added, the shared color");
    world.harness.script(issue.identifier, { outbox: outbox.brief({ summary: SUMMARY, brief }), exit: { kind: "exited", code: 0 } });
    await world.tick();
    await world.tick();
    expect(world.tracker.writes.at(-1)).toEqual({ kind: "move", issue: issue.identifier, status: "Ready to build" });
  });
});

describe("the status line", () => {
  test.each([
    ["missing", null],
    ["too long for the status line", `Brief ready: ${"a very long gist ".repeat(5)}\n\nShort.`],
    ["over 600 characters after its first line", `Brief ready\n\n${"x".repeat(601)}`],
  ])("comes from the move alone when the summary is %s", async (_, summary) => {
    const issue = world.issue({ title: "Save button is blue", description: REPORT });
    world.send(issue);
    const files = outbox.brief({ summary: summary ?? "", brief: BRIEF });
    if (summary === null) delete files["summary.md"];
    world.harness.script(issue.identifier, { outbox: files, exit: { kind: "exited", code: 0 } });
    await world.tick();
    await world.tick();
    const comment = world.tracker.writes.find((write) => write.kind === "comment");
    const session = world.harness.started[0]!.session.id;
    expect(comment).toEqual({
      kind: "comment",
      issue: issue.identifier,
      body: `🟢 Moving to build\n\n+++ Details\n\n${BRIEF}\n\nFlight Deck ${world.version} · plan · session ${session}\n\n+++`,
    });
  });
});
