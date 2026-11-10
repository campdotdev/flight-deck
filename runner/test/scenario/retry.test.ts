// A failed plan session gets one fresh retry, and a second failure pauses the issue with the runner's own
// comment (spec 1's "Exits" and "The runner's own comments", ADRs 0002 and 0019).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionScript } from "../../src/harness/index.ts";
import type { StoredIssue } from "../../src/tracker/index.ts";
import { outbox, World } from "./world.ts";

let world: World;

beforeEach(async () => {
  world = await World.create();
});

afterEach(async () => {
  await world.cleanup();
});

/** The writes after the issue's last move to Planning. */
function afterTake(issue: StoredIssue) {
  const writes = world.tracker.writes;
  const take = writes.findLastIndex((write) => write.kind === "move" && write.issue === issue.identifier && write.status === "Planning");
  return writes.slice(take + 1);
}

describe("a failed session", () => {
  test("restarts once in place with attempt 2, at the default branch's tip, with no take", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    world.harness.script(issue.identifier, { exit: { kind: "timed_out" } });
    world.harness.script(issue.identifier, {});
    await world.tick();
    const first = world.harness.started[0]!;
    expect(first.sessionJson.attempt).toBe(1);

    const tip = await world.push({ "src/button.ts": "export const color = 'red';\n" });
    await world.tick();
    expect(world.harness.started).toHaveLength(2);
    const second = world.harness.started[1]!;
    expect(second.session.id).not.toBe(first.session.id);
    expect(second.sessionJson.attempt).toBe(2);
    expect(second.sessionJson.commit).toBe(tip);
    expect(second.worktreeHead).toBe(tip);
    // A fresh session never reads the failed one's transcript.
    expect(second.inbox).toEqual({ "synced-comments.json": "[]" });
    expect(afterTake(issue)).toEqual([]);
    expect(world.tracker.stored(issue.id).status).toBe("Planning");
    expect((await world.status()).sessions.map(({ id, state }) => ({ id, state }))).toEqual([{ id: second.session.id, state: "running" }]);
  });
});

/** Sends the issue and scripts two sessions, then ticks until the second one's exit is handled. */
async function failTwice(issue: StoredIssue, first: SessionScript, second: SessionScript = first): Promise<void> {
  world.send(issue);
  world.harness.script(issue.identifier, first);
  world.harness.script(issue.identifier, second);
  await world.tick();
  await world.tick();
  await world.tick();
  expect(world.harness.started).toHaveLength(2);
}

const RETRY_LINES = [
  "Reply with one word:",
  "",
  "- **retry**: plan runs again, with a fresh retry if it fails. Moves the issue to Ready to plan.",
  "",
  "Any other reply leaves the issue paused until you move it.",
];

/** The second session's facts, as the fold lists them. */
function facts(exit: string): string[] {
  const second = world.harness.started[1]!.session;
  return [`- Exit: ${exit}`, `- Session: \`${second.id}\``, "- Attempt: 2", `- Transcript: \`${second.transcript}\``];
}

function comment(sentences: string, fold: string[]): string {
  return [
    "🟡 Needs your help: plan failed twice",
    "",
    sentences,
    "",
    ...RETRY_LINES,
    "",
    "+++ Details",
    "",
    ...fold,
    "",
    `Flight Deck ${world.version} · runner`,
    "",
    "+++",
  ].join("\n");
}

