// Trouble issues: a cause that stops the runner, or one repo's factory, files one flagged issue in the repo's
// `intake` role and posts a macOS notification, then comments when the cause clears (spec 1, "Trouble issues",
// ADR 0011). Causes the runner can't file only notify.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { World } from "./world.ts";

let world: World;

beforeEach(async () => {
  world = await World.create();
});

afterEach(async () => {
  await world.cleanup();
});

/** The writes from the next tick. */
async function nextTick(at?: Date): Promise<unknown[]> {
  const before = world.tracker.writes.length;
  await world.tick(at);
  return world.tracker.writes.slice(before);
}

const FOOTER = "+++ Details\n\nFlight Deck 0.1.0 · runner\n\n+++";

describe("missing_status", () => {
  test("a missing status opens one trouble issue, flagged once, with a comment when it clears", async () => {
    world.tracker.renameStatus("SHA", "Planning", "Plan");
    const writes = await nextTick();
    const title = "Linear status Planning is missing: rename it back or rerun setup";
    expect(writes).toEqual([
      {
        kind: "file",
        issue: "SHA-1",
        title,
        status: "Triage",
        description: [
          "Flight Deck stopped starting sessions for campdotdev/shaders at 2026-11-10 09:01 UTC. The repo's record names Linear statuses that team SHA doesn't have:",
          "",
          "- Planning, for the `planning` role",
          "",
          "1. In Linear, open team SHA's settings, then its issue statuses.",
          "2. Give each status above its old name again, or add it back.",
          "3. If you renamed a status on purpose, rerun setup, so the record names the new name.",
          "",
          "Flight Deck comments here once it works again. Close the issue then.",
          "",
          "+++ Details",
          "",
          "- Cause: `missing_status`",
          "- Repo: `campdotdev/shaders`",
          "- Team: `SHA`",
          "- Missing roles: `planning`",
          "",
          "Flight Deck 0.1.0 · runner",
          "",
          "+++",
        ].join("\n"),
      },
      { kind: "assign", issue: "SHA-1", user: world.maintainer.id },
    ]);
    expect(await world.notifications()).toEqual([title]);

    // Nothing more while the issue is open, and no session starts for the repo.
    const sent = world.issue({ title: "Save button is blue" });
    world.send(sent);
    expect(await nextTick()).toEqual([]);
    expect(world.harness.started).toEqual([]);
    expect(await world.notifications()).toEqual([title]);

    world.tracker.renameStatus("SHA", "Plan", "Planning");
    expect(await nextTick()).toEqual([
      // The same poll takes the sent issue, because the team check passed, and comments at step 10.
      { kind: "unsubscribe", issue: sent.identifier, user: world.maintainer.id },
      { kind: "move", issue: sent.identifier, status: "Planning" },
      { kind: "comment", issue: "SHA-1", body: `🟢 Fixed: Linear status Planning is back.\n\nThis repo's sessions start again at the next poll.\n\n${FOOTER}` },
    ]);
  });

  test("status.json lists the open cause with its issue, its repo hold, and the trouble issue's flag", async () => {
    world.tracker.renameStatus("SHA", "Planning", "Plan");
    await world.tick();
    const title = "Linear status Planning is missing: rename it back or rerun setup";
    const url = "https://linear.app/campdotdev/issue/SHA-1";
    const since = "2026-11-10T09:01:00.000Z";
    await world.tick();
    const status = await world.status();
    expect(status.trouble).toEqual([{ cause: "missing_status", repos: ["campdotdev/shaders"], issue_url: url, since }]);
    expect(status.runner).toEqual({ state: "working", holds: [{ cause: "missing_status", scope: "repo", name: "campdotdev/shaders", since, until: null }] });
    expect(status.flags).toEqual([{ repo: "campdotdev/shaders", issue: "SHA-1", title, url, status_line: title, since }]);

    // The maintainer clears the trouble issue's assignee: the flag goes, and the cause stays open.
    world.tracker.setAssignee("SHA-1", null);
    expect(await nextTick()).toEqual([]);
    expect((await world.status()).flags).toEqual([]);
    expect((await world.status()).trouble).toHaveLength(1);
  });

  test("a cause that opens again before its issue is closed comments, flags again, and files no second issue", async () => {
    const title = "Linear status Planning is missing: rename it back or rerun setup";
    world.tracker.renameStatus("SHA", "Planning", "Plan");
    await world.tick();
    world.tracker.renameStatus("SHA", "Plan", "Planning");
    await world.tick();
    // The maintainer clears the assignee before the cause opens again.
    world.tracker.setAssignee("SHA-1", null);
    world.tracker.renameStatus("SHA", "Planning", "Plan");
    expect(await nextTick()).toEqual([
      { kind: "assign", issue: "SHA-1", user: world.maintainer.id },
      { kind: "comment", issue: "SHA-1", body: `🟡 Needs your help: ${title}\n\n${FOOTER}` },
    ]);
    expect(await world.notifications()).toEqual([title, title]);
    expect(await nextTick()).toEqual([]);

    // Still assigned, the next time it only comments.
    world.tracker.renameStatus("SHA", "Plan", "Planning");
    await world.tick();
    world.tracker.renameStatus("SHA", "Planning", "Plan");
    expect(await nextTick()).toEqual([{ kind: "comment", issue: "SHA-1", body: `🟡 Needs your help: ${title}\n\n${FOOTER}` }]);
  });

  test("once the maintainer closes the issue, the cause opening again files a new one", async () => {
    world.tracker.renameStatus("SHA", "Planning", "Plan");
    await world.tick();
    world.tracker.renameStatus("SHA", "Plan", "Planning");
    await world.tick();
    world.tracker.setStatus("SHA-1", "Done");
    world.tracker.renameStatus("SHA", "Planning", "Plan");
    const writes = await nextTick();
    expect(writes.map((write) => [(write as { kind: string }).kind, (write as { issue: string }).issue])).toEqual([
      ["file", "SHA-2"],
      ["assign", "SHA-2"],
    ]);
  });

  test("a missing intake status only notifies, because the trouble issue would go there", async () => {
    world.tracker.renameStatus("SHA", "Triage", "Inbox");
    expect(await nextTick()).toEqual([]);
    expect(await nextTick()).toEqual([]);
    expect(await world.notifications()).toEqual(["Linear status Triage is missing: rename it back or rerun setup"]);
  });

  test("the title names the first missing status in role order, and the body lists them all", async () => {
    world.tracker.renameStatus("SHA", "Paused", "On hold");
    world.tracker.renameStatus("SHA", "Ready to plan", "Ready");
    const [filed] = (await nextTick()) as { title: string; description: string }[];
    expect(filed!.title).toBe("Linear status Ready to plan is missing: rename it back or rerun setup");
    expect(filed!.description).toContain("- Ready to plan, for the `ready_to_plan` role\n- Paused, for the `paused` role\n");
    expect(filed!.description).toContain("- Missing roles: `ready_to_plan`, `paused`");
  });
});

