// The trial run (spec 1, "Install", "Trial run"; glossary: trial run): a session in a throwaway repo, with the
// settings a plan session gets and no record, that proves the sandbox and Claude Code's login work.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { TEST_NOTIFICATION, TRIAL_STOPPED_BY, trialStoppedBy, type TrialResult } from "../../src/poll/index.ts";
import type { HoldCause } from "../../src/state/index.ts";
import { World } from "./world.ts";

let world: World;

beforeEach(async () => {
  world = await World.create();
});

afterEach(async () => {
  await world.cleanup();
});

/** A trial that does what its prompt asks. */
const PASSES = { outbox: { "summary.md": "The trial ran.\n" }, exit: { kind: "exited", code: 0 } } as const;

/** Asks for a trial, then runs ticks until it ends, at most five. */
async function runTrial(): Promise<TrialResult> {
  let result: TrialResult | null = null;
  void world.poll.trial().then((each) => (result = each));
  for (let i = 0; i < 5 && result === null; i++) await world.tick();
  if (result === null) throw new Error("the trial didn't end");
  return result;
}

describe("a trial", () => {
  test("starts in a throwaway repo with plan's settings, no record, and no Linear server", async () => {
    world.harness.script("", PASSES);
    const result = await runTrial();
    expect(result).toEqual({ result: "passed", session: expect.any(String), exit: { kind: "exited", code: 0 } });

    const start = world.harness.started[0]!;
    const { id, worktree, sessionFolder } = start.session;
    expect(start.session.stage).toBe("trial");
    expect(worktree).toBe(join(world.folders.sessionRoot, "worktrees", id));
    expect(start.session.transcript).toBe(join(world.folders.data, "state", "trials", `${id}.jsonl`));
    // One empty commit on main, in a repo of its own.
    expect(start.worktreeHead).toMatch(/^[0-9a-f]{40}$/);

    const sessionJson = join(sessionFolder, "session.json");
    expect(start.sessionJson).toEqual({
      version: world.version,
      session: id,
      stage: "trial",
      mode: "issue",
      repo: "",
      issue: "",
      branch: "main",
      base: "main",
      commit: start.worktreeHead,
      worktree,
      deadline: new Date(world.now.getTime() - 60_000 + 5 * 60_000).toISOString(),
      port: null,
      app_url: null,
      inbox: join(sessionFolder, "inbox"),
      outbox: join(sessionFolder, "outbox"),
      skills: join(world.versionFolder, "skills"),
      slots: {},
      maintainer: null,
      app_user: "",
      team: "",
      plugin: join(world.versionFolder, "plugin"),
      attempt: 1,
      agents_md: null,
    });

    // The prompt is the trial's instructions, and Claude Code's default model runs it.
    expect(start.args).toEqual([
      "-p",
      [
        "This is a Flight Deck trial run. It checks that a session starts, reads its files, and runs a command in the sandbox.",
        "",
        `1. Read ${sessionJson}.`,
        "2. Run `true` with the Bash tool, inside the sandbox.",
        `3. Write one line that says the trial ran to ${join(sessionFolder, "outbox", "summary.md")}.`,
        "4. Stop.",
      ].join("\n"),
      "--output-format",
      "stream-json",
      "--verbose",
      "--session-id",
      start.handle.uuid,
      "--setting-sources",
      "",
      "--settings",
      join(sessionFolder, "settings.json"),
      "--mcp-config",
      join(sessionFolder, "mcp.json"),
      "--strict-mcp-config",
      "--plugin-dir",
      join(world.versionFolder, "plugin"),
      "--add-dir",
      worktree,
    ]);
    expect(start.mcp).toEqual({ mcpServers: {} });

    // Sandbox policy with no record: no hosts, no read paths, no clone, and nothing denies the repo's own `.git`.
    expect(start.settings.sandbox).toEqual({
      enabled: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      filesystem: {
        denyRead: [`${world.folders.home}/`, world.folders.sessionRoot],
        allowRead: [
          worktree,
          sessionFolder,
          join(world.versionFolder, "skills"),
          join(world.versionFolder, "plugin"),
          join(world.folders.home, ".claude", "projects", worktree.replace(/[^A-Za-z0-9]/g, "-")),
          join(world.folders.sessionRoot, "etc"),
        ],
        allowWrite: ["outbox", "tmp", "deps", "home"].map((part) => join(sessionFolder, part)),
        denyWrite: [],
      },
      network: { allowedDomains: [], deniedDomains: ["github.com", "api.github.com", "uploads.github.com"], allowLocalBinding: true },
    });
    // The rest of the settings match a plan session's: the same permissions, minus the record's hosts.
    expect(start.settings.permissions.allow).toContain(`Edit(/${join(worktree, "**")})`);
    expect(start.settings.permissions.allow.filter((rule) => rule.startsWith("WebFetch"))).not.toContain("WebFetch(domain:registry.npmjs.org)");
    expect(start.settings.disableAllHooks).toBe(true);
    expect(start.settings.env.FLIGHT_DECK_SESSION).toBe(sessionJson);

    // A trial has no registration, so its PATH is the folders of [paths] claude, git, and gh, then the system's.
    const path = [...new Set([world.config.paths.claude, world.config.paths.git, world.config.paths.gh].map((each) => dirname(each)))].join(":");
    expect(start.environment.PATH).toBe(`${path}:/usr/bin:/bin:/usr/sbin:/sbin`);
    expect(start.settings.env.PATH).toBe(start.environment.PATH);

    // No Reader token, and nothing written to Linear.
    expect(world.tracker.tokens).toEqual([]);
    expect(world.tracker.writes).toEqual([]);
  });

  test("passes, and deletes its repo outright", async () => {
    world.harness.script("", PASSES);
    const result = await runTrial();
    const start = world.harness.started[0]!;
    expect(existsSync(start.session.worktree)).toBe(false);
    expect(existsSync(start.session.sessionFolder)).toBe(false);
    // The transcript stays.
    expect(existsSync(start.session.transcript)).toBe(true);
    expect(result.result).toBe("passed");
  });

  test("shows in status.json with stage trial while it runs", async () => {
    let result: TrialResult | null = null;
    void world.poll.trial().then((each) => (result = each));
    await world.tick();
    const start = world.harness.started[0]!;
    expect((await world.status()).sessions).toEqual([
      { id: start.session.id, repo: "", issue: "", title: "", stage: "trial", state: "running", started_at: world.now.toISOString(), deadline: start.sessionJson.deadline },
    ]);
    expect(result).toBeNull();
  });

  test("fails when the session exits 0 without summary.md, or exits with another code", async () => {
    world.harness.script("", { exit: { kind: "exited", code: 0 } });
    expect(await runTrial()).toEqual({ result: "failed", session: expect.any(String), exit: { kind: "exited", code: 0 } });
    world.harness.script("", { outbox: { "summary.md": "x\n" }, exit: { kind: "exited", code: 1 } });
    expect(await runTrial()).toEqual({ result: "failed", session: expect.any(String), exit: { kind: "exited", code: 1 } });
    world.harness.script("", { exit: { kind: "no_init" } });
    expect(await runTrial()).toEqual({ result: "failed", session: expect.any(String), exit: { kind: "no_init" } });
  });

  test("runs with no repo registered, as install's first trial does", async () => {
    world.config.repos = [];
    await world.writeConfig();
    world.harness.script("", PASSES);
    expect((await runTrial()).result).toBe("passed");
  });
});

