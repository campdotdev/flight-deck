// Claude Code's login (spec 1, "Exits", "Trouble issues", ADR 0005): an expired login holds the runner until a
// trial run passes, and a warning that it expires soon files a trouble issue and holds nothing.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { outbox, World } from "./world.ts";

let world: World;

beforeEach(async () => {
  world = await World.create();
});

afterEach(async () => {
  await world.cleanup();
});

const FOOTER = "+++ Details\n\nFlight Deck 0.1.0 · runner\n\n+++";
const PASSES = { outbox: { "summary.md": "The trial ran.\n" }, exit: { kind: "exited", code: 0 } } as const;
const BRIEF = outbox.brief({ summary: "Brief ready: the Save button turns red", brief: "## Summary\n\nTurn it red.\n" });

/** The writes from the next tick. */
async function nextTick(at?: Date): Promise<unknown[]> {
  const before = world.tracker.writes.length;
  await world.tick(at);
  return world.tracker.writes.slice(before);
}

/** Runs one tick a minute until the clock reads `iso`. */
async function tickUntil(iso: string): Promise<void> {
  while (world.now.toISOString() < iso) await world.tick();
}

const stages = () => world.harness.started.map((each) => each.session.stage);

describe("login_expired", () => {
  test("opens claude_login, requeues the issue with no retry and no comment, and holds until a trial passes", async () => {
    const sent = world.issue({ title: "Save button is blue" });
    world.send(sent);
    world.harness.script(sent.identifier, { exit: { kind: "login_expired" }, error: "OAuth token has expired" });
    await world.tick();

    const title = "Claude Code's login expired: run claude, then /login";
    const writes = (await nextTick()) as { kind: string; issue?: string; status?: string; title?: string; description?: string }[];
    expect(writes.map((write) => [write.kind, write.issue])).toEqual([
      ["move", sent.identifier],
      ["file", "SHA-2"],
      ["assign", "SHA-2"],
    ]);
    expect(writes[0]!.status).toBe("Ready to plan");
    expect(writes[1]!.title).toBe(title);
    const session = world.harness.started[0]!.session.id;
    expect(writes[1]!.description).toBe(
      [
        "Flight Deck stopped starting sessions on this Mac at 2026-11-10 09:02 UTC. Claude Code's login expired, so a session ended without finishing. Flight Deck starts a trial run every 15 minutes, and sessions start again once one passes.",
        "",
        "1. In a terminal on the Mac, run `claude`.",
        "2. Type `/login`, and sign in with the account Flight Deck's sessions use.",
        "",
        "Flight Deck comments here once it works again. Close the issue then.",
        "",
        "+++ Details",
        "",
        "- Cause: `claude_login`",
        `- Session: \`${session}\``,
        "",
        "The session ended with:",
        "",
        "```text",
        "OAuth token has expired",
        "```",
        "",
        "Flight Deck 0.1.0 · runner",
        "",
        "+++",
      ].join("\n"),
    );
    expect(await world.notifications()).toEqual([title]);
    expect((await world.status()).runner).toEqual({
      state: "held",
      holds: [{ cause: "claude_login", scope: "runner", name: null, since: "2026-11-10T09:02:00.000Z", until: null }],
    });
    expect((await world.status()).sessions).toEqual([]);

    // Held: the issue waits in Ready to plan, and the first trial starts 15 minutes after the cause opened.
    world.harness.script("", { exit: { kind: "login_expired" } });
    await tickUntil("2026-11-10T09:16:00.000Z");
    expect(stages()).toEqual(["plan"]);
    await world.tick();
    expect(stages()).toEqual(["plan", "trial"]);

    // A failing trial keeps the cause open, and the next one starts 15 minutes after the last one started.
    world.harness.script("", PASSES);
    await tickUntil("2026-11-10T09:31:00.000Z");
    expect(stages()).toEqual(["plan", "trial"]);
    expect(world.tracker.stored(sent.id).status).toBe("Ready to plan");
    await world.tick();
    expect(stages()).toEqual(["plan", "trial", "trial"]);

    // The passing trial clears the cause with its cleared comment, and the issue is taken again.
    world.harness.script(sent.identifier, { outbox: BRIEF, exit: { kind: "exited", code: 0 } });
    expect(await nextTick()).toEqual([
      { kind: "move", issue: sent.identifier, status: "Planning" },
      { kind: "comment", issue: "SHA-2", body: `🟢 Fixed: Claude Code is signed in again.\n\nSessions start again at the next poll.\n\n${FOOTER}` },
    ]);
    expect((await world.status()).runner).toEqual({ state: "working", holds: [] });
    expect(world.harness.started[3]!.sessionJson.attempt).toBe(1);
  });

  test("leaves the session's error out of the trouble issue when it matches a secret rule, and says so", async () => {
    const sent = world.issue({ title: "Save button is blue" });
    world.send(sent);
    world.harness.script(sent.identifier, { exit: { kind: "login_expired" }, error: "OAuth token ghp_4f8Xq2Lm9Rt7Vb3Nc6Hj1Kp5Wd0Zs8Ya2Ue4 has expired" });
    await world.tick();

    const filed = ((await nextTick()) as { kind: string; description?: string }[]).find((write) => write.kind === "file")!;
    expect(filed.description).toContain(`- Session: \`${world.harness.started[0]!.session.id}\`\n\nError message left out: it matched a secret rule.\n\nFlight Deck 0.1.0 · runner`);
    expect(filed.description).not.toContain("ghp_");
  });

  test("leaves the session's error out of the trouble issue when it holds a copied file's value", async () => {
    await world.copyFile(".env", "STRIPE_KEY=sk_test_value_from_the_env_file\n");
    const sent = world.issue({ title: "Save button is blue" });
    world.send(sent);
    world.harness.script(sent.identifier, { exit: { kind: "login_expired" }, error: "login failed for sk_test_value_from_the_env_file" });
    await world.tick();

    const filed = ((await nextTick()) as { kind: string; description?: string }[]).find((write) => write.kind === "file")!;
    expect(filed.description).toContain("Error message left out: it matched a secret rule.");
    expect(filed.description).not.toContain("sk_test_value_from_the_env_file");
  });

  test("the next take keeps the attempt the session had", async () => {
    const sent = world.issue({ title: "Save button is blue" });
    world.send(sent);
    world.harness.script(sent.identifier, { exit: { kind: "exited", code: 1 } });
    world.harness.script(sent.identifier, { exit: { kind: "login_expired" } });
    await world.tick();
    await world.tick();
    await world.tick();
    expect(world.harness.started.map((each) => each.sessionJson.attempt)).toEqual([1, 2]);
    expect(world.tracker.stored(sent.id).status).toBe("Ready to plan");

    // A trial that install asks for clears the cause too.
    world.harness.script("", PASSES);
    void world.poll.trial();
    await world.tick();
    world.harness.script(sent.identifier, { outbox: BRIEF });
    await world.tick();
    expect(world.harness.started.map((each) => [each.session.stage, each.sessionJson.attempt])).toEqual([
      ["plan", 1],
      ["plan", 2],
      ["trial", 1],
      ["plan", 2],
    ]);
  });
});

