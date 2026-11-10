// The Harness contract suite's real half: the same assertions as `scripted.test.ts`, against real `claude -p`
// sessions that the Claude Code adapter starts, plus what only a real session shows (spec 1, "Suites", "The
// command line", "`settings.json`", "Session IDs", and "Watchdogs and exits"). It records what the version pins:
//
// - `socket_name_bytes` in `data/limits.toml`,
// - `login_expired_patterns` in `data/claude-code.toml`, from a session whose `CLAUDE_CODE_OAUTH_TOKEN` is revoked,
// - the parser's fixtures in `test/harness/fixtures/`: a real `rate_limit_event`, a rejected one or a `rate_limit`
//   error when a session hits a limit, the `result` of a run `--max-budget-usd` ended, and the login texts.
//
// It needs the maintainer's Claude Code login and Linear credentials, so it runs only with
// `FLIGHT_DECK_CONTRACT=harness` (or `1`): see `test/contract/README.md`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { macFolders, paths, sessionParts } from "../../../src/folders/index.ts";
import { ClaudeCodeHarness, LINEAR_READ_TOOLS, Stream, type HarnessSession } from "../../../src/harness/index.ts";
import { CLAUDE_CODE, exitOf, type ClaudeCodeData } from "../../../src/harness/stream.ts";
import { sandboxPolicy } from "../../../src/sandbox-policy/index.ts";
import { fixture } from "../../harness/fixtures.ts";
import { runs } from "../support/gate.ts";
import { openLinear, type RealLinear } from "../support/linear.ts";
import { CLAUDE_CODE_TOML, fits, LIMITS_TOML, loginExpiredPatterns, pinFile, recordFixture, socketNameBytes } from "../support/pin.ts";
import { probeRecord, Rig, until, which } from "../support/rig.ts";
import * as T from "../support/transcript.ts";
import { harnessContract, startRun } from "./contract.ts";

const RUNS = runs("harness");
const SESSION_MS = 10 * 60_000;
const REPO_ROOT = join(import.meta.dir, "../../../..");
const SANDBOX_RUNTIME_CLI = join(REPO_ROOT, "vendor/sandbox-runtime/node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js");
const FILES = { "README.md": "A scratch repo for the Flight Deck Harness contract suite.\n" };

let rig: Rig | null = null;
let harness: ClaudeCodeHarness | null = null;
let linear: RealLinear | null = null;
/** What this run recorded and pinned, printed at the end for the maintainer to commit. */
const recorded: string[] = [];
const kept: string[] = [];

async function open(): Promise<{ rig: Rig; harness: ClaudeCodeHarness }> {
  if (rig === null || harness === null) {
    linear = await openLinear();
    rig = await Rig.open({ real: true, claude: process.env.FLIGHT_DECK_CLAUDE ?? which("claude"), linear: { tracker: linear.runner, repo: linear.repo } });
    harness = new ClaudeCodeHarness({ claude: rig.claude });
  }
  return { rig, harness };
}

/** Resolves once the session's transcript holds its `init` event. */
async function initialized(session: HarnessSession): Promise<void> {
  await until(`${session.id}'s init event`, () => T.init(T.events(session.transcript)) !== null, 2 * 60_000);
}

afterAll(async () => {
  if (!RUNS) return;
  await harness?.close();
  await rig?.close();
  await linear?.runner.revokeRunnerToken(linear.repo.workspace);
  console.log(
    [
      "",
      "The Harness contract suite wrote:",
      ...(recorded.length === 0 ? ["  nothing"] : recorded.map((each) => `  ${each}`)),
      "and left these as they were:",
      ...(kept.length === 0 ? ["  nothing"] : kept.map((each) => `  ${each}`)),
      "Review the diff (git diff ../data test/harness/fixtures), then commit it. See test/contract/README.md.",
    ].join("\n"),
  );
}, 60_000);