describe("which holds a trial runs under", () => {
  test("runs under the maintainer's hold", async () => {
    await world.hold();
    world.harness.script("", PASSES);
    expect((await runTrial()).result).toBe("passed");
  });

  test("runs under a repo's cause, such as a missing status", async () => {
    world.tracker.renameStatus("SHA", "Planning", "Plan");
    world.harness.script("", PASSES);
    expect((await runTrial()).result).toBe("passed");
  });

  test("runs under github_token", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="GitHub"' } }) });
    try {
      world.config.repos[0]!.remote = `http://127.0.0.1:${server.port}/campdotdev/shaders.git`;
      await world.writeConfig();
      world.harness.script("", PASSES);
      expect((await runTrial()).result).toBe("passed");
      expect((await world.status()).runner.holds.map((hold) => hold.cause)).toEqual(["github_token"]);
    } finally {
      server.stop(true);
    }
  });

  test("doesn't start under stop, and says which hold stopped it", async () => {
    await world.stop();
    expect(await runTrial()).toEqual({ result: "held", cause: "stop" });
    expect(world.harness.started).toEqual([]);
  });

  test("doesn't start while others can read credentials.env", async () => {
    await world.credentialsMode(0o640);
    expect(await runTrial()).toEqual({ result: "held", cause: "credentials" });
    expect(world.harness.started).toEqual([]);
  });

  test("doesn't start under a Claude Code older than the minimum", async () => {
    world.harness.claudeCodeVersion = "2.0.5";
    expect(await runTrial()).toEqual({ result: "held", cause: "claude_code_version" });
    expect(world.harness.started).toEqual([]);
  });

  // `update`, `api_cap`, and `rate_limit` come from holds other tickets build, so the rule is checked on its own.
  test("the holds that stop a trial are exactly spec 1's six", () => {
    const stops: HoldCause[] = ["stop", "update", "credentials", "claude_code_version", "api_cap", "rate_limit"];
    const runs: HoldCause[] = ["maintainer", "plan_limit", "claude_login", "linear_token", "github_token", "linear_login", "missing_status", "team_unreadable", "shared_team"];
    expect([...TRIAL_STOPPED_BY].sort()).toEqual([...stops].sort());
    const hold = (cause: HoldCause) => ({ cause, scope: "runner" as const, name: null, since: "2026-11-10T09:00:00.000Z", until: null });
    for (const cause of stops) expect(trialStoppedBy([hold("maintainer"), hold(cause)])).toBe(cause);
    expect(trialStoppedBy(runs.map(hold))).toBeNull();
  });
});