describe("a second failure", () => {
  test("pauses the issue with the plain-words exit, flags the maintainer, and puts the transcript path under Details", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await failTwice(issue, { exit: { kind: "timed_out" } });
    const sentences = "Plan ran twice, and neither session handed off. The second one ran past plan's 30-minute limit. Its transcript path is under Details.";
    expect(afterTake(issue)).toEqual([
      { kind: "assign", issue: issue.identifier, user: world.maintainer.id },
      { kind: "comment", issue: issue.identifier, body: comment(sentences, facts("`timed_out`")) },
      { kind: "move", issue: issue.identifier, status: "Paused" },
    ]);
    const status = await world.status();
    expect(status.sessions).toEqual([]);
    expect(status.flags).toEqual([
      {
        repo: world.repo,
        issue: issue.identifier,
        title: "Save button is blue",
        url: `https://linear.app/campdotdev/issue/${issue.identifier}`,
        status_line: "🟡 Needs your help: plan failed twice",
        since: world.now.toISOString(),
      },
    ]);
  });

  test("names the rule when the Outbox refused the handoff", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    const refused = { "outcome.json": JSON.stringify({ version: world.version, stage: "plan", move: "ready_to_build" }), "summary.md": "Brief ready" };
    await failTwice(issue, { outbox: refused, exit: { kind: "exited", code: 0 } });
    const body = world.tracker.writes.find((write) => write.kind === "comment");
    expect(body).toEqual({
      kind: "comment",
      issue: issue.identifier,
      body: comment(
        "Plan ran twice, and neither session handed off. The second one wrote a handoff Flight Deck refused, because a move to ready_to_build needs brief.md. Its transcript path is under Details.",
        facts("`exited` with code 0"),
      ),
    });
  });

  test("leaves out a refused rule that quotes what matches a secret rule, and says so", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    const token = "ghp_4f8Xq2Lm9Rt7Vb3Nc6Hj1Kp5Wd0Zs8Ya2Ue4";
    const refused = { "outcome.json": JSON.stringify({ version: world.version, stage: token, move: "ready_to_build" }), "summary.md": "Brief ready", "brief.md": "## Summary\n\nRed." };
    await failTwice(issue, { outbox: refused, exit: { kind: "exited", code: 0 } });
    const body = world.tracker.writes.find((write) => write.kind === "comment");
    expect(body).toEqual({
      kind: "comment",
      issue: issue.identifier,
      body: comment(
        "Plan ran twice, and neither session handed off. The second one wrote a handoff Flight Deck refused, and the rule it broke is left out: it matched a secret rule. Its transcript path is under Details.",
        facts("`exited` with code 0"),
      ),
    });
    expect(JSON.stringify(world.tracker.writes)).not.toContain(token);
  });

  test("says the session stopped with an error, and shows the result event's last error, when it left no handoff", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await failTwice(issue, { exit: { kind: "exited", code: 1 }, error: "API Error: 500 Internal server error" });
    const body = world.tracker.writes.find((write) => write.kind === "comment");
    expect(body).toEqual({
      kind: "comment",
      issue: issue.identifier,
      body: comment("Plan ran twice, and neither session handed off. The second one stopped with an error. Its transcript path is under Details.", [
        ...facts("`exited` with code 1"),
        "",
        "The session's last error:",
        "",
        "```text",
        "API Error: 500 Internal server error",
        "```",
      ]),
    });
  });

  test("leaves out a last error that matches a secret rule, and says so", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    // A made-up GitHub token that Betterleaks' default github-pat rule matches.
    const token = "ghp_4f8Xq2Lm9Rt7Vb3Nc6Hj1Kp5Wd0Zs8Ya2Ue4";
    await failTwice(issue, { exit: { kind: "exited", code: 1 }, error: `git push failed: https://${token}@github.com/campdotdev/shaders` });
    const body = world.tracker.writes.find((write) => write.kind === "comment");
    expect(body).toEqual({
      kind: "comment",
      issue: issue.identifier,
      body: comment("Plan ran twice, and neither session handed off. The second one stopped with an error. Its transcript path is under Details.", [
        ...facts("`exited` with code 1"),
        "",
        "Error message left out: it matched a secret rule.",
      ]),
    });
    expect(JSON.stringify(world.tracker.writes)).not.toContain(token);
  });

  test("says the session couldn't start when prepare failed twice, with prepare's message and no transcript", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    // A session folder can't be made under a read-only sessions folder, so prepare fails.
    const sessions = join(world.folders.sessionRoot, "sessions");
    await mkdir(sessions, { recursive: true });
    await chmod(sessions, 0o500);
    world.send(issue);
    await world.tick();
    expect((await world.status()).sessions.map(({ state }) => state)).toEqual(["retry_waiting"]);
    await world.tick();
    expect(world.harness.started).toEqual([]);
    const body = world.tracker.writes.find((write) => write.kind === "comment");
    if (body?.kind !== "comment") throw new Error("no comment");
    const lines = body.body.split("\n");
    expect(lines.slice(0, 3)).toEqual([
      "🟡 Needs your help: plan failed twice",
      "",
      "Plan ran twice, and neither session handed off. The second one couldn't start, because Flight Deck couldn't prepare its worktree. Flight Deck's message is under Details.",
    ]);
    const fold = lines.slice(lines.indexOf("+++ Details") + 2);
    expect(fold[0]).toMatch(/^- Session: `[0-9a-z]{6}`$/);
    expect(fold.slice(1, 6)).toEqual(["- Attempt: 2", "", "Preparing the worktree failed with:", "", "```text"]);
    expect(fold[6]).toContain("EACCES");
    expect(body.body).not.toContain("Transcript");
    expect(body.body).not.toContain("- Exit");
    expect(world.tracker.stored(issue.id).status).toBe("Paused");
    await chmod(sessions, 0o700);
  });

  test("its retry restores the stage's retry, so the next take has attempt 1, and a failure there retries again", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    await failTwice(issue, { exit: { kind: "timed_out" } });
    world.reply(issue, "retry");
    world.harness.script(issue.identifier, { exit: { kind: "timed_out" } });
    world.harness.script(issue.identifier, {});
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Ready to plan");
    await world.tick();
    expect(world.harness.started[2]!.sessionJson.attempt).toBe(1);
    await world.tick();
    expect(world.harness.started[3]!.sessionJson.attempt).toBe(2);
    expect(world.tracker.stored(issue.id).status).toBe("Planning");
  });
});