describe("notify-only causes", () => {
  test("a workspace with no secrets in credentials.env notifies once, files nothing, and holds the repo", async () => {
    await world.writeCredentials("");
    const sent = world.issue({ title: "Save button is blue" });
    world.send(sent);
    expect(await nextTick()).toEqual([]);
    expect(await nextTick()).toEqual([]);
    expect(world.harness.started).toEqual([]);
    expect(await world.notifications()).toEqual(["No Linear login for campdotdev: run flight-deck login linear campdotdev"]);
    const status = await world.status();
    expect(status.runner).toEqual({
      state: "working",
      holds: [{ cause: "linear_login", scope: "repo", name: "campdotdev/shaders", since: "2026-11-10T09:01:00.000Z", until: null }],
    });
    expect(status.trouble).toEqual([{ cause: "linear_login", repos: ["campdotdev/shaders"], issue_url: null, since: "2026-11-10T09:01:00.000Z" }]);
  });

  test("a team the Flight Deck app can't read notifies once and files nothing", async () => {
    world.tracker.setReadable("SHA", false);
    expect(await nextTick()).toEqual([]);
    expect(await nextTick()).toEqual([]);
    expect(await world.notifications()).toEqual(["Flight Deck can't read Linear team SHA: check the team and both apps' access"]);
    world.tracker.setReadable("SHA", true);
    expect(await nextTick()).toEqual([]);
    expect((await world.status()).trouble).toEqual([]);
  });

  test("two registrations naming one team notify once, file nothing, and skip both repos", async () => {
    const other = { ...world.config.repos[0]!, name: "campdotdev/shaders-docs" };
    world.config.repos.push(other);
    await world.writeConfig();
    const sent = world.issue({ title: "Save button is blue" });
    world.send(sent);
    expect(await nextTick()).toEqual([]);
    expect(await nextTick()).toEqual([]);
    expect(await world.notifications()).toEqual(["Two repos use Linear team SHA: run flight-deck register for one team per repo"]);
    expect((await world.status()).runner.holds.map((hold) => [hold.cause, hold.scope, hold.name])).toEqual([
      ["shared_team", "repo", "campdotdev/shaders"],
      ["shared_team", "repo", "campdotdev/shaders-docs"],
    ]);

    world.config.repos.pop();
    await world.writeConfig();
    await world.tick();
    expect(world.tracker.stored(sent.id).status).toBe("Planning");
    expect((await world.status()).runner.holds).toEqual([]);
  });
});