describe("the cap", () => {
  test("a trial waits for a free place, says so once, then starts before any retry or take", async () => {
    world.config.concurrency_cap = 1;
    await world.writeConfig();
    const running = world.issue({ title: "Save button is blue" });
    world.send(running);
    await world.tick();
    expect(world.harness.started).toHaveLength(1);

    let waits = 0;
    let result: TrialResult | null = null;
    void world.poll.trial({ waiting: () => waits++ }).then((each) => (result = each));
    const queued = world.issue({ title: "Cancel button is green" });
    world.send(queued);
    await world.tick();
    await world.tick();
    expect(waits).toBe(1);
    expect(world.harness.started).toHaveLength(1);

    world.harness.script("", PASSES);
    world.harness.finish(world.harness.started[0]!.session.id, { kind: "exited", code: 1 });
    await world.tick();
    // The failed session's retry and the queued issue both wait behind the trial.
    expect(world.harness.started.map((each) => each.session.stage)).toEqual(["plan", "trial"]);
    expect((await world.status()).sessions.map((each) => [each.stage, each.state])).toEqual([
      ["plan", "retry_waiting"],
      ["trial", "running"],
    ]);
    await world.tick();
    expect(result).toMatchObject({ result: "passed" });
    expect(world.harness.started.map((each) => each.session.stage)).toEqual(["plan", "trial", "plan"]);
    expect(world.tracker.stored(queued.id).status).toBe("Ready to plan");
  });
});

describe("the test notification", () => {
  test("is posted the way trouble notifications are", async () => {
    expect(await world.poll.notify(TEST_NOTIFICATION)).toEqual({ ok: true });
    expect(await world.notifications()).toEqual(["Flight Deck can notify you."]);
  });
});

describe("a running trial", () => {
  test("stops under flight-deck stop, fails, and pauses nothing", async () => {
    let result: TrialResult | null = null;
    void world.poll.trial().then((each) => (result = each));
    await world.tick();
    const start = world.harness.started[0]!;
    await world.stop();
    expect(world.harness.stops).toEqual([start.session.id]);
    await world.tick();
    expect(result as TrialResult | null).toEqual({ result: "failed", session: start.session.id, exit: { kind: "stopped" } });
    expect(world.tracker.writes).toEqual([]);
    expect(existsSync(start.session.worktree)).toBe(false);
    expect((await world.status()).sessions).toEqual([]);
  });

  test("an earlier runner's trial goes at the next start, because no one waits for it", async () => {
    void world.poll.trial();
    await world.tick();
    const start = world.harness.started[0]!;
    world.restart();
    await world.tick();
    expect((await world.status()).sessions).toEqual([]);
    expect(existsSync(start.session.worktree)).toBe(false);
    expect(existsSync(start.session.sessionFolder)).toBe(false);
  });
});