harnessContract(
  "a real claude -p session",
  async () => {
    const { rig, harness } = await open();
    return {
      harness,
      async writes(text) {
        const made = await rig.prepare({
          files: FILES,
          prompt: (s) => `This is a Flight Deck contract test. Use the Write tool to write exactly this one line to ${join(sessionParts(s.sessionFolder).outbox, "summary.md")}:\n\n${text}\n\nThen stop. Do nothing else.`,
        });
        return made.session;
      },
      async waits() {
        return (await rig.prepare({ files: FILES, prompt: () => "This is a Flight Deck contract test. Run `sleep 600` with the Bash tool, in the foreground, and wait for it. Do nothing else." })).session;
      },
      running: initialized,
      // The rig and the adapter stay open for the real-only tests below, and close once the file ends.
      async close() {},
    };
  },
  { skip: !RUNS, timeout: SESSION_MS },
);

describe.skipIf(!RUNS)("what only a real claude -p session shows", () => {
  let r: Rig;
  let h: ClaudeCodeHarness;

  beforeAll(async () => {
    ({ rig: r, harness: h } = await open());
  }, 60_000);

  /** Runs a session to its end and returns its transcript's events. */
  async function run(made: { session: HarnessSession }) {
    const started = await startRun(h, made.session);
    const exit = await started.exit;
    return { exit, events: T.events(made.session.transcript), warnings: started.warnings };
  }

  test(
    "each allowed tool works under dontAsk, and the init event lists the plan command",
    async () => {
      const made = await r.prepare({ files: { ...FILES, "notes.txt": "The word contract is in this file.\n" }, prompt: toolsPrompt });
      await Bun.write(join(made.prepared.deps, "contract.txt"), "A file in deps/.\n");
      const { exit, events } = await run(made);
      expect(exit.kind).toBe("exited");

      const first = T.init(events);
      expect(first).not.toBeNull();
      expect(first!.permissionMode).toBe("dontAsk");
      expect(first!.slash_commands).toContain("flight-deck:flight-plan");
      await recordFixture("init.json", T.lines(made.session.transcript).find((line) => line.includes('"subtype":"init"'))!);
      recorded.push("test/harness/fixtures/init.json, from this Claude Code version");

      const uses = T.toolUses(events);
      const denied = new Set(T.denials(events).map((each) => each.tool_use_id));
      const used = (names: string[]) => uses.filter((each) => names.includes(each.name));
      const expected: [string, string[]][] = [
        ["Bash", ["Bash"]],
        ["Read", ["Read"]],
        ["Glob", ["Glob"]],
        ["Grep", ["Grep"]],
        ["Edit", ["Edit"]],
        ["Write", ["Write"]],
        ["TodoWrite", ["TodoWrite"]],
        ["WebSearch", ["WebSearch"]],
        ["WebFetch", ["WebFetch"]],
        ["Agent", ["Agent", "Task"]],
        ["TaskStop", ["TaskStop", "KillShell"]],
        ["mcp__linear__list_teams", ["mcp__linear__list_teams"]],
      ];
      const problems = expected.flatMap(([label, names]) => {
        const calls = used(names);
        if (calls.length === 0) return [`the session never called ${label}`];
        return calls.filter((call) => denied.has(call.id)).map((call) => `${label} was denied: ${JSON.stringify(call.input)}`);
      });
      expect(problems).toEqual([]);
      expect(T.denials(events)).toEqual([]);

      // The list is closed on purpose: a read tool it lacks is reported, and adding one is a spec change.
      const reads = (first!.tools as string[]).filter((tool) => /^mcp__linear__(get|list|search|extract)_/.test(tool)).map((tool) => tool.slice("mcp__linear__".length));
      const missing = reads.filter((tool) => !(LINEAR_READ_TOOLS as readonly string[]).includes(tool));
      console.log(missing.length === 0 ? "Every Linear read tool the server lists is in the allow list." : `Linear read tools the allow list doesn't hold (a spec change adds one): ${missing.join(", ")}`);
    },
    SESSION_MS,
  );

  test(
    "socket_name_bytes: the longest socket name Claude Code's sandbox and sandbox-runtime make in the temp folder",
    async () => {
      const made = await r.prepare({ files: FILES, prompt: () => "This is a Flight Deck contract test. Run `curl -sS -o /dev/null https://registry.npmjs.org/` with the Bash tool, then run `sleep 20` with the Bash tool in the foreground. Then stop." });
      const tmp = made.prepared.tmp;
      const seen = new Set<string>();
      const started = await startRun(h, made.session);
      let done = false;
      void started.exit.then(() => (done = true));
      while (!done) {
        for (const socket of await T.socketsUnder(tmp)) seen.add(socket);
        await Bun.sleep(100);
      }
      const claudeCode = [...seen];
      console.log(`Sockets Claude Code's sandbox made under ${tmp}:\n  ${claudeCode.join("\n  ") || "none"}`);

      if (!existsSync(SANDBOX_RUNTIME_CLI)) throw new Error(`${SANDBOX_RUNTIME_CLI} is missing. Run bun install --frozen-lockfile in vendor/sandbox-runtime (FLD-99), then run this suite again.`);
      const runtime = await sandboxRuntimeSockets(r, made);
      console.log(`Sockets sandbox-runtime made under ${tmp}:\n  ${runtime.join("\n  ") || "none"}`);

      const bytes = socketNameBytes(tmp, [...claudeCode, ...runtime]);
      // Any session's temp folder on this Mac: the session root, a 6-character session ID, and `tmp`.
      const longest = sessionParts(paths.sessionFolder(macFolders(), "xxxxxx")).tmp;
      if (!fits(longest, bytes)) {
        throw new Error(`socket_name_bytes is ${bytes}, and ${longest} plus / plus ${bytes} passes 103 bytes. The spec has a bug: stop and ask the maintainer. Nothing was pinned.`);
      }
      await pinFile(LIMITS_TOML, "socket_name_bytes", bytes, [
        "The longest socket file name that Claude Code's sandbox and sandbox-runtime create in a session's temp folder, as",
        "a path after `tmp/`, with each run of 3 or more digits counted as 5, because it may be a process ID that grows.",
        "Workspace fails `prepare` when the temp folder's path, plus `/`, plus this many bytes passes 103 bytes.",
        `Measured by the Harness contract suite on ${today()}, with Claude Code ${await h.version()} (spec 1, "Session IDs").`,
      ]);
      recorded.push(`data/limits.toml: socket_name_bytes = ${bytes}`);
    },
    SESSION_MS,
  );

  test(
    "login_expired_patterns: the text a session with a revoked CLAUDE_CODE_OAUTH_TOKEN ends with",
    async () => {
      const token = process.env.FLIGHT_DECK_REVOKED_OAUTH_TOKEN;
      if (token === undefined || token === "") {
        throw new Error("Set FLIGHT_DECK_REVOKED_OAUTH_TOKEN to a Claude Code OAuth token you revoked, then run this suite again. test/contract/README.md says how to make one.");
      }
      const made = await r.prepare({ files: FILES, prompt: () => "This is a Flight Deck contract test. Say hello, then stop.", environment: { CLAUDE_CODE_OAUTH_TOKEN: token } });
      const { exit, events } = await run(made);
      const lines = T.lines(made.session.transcript);
      const result = lines.find((line) => /"type":"result"/.test(line) && /"is_error":true/.test(line));
      const assistant = lines.find((line) => /"type":"assistant"/.test(line) && /"error":"/.test(line));
      if (result === undefined && assistant === undefined) {
        const stderr = existsSync(made.stderr) ? readFileSync(made.stderr, "utf8").trim() : "";
        throw new Error(`The session ended ${exit.kind} with no error in its transcript (${made.session.transcript}). Check that the token is revoked. Claude Code's stderr: ${stderr || "empty"}`);
      }

      const texts: string[] = [];
      if (result !== undefined) {
        const event = JSON.parse(result) as { result?: unknown; errors?: unknown };
        if (typeof event.result === "string") texts.push(event.result);
        if (Array.isArray(event.errors)) texts.push(...event.errors.filter((each): each is string => typeof each === "string"));
      }
      if (assistant !== undefined) texts.push(...T.said([JSON.parse(assistant) as T.Event]).split("\n"));
      const patterns = loginExpiredPatterns(texts);

      // The new patterns must read this session as login_expired, and a session that worked as something else.
      const data: ClaudeCodeData = { ...CLAUDE_CODE, loginExpiredPatterns: patterns.map((each) => new RegExp(each)) };
      const stream = new Stream(data);
      for (const line of lines) stream.line(line);
      expect(exitOf({ stopped: false, noInit: false, timedOut: false, code: 1 }, stream.facts)).toEqual({ kind: "login_expired" });
      const worked = new Stream(data);
      worked.line(fixture("result.success.json"));
      expect(worked.facts.loginExpired).toBe(false);

      await pinFile(CLAUDE_CODE_TOML, "login_expired_patterns", patterns, [
        "Recorded by the Harness contract suite from a session with a revoked CLAUDE_CODE_OAUTH_TOKEN, on",
        `${today()} with Claude Code ${await h.version()}. Each entry is a JavaScript regular expression. A \`result\` event with`,
        "`is_error`, or an `assistant` message with an `error`, that matches one ends the session with `login_expired` (ADR 0005).",
      ]);
      recorded.push(`data/claude-code.toml: login_expired_patterns = ${JSON.stringify(patterns)} (the adapter read this session as ${exit.kind} before the pin)`);
      if (result !== undefined) {
        await recordFixture("result.login-expired.json", result);
        recorded.push("test/harness/fixtures/result.login-expired.json");
      } else kept.push("placeholder.result.login-expired.json: the session's result had no error");
      if (assistant !== undefined) {
        await recordFixture("assistant.login-expired.json", assistant);
        recorded.push("test/harness/fixtures/assistant.login-expired.json");
      } else kept.push("placeholder.assistant.login-expired.json: no assistant message carried an error");
      expect(events.length).toBeGreaterThan(0);
    },
    SESSION_MS,
  );

  test(
    "a run that --max-budget-usd ends exits with an error and no handoff",
    async () => {
      const made = await r.prepare({
        files: FILES,
        args: ["--max-budget-usd", "0.01"],
        prompt: (s) => `This is a Flight Deck contract test. Read every file under ${join(s.versionFolder, "plugin")} one at a time, and after each one write a paragraph about it. Then stop.`,
      });
      const { exit } = await run(made);
      const line = T.lines(made.session.transcript).find((each) => /"type":"result"/.test(each));
      expect(line).toBeDefined();
      const result = JSON.parse(line!) as { is_error?: boolean; subtype?: string };
      expect(result.is_error).toBe(true);
      expect(exit.kind).toBe("exited");
      expect(exit.error).toBeDefined();
      await recordFixture("result.max-budget.json", line!);
      recorded.push(`test/harness/fixtures/result.max-budget.json (subtype ${result.subtype}, exit ${JSON.stringify(exit)})`);
    },
    SESSION_MS,
  );

  test(
    "the rate_limit_event, any rejected one or rate_limit error, and any login-expiring warning, from every session this run",
    async () => {
      const transcripts = r.sessions.map((made) => made.session.transcript);
      const all = transcripts.flatMap((each) => T.lines(each));
      const event = (line: string) => JSON.parse(line) as T.Event;

      const allowed = all.filter((line) => /"type":"rate_limit_event"/.test(line) && event(line).rate_limit_info?.status === "allowed").at(-1);
      if (allowed !== undefined) {
        await recordFixture("rate-limit-event.allowed.json", allowed);
        recorded.push("test/harness/fixtures/rate-limit-event.allowed.json");
      } else kept.push("rate-limit-event.allowed.json: no session reported one (an API key reports none)");

      const rejected = all.find((line) => /"type":"rate_limit_event"/.test(line) && event(line).rate_limit_info?.status === "rejected");
      if (rejected !== undefined) {
        await recordFixture("rate-limit-event.rejected.json", rejected);
        recorded.push("test/harness/fixtures/rate-limit-event.rejected.json");
      } else kept.push("placeholder.rate-limit-event.rejected.json: no session hit a plan limit");
      const limitError = all.find((line) => /"type":"assistant"/.test(line) && event(line).error === "rate_limit");
      if (limitError !== undefined) {
        await recordFixture("assistant.rate-limit-error.json", limitError);
        recorded.push("test/harness/fixtures/assistant.rate-limit-error.json");
      } else kept.push("placeholder.assistant.rate-limit-error.json: no session hit a plan limit");

      // The warning's text isn't known until Claude Code prints it, so this looks for any line about the login.
      const about = /log ?in|expir|re-?auth|oauth/i;
      const stderr = r.sessions.flatMap((made) => (existsSync(made.stderr) ? readFileSync(made.stderr, "utf8").split("\n") : [])).filter((line) => about.test(line));
      const system = all.filter((line) => /"type":"system"/.test(line) && !/"subtype":"init"/.test(line) && about.test(line));
      const warning = [...stderr, ...system].find((line) => !/revoked|401|authentication_error/i.test(line));
      if (warning !== undefined) {
        await recordFixture("stderr.login-expiring.txt", warning);
        const pattern = loginExpiredPatterns([warning]);
        await pinFile(CLAUDE_CODE_TOML, "login_expiring_patterns", pattern, [
          `Recorded by the Harness contract suite on ${today()} with Claude Code ${await h.version()}. Check it is the`,
          "login-expiring warning before you commit it. Each entry is a JavaScript regular expression, matched against each",
          "line of stderr and each `system` event other than `init`. A match reports `login_expiring`, which opens the trouble",
          "cause `claude_login_soon` (ADR 0005).",
        ]);
        recorded.push(`test/harness/fixtures/stderr.login-expiring.txt and data/claude-code.toml: login_expiring_patterns = ${JSON.stringify(pattern)}. Check this line is the warning: ${warning}`);
      } else kept.push("placeholder.stderr.login-expiring.txt: Claude Code printed no login-expiring warning this run. Run the suite again when it warns.");
    },
    60_000,
  );
});

/** Runs `sleep` under the pinned sandbox-runtime as a cache refresh runs its install, and returns the sockets it made. */
async function sandboxRuntimeSockets(r: Rig, made: { prepared: { tmp: string; worktree: string; sessionFolder: string; env: Record<string, string> }; registration: { name: string } }): Promise<string[]> {
  const settings = join(made.prepared.sessionFolder, "sandbox-runtime.json");
  const policy = sandboxPolicy({ kind: "refresh", folders: r.folders, repo: made.registration.name, record: probeRecord(), versionFolder: r.versionFolder, worktree: made.prepared.worktree, sessionFolder: made.prepared.sessionFolder });
  await Bun.write(settings, `${JSON.stringify(policy, null, 2)}\n`);
  const child = Bun.spawn([process.execPath, SANDBOX_RUNTIME_CLI, "--settings", settings, "-c", "curl -sS -o /dev/null https://registry.npmjs.org/; sleep 5"], {
    cwd: made.prepared.worktree,
    env: { HOME: r.folders.home, USER: process.env.USER ?? "", LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "", SHELL: "/bin/bash", ...made.prepared.env },
    stdout: "inherit",
    stderr: "inherit",
  });
  const seen = new Set<string>();
  let done = false;
  void child.exited.then(() => (done = true));
  while (!done) {
    for (const socket of await T.socketsUnder(made.prepared.tmp)) seen.add(socket);
    await Bun.sleep(100);
  }
  return [...seen];
}

/** Today's date, `2026-11-10`. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The tools prompt: one step per allowed tool, so the transcript shows each call and whether permissions denied it. */
function toolsPrompt(s: HarnessSession): string {
  const parts = sessionParts(s.sessionFolder);
  return [
    "This is a Flight Deck contract test of the tools a session may use. Do each step in order, then stop. If a step fails, go on to the next one. Don't ask for permission.",
    "",
    "1. Run `true` with the Bash tool.",
    `2. Read ${join(s.worktree, "README.md")} with the Read tool.`,
    `3. Find README.md under ${s.worktree} with the Glob tool. Then search ${s.worktree} for the word "contract" with the Grep tool.`,
    `4. Add the line "Edited by the contract suite." to the end of ${join(s.worktree, "README.md")} with the Edit tool.`,
    `5. Read ${join(parts.deps, "contract.txt")} with the Read tool.`,
    `6. Write the word "tools" to ${join(parts.outbox, "tools.md")} with the Write tool.`,
    `7. Read ${join(parts.inbox, "synced-comments.json")}, ${s.sessionJson}, ${join(s.versionFolder, "skills", "brief", "SKILL.md")}, and ${join(s.versionFolder, "plugin", "shared", "session.md")} with the Read tool.`,
    "8. Make a todo list of two items with the TodoWrite tool.",
    '9. Search the web for "Linear GraphQL API" with the WebSearch tool.',
    "10. Fetch https://developer.mozilla.org/ with the WebFetch tool.",
    "11. Start one subagent with the Agent tool. Its task: run `true` with the Bash tool and report back.",
    "12. Start `sleep 120` with the Bash tool in the background. Then stop that background task with the TaskStop tool.",
    "13. List the Linear teams with the mcp__linear__list_teams tool.",
  ].join("\n");
}