describe("a retry", () => {
  test("that hands off moves the issue on, and the stage's next failure starts at attempt 1 again", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    world.harness.script(issue.identifier, { exit: { kind: "exited", code: 1 } });
    world.harness.script(issue.identifier, { outbox: outbox.brief({ summary: "Brief ready", brief: "## Summary\n\nRed." }), exit: { kind: "exited", code: 0 } });
    await world.tick();
    await world.tick();
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Ready to build");
    expect((await world.status()).sessions).toEqual([]);
  });

  test("waiting for a free place starts before any new take", async () => {
    world.config.concurrency_cap = 1;
    await world.writeConfig();
    const first = world.issue({ title: "Save button is blue" });
    world.send(first);
    world.harness.script(first.identifier, {});
    await world.tick();
    const urgent = world.issue({ title: "Checkout crashes", priority: 1 });
    world.send(urgent);
    world.harness.finish(world.harness.started[0]!.session.id, { kind: "timed_out" });
    await world.tick();
    expect(world.harness.started.map(({ session, sessionJson }) => [session.issue, sessionJson.attempt])).toEqual([
      [first.identifier, 1],
      [first.identifier, 2],
    ]);
    expect(world.tracker.stored(urgent.id).status).toBe("Ready to plan");
  });

  test("waits as retry_waiting while no place is free", async () => {
    const first = world.issue({ title: "Save button is blue" });
    const second = world.issue({ title: "Checkout crashes" });
    world.send(first);
    world.send(second);
    world.harness.script(first.identifier, {});
    world.harness.script(second.identifier, {});
    await world.tick();
    expect(world.harness.started).toHaveLength(2);
    // The maintainer lowers the cap while both run, so the retry has no place.
    world.config.concurrency_cap = 1;
    await world.writeConfig();
    world.harness.finish(world.harness.started[0]!.session.id, { kind: "timed_out" });
    await world.tick();
    expect(world.harness.started).toHaveLength(2);
    const status = await world.status();
    expect(status.sessions.map(({ issue, state }) => ({ issue, state }))).toEqual([
      { issue: first.identifier, state: "retry_waiting" },
      { issue: second.identifier, state: "running" },
    ]);
    expect(status.sessions[0]).toMatchObject({ started_at: null, deadline: null });

    // The second session fails too. The place it frees goes to the retry that waited longest.
    world.harness.finish(world.harness.started[1]!.session.id, { kind: "exited", code: 1 });
    await world.tick();
    expect(world.harness.started.map(({ session, sessionJson }) => [session.issue, sessionJson.attempt])).toEqual([
      [first.identifier, 1],
      [second.identifier, 1],
      [first.identifier, 2],
    ]);
  });
});