describe("claude_login_soon", () => {
  test("a warning files its trouble issue and holds nothing, and a later session without it clears the cause", async () => {
    const first = world.issue({ title: "Save button is blue" });
    world.send(first);
    world.harness.script(first.identifier, { loginExpiring: "Your login expires in 3 days. Run /login to renew it." });
    await world.tick();
    const session = world.harness.started[0]!.session.id;

    const title = "Claude Code's login expires soon: run claude, then /login";
    const second = world.issue({ title: "Cancel button is green" });
    world.send(second);
    const writes = (await nextTick()) as { kind: string; issue?: string; status?: string; title?: string; description?: string }[];
    const filed = writes.find((write) => write.kind === "file")!;
    expect(filed.title).toBe(title);
    expect(filed.description).toBe(
      [
        "Claude Code warned at 2026-11-10 09:02 UTC that its login expires soon. Nothing has stopped yet. Once the login expires, Flight Deck stops starting sessions on this Mac.",
        "",
        "1. In a terminal on the Mac, run `claude`.",
        "2. Type `/login`, and sign in with the account Flight Deck's sessions use.",
        "",
        "Flight Deck comments here once it works again. Close the issue then.",
        "",
        "+++ Details",
        "",
        "- Cause: `claude_login_soon`",
        `- Session: \`${session}\``,
        "",
        "Claude Code's warning:",
        "",
        "```text",
        "Your login expires in 3 days. Run /login to renew it.",
        "```",
        "",
        "Flight Deck 0.1.0 · runner",
        "",
        "+++",
      ].join("\n"),
    );
    expect(await world.notifications()).toEqual([title]);
    // It holds nothing: the second issue is taken at the same poll.
    expect(writes).toContainEqual({ kind: "move", issue: second.identifier, status: "Planning" });
    const status = await world.status();
    expect(status.runner).toEqual({ state: "working", holds: [] });
    expect(status.trouble.map((each) => each.cause)).toEqual(["claude_login_soon"]);

    // The warned session ending changes nothing. The second session started after the warning and ends without it.
    world.harness.finish(session, { kind: "exited", code: 1 });
    expect(await nextTick()).not.toContainEqual(expect.objectContaining({ kind: "comment", issue: filed.issue }));
    world.harness.finish(world.harness.started[1]!.session.id, { kind: "exited", code: 1 });
    expect(await nextTick()).toContainEqual({
      kind: "comment",
      issue: filed.issue,
      body: `🟢 Fixed: Claude Code's login was renewed.\n\nNothing had stopped.\n\n${FOOTER}`,
    });
    expect((await world.status()).trouble).toEqual([]);
  });
});