describe("credentials", () => {
  test("credentials.env at mode 0640 holds the runner, and notifies once", async () => {
    await world.credentialsMode(0o640);
    const sent = world.issue({ title: "Save button is blue" });
    world.send(sent);
    // The runner still polls: it unsubscribes the maintainer, and takes nothing.
    expect(await nextTick()).toEqual([{ kind: "unsubscribe", issue: sent.identifier, user: world.maintainer.id }]);
    expect(await nextTick()).toEqual([]);
    expect(world.harness.started).toEqual([]);
    expect(await world.notifications()).toEqual(["Flight Deck stopped: others can read credentials.env. Run chmod 600 on it."]);
    const status = await world.status();
    expect(status.runner).toEqual({
      state: "held",
      holds: [{ cause: "credentials", scope: "runner", name: null, since: "2026-11-10T09:01:00.000Z", until: null }],
    });
    expect(status.trouble).toEqual([{ cause: "credentials", repos: [], issue_url: null, since: "2026-11-10T09:01:00.000Z" }]);

    await world.credentialsMode(0o600);
    expect(await nextTick()).toEqual([{ kind: "move", issue: sent.identifier, status: "Planning" }]);
    expect((await world.status()).runner).toEqual({ state: "working", holds: [] });
  });

  test.each([0o400, 0o600])("credentials.env at mode %o passes", async (mode) => {
    await world.credentialsMode(mode);
    const sent = world.issue({ title: "Save button is blue" });
    world.send(sent);
    await world.tick();
    expect(world.tracker.stored(sent.id).status).toBe("Planning");
    expect(await world.notifications()).toEqual([]);
  });
});

describe("claude_code_version", () => {
  test("a Claude Code older than data/claude-code.toml's minimum files its title, starts nothing, and comments when updated", async () => {
    world.harness.claudeCodeVersion = "2.0.5";
    const sent = world.issue({ title: "Save button is blue" });
    world.send(sent);
    const title = "Claude Code 2.0.5 is too old for Flight Deck: run claude update";
    const writes = (await nextTick()) as { kind: string; title?: string; description?: string }[];
    expect(writes.map((write) => write.kind)).toEqual(["unsubscribe", "file", "assign"]);
    expect(writes[1]!.title).toBe(title);
    expect(writes[1]!.description).toStartWith(
      [
        "Flight Deck stopped starting sessions on this Mac at 2026-11-10 09:01 UTC. It needs Claude Code 2.1.321 or later, and the Mac has 2.0.5.",
        "",
        "1. In a terminal on the Mac, run `claude update`.",
        "2. Run `claude --version`, and check that it prints 2.1.321 or later.",
        "",
        "Flight Deck comments here once it works again. Close the issue then.",
      ].join("\n"),
    );
    expect(world.harness.started).toEqual([]);
    expect(await world.notifications()).toEqual([title]);
    expect((await world.status()).runner.state).toBe("held");

    world.harness.claudeCodeVersion = "2.1.400";
    expect(await nextTick()).toEqual([
      { kind: "move", issue: sent.identifier, status: "Planning" },
      { kind: "comment", issue: "SHA-2", body: `🟢 Fixed: Claude Code 2.1.400 works with Flight Deck.\n\nSessions start again at the next poll.\n\n${FOOTER}` },
    ]);
  });
});