describe("no_init", () => {
  test("pauses without using the retry, flags the maintainer, and offers retry", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    world.harness.script(issue.identifier, { exit: { kind: "no_init" } });
    await world.tick();
    expect(world.harness.started).toHaveLength(1);
    const session = world.harness.started[0]!.session;
    // The fold never holds transcript text, which could carry a copied value.
    await writeFile(session.transcript, `${JSON.stringify({ type: "system", text: "STRIPE_KEY=sk_live_transcript" })}\n`);
    await world.tick();
    const body = [
      "🟡 Needs your help: plan's session never started",
      "",
      "Claude Code didn't start plan's session within 2 minutes, so Flight Deck stopped it. The usual cause is a prompt on the Mac. Dismiss any dialog from macOS or Claude Code on the Mac before you reply.",
      "",
      "Reply with one word:",
      "",
      "- **retry**: plan runs again. Moves the issue to Ready to plan.",
      "",
      "Any other reply leaves the issue paused until you move it.",
      "",
      "+++ Details",
      "",
      "- Exit: `no_init`",
      `- Session: \`${session.id}\``,
      "- Attempt: 1",
      `- Transcript: \`${session.transcript}\``,
      "",
      `Flight Deck ${world.version} · runner`,
      "",
      "+++",
    ].join("\n");
    expect(afterTake(issue)).toEqual([
      { kind: "assign", issue: issue.identifier, user: world.maintainer.id },
      { kind: "comment", issue: issue.identifier, body },
      { kind: "move", issue: issue.identifier, status: "Paused" },
    ]);
    expect(body).not.toContain("sk_live_transcript");
  });

  test("on a retry pauses too, and its retry's next take has attempt 1", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    world.harness.script(issue.identifier, { exit: { kind: "timed_out" } });
    world.harness.script(issue.identifier, { exit: { kind: "no_init" } });
    await world.tick();
    await world.tick();
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Paused");
    world.reply(issue, "retry");
    world.harness.script(issue.identifier, {});
    await world.tick();
    await world.tick();
    expect(world.harness.started.map(({ sessionJson }) => sessionJson.attempt)).toEqual([1, 2, 1]);
  });
});

describe("a runner comment Linear refuses with a 5xx", () => {
  test("is tried again at each poll, and nothing else happens to the issue until it lands", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.tracker.refuse("post", { times: 2 });
    await failTwice(issue, { exit: { kind: "timed_out" } });
    expect(afterTake(issue)).toEqual([]);
    expect(world.tracker.stored(issue.id).status).toBe("Planning");

    // While the comment waits, an assignee the maintainer set and their reply's subscription stay.
    world.tracker.setAssignee(issue.id, "someone");
    world.reply(issue, "retry");
    await world.tick();
    expect(afterTake(issue)).toEqual([]);
    expect(world.harness.started).toHaveLength(2);

    await world.tick();
    const sentences = "Plan ran twice, and neither session handed off. The second one ran past plan's 30-minute limit. Its transcript path is under Details.";
    expect(afterTake(issue)).toEqual([
      { kind: "assign", issue: issue.identifier, user: world.maintainer.id },
      { kind: "comment", issue: issue.identifier, body: comment(sentences, facts("`timed_out`")) },
      { kind: "move", issue: issue.identifier, status: "Paused" },
    ]);
    // The reply came before the pause comment, so it doesn't answer it.
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Paused");
  });

  test("whose move Linear refuses keeps the posted comment and tries only the move again", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    world.harness.script(issue.identifier, { exit: { kind: "no_init" } });
    await world.tick();
    world.tracker.refuse("move");
    await world.tick();
    expect(afterTake(issue).map((write) => write.kind)).toEqual(["assign", "comment"]);
    await world.tick();
    expect(afterTake(issue).map((write) => write.kind)).toEqual(["assign", "comment", "move"]);
    expect(world.tracker.stored(issue.id).status).toBe("Paused");
    world.reply(issue, "retry");
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Ready to plan");
  });

  test("is dropped when the maintainer moves the issue before it lands", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.tracker.refuse("post");
    world.send(issue);
    world.harness.script(issue.identifier, { exit: { kind: "no_init" } });
    await world.tick();
    await world.tick();
    world.tracker.setStatus(issue.id, "Backlog");
    await world.tick();
    await world.tick();
    expect(afterTake(issue)).toEqual([]);
    expect((await world.status()).flags).toEqual([]);
  });
});