describe("github_token", () => {
  test("a fetch that fails to authenticate files its title, and a fetch that authenticates clears it", async () => {
    // A remote that answers every request with 401, as GitHub does for a revoked token.
    const server = Bun.serve({ port: 0, fetch: () => new Response("", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="GitHub"' } }) });
    try {
      const remote = world.config.repos[0]!.remote;
      world.config.repos[0]!.remote = `http://127.0.0.1:${server.port}/campdotdev/shaders.git`;
      await world.writeConfig();
      const title = "Flight Deck can't sign in to GitHub: run flight-deck login github";
      const writes = (await nextTick()) as { kind: string; title?: string; description?: string }[];
      expect(writes.map((write) => write.kind)).toEqual(["file", "assign"]);
      expect(writes[0]!.title).toBe(title);
      expect(writes[0]!.description).toStartWith(
        [
          "Flight Deck stopped starting sessions on this Mac at 2026-11-10 09:01 UTC. GitHub refused the machine user's login when Flight Deck fetched campdotdev/shaders.",
          "",
          "1. In a terminal on the Mac, run `flight-deck login github`.",
          "2. Sign in as the machine user, not as yourself.",
        ].join("\n"),
      );
      expect(writes[0]!.description).toContain("- Cause: `github_token`");
      expect(await world.notifications()).toEqual([title]);

      world.config.repos[0]!.remote = remote;
      await world.writeConfig();
      expect(await nextTick()).toEqual([
        { kind: "comment", issue: "SHA-1", body: `🟢 Fixed: Flight Deck can sign in to GitHub again.\n\nSessions start again at the next poll.\n\n${FOOTER}` },
      ]);
    } finally {
      server.stop(true);
    }
  });
});

describe("stale takes", () => {
  const STALE = (duration: string) =>
    [
      `🟡 Needs your help: in Planning for ${duration} with no Flight Deck session`,
      "",
      "No Flight Deck session is working on this issue. If you're running the stage by hand, finish that run. Otherwise, move the issue back to Ready to plan, and the factory takes it.",
      "",
      FOOTER,
    ].join("\n");

  /** A hand run takes the issue: the maintainer moves it to Planning, and no session is in the list. */
  function handTake(): ReturnType<World["issue"]> {
    const issue = world.issue({ title: "Save button is blue" });
    world.tracker.setStatus(issue.id, "Planning");
    return issue;
  }

  test("an issue in Planning past plan's limit with no session is flagged once per stay", async () => {
    const issue = handTake();
    const since = world.now.toISOString();
    expect(await nextTick()).toEqual([{ kind: "unsubscribe", issue: issue.identifier, user: world.maintainer.id }]);
    // Plan's limit is 30 minutes. At 30 minutes the take isn't stale yet.
    expect(await nextTick(new Date(Date.parse(since) + 30 * 60_000))).toEqual([]);
    expect(await nextTick(new Date(Date.parse(since) + 31 * 60_000))).toEqual([
      { kind: "assign", issue: issue.identifier, user: world.maintainer.id },
      { kind: "comment", issue: issue.identifier, body: STALE("31 minutes") },
    ]);
    expect(await nextTick(new Date(Date.parse(since) + 3 * 3600_000 + 59 * 60_000))).toEqual([]);

    const status = await world.status();
    expect(status.stale_takes).toEqual([{ repo: "campdotdev/shaders", issue: issue.identifier, title: "Save button is blue", status: "Planning", since }]);
    expect(status.flags).toEqual([
      {
        repo: "campdotdev/shaders",
        issue: issue.identifier,
        title: "Save button is blue",
        url: `https://linear.app/campdotdev/issue/${issue.identifier}`,
        status_line: "🟡 Needs your help: in Planning for 31 minutes with no Flight Deck session",
        since: new Date(Date.parse(since) + 31 * 60_000).toISOString(),
      },
    ]);

    // It leaves Planning and comes back: a new stay, flagged again once it's stale. Durations past 2 hours read in hours.
    world.tracker.setStatus(issue.id, "Backlog");
    await world.tick();
    world.tracker.setStatus(issue.id, "Planning");
    const back = world.now.getTime();
    await world.tick();
    const writes = await nextTick(new Date(back + 2 * 3600_000 + 30 * 60_000));
    expect(writes).toContainEqual({ kind: "comment", issue: issue.identifier, body: STALE("2 hours") });
  });

  test("a stale-take flag the maintainer clears by hand doesn't come back", async () => {
    const issue = handTake();
    const since = Date.parse(world.now.toISOString());
    await world.tick();
    await world.tick(new Date(since + 31 * 60_000));
    world.tracker.setAssignee(issue.id, null);
    // Linear keeps the maintainer subscribed, and the issue is now unflagged.
    expect(await nextTick()).toEqual([{ kind: "unsubscribe", issue: issue.identifier, user: world.maintainer.id }]);
    expect(await nextTick(new Date(since + 5 * 3600_000))).toEqual([]);
    expect((await world.status()).flags).toEqual([]);
    expect((await world.status()).stale_takes.map((take) => take.issue)).toEqual([issue.identifier]);
  });

  test("an issue in Planning with a session in the list is no stale take", async () => {
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    // The session runs with no exit until the scenario ends it.
    await world.tick();
    expect(world.tracker.stored(issue.id).status).toBe("Planning");
    expect(await nextTick(new Date(world.now.getTime() + 2 * 3600_000))).toEqual([]);
    expect((await world.status()).stale_takes).toEqual([]);
  });

  test("a repo that never had a valid record gets no stale-take flags", async () => {
    await world.cleanup();
    world = await World.create({ record: null });
    handTake();
    await world.tick();
    expect(await nextTick(new Date(world.now.getTime() + 5 * 3600_000))).toEqual([]);
  });

  test("the last valid record's limit holds once the default branch's record turns invalid", async () => {
    await world.tick();
    await world.push({ ".flight-deck/record.toml": "schema = 1\n" });
    const issue = handTake();
    const since = world.now.getTime();
    await world.tick();
    expect(await nextTick(new Date(since + 31 * 60_000))).toContainEqual({ kind: "comment", issue: issue.identifier, body: STALE("31 minutes") });
  });
});
