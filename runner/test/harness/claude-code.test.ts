// The Claude Code adapter, against a stand-in `claude` that each test writes: a bash script that prints recorded
// stream lines, hangs, ignores SIGTERM, or leaves a process behind. No test starts a real `claude -p` session:
// the Harness contract suite does that on the maintainer's Mac (FLD-116). The tests shorten the 2-minute `init`
// watchdog and the 10 seconds between SIGTERM and SIGKILL.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths, sessionParts, type Folders } from "../../src/folders/index.ts";
import { buildLaunch, ClaudeCodeHarness, processStartedAt, type ClaudeCodeOptions, type Exit, type Handle, type HarnessSession, type RateLimitEvent } from "../../src/harness/index.ts";
import { readRecord } from "../../src/record/index.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const INIT = join(FIXTURES, "init.json");
const RESULT = join(FIXTURES, "result.success.json");
const RATE_LIMIT = join(FIXTURES, "rate-limit-event.allowed.json");
const SHADERS = readRecord(await readFile(join(import.meta.dir, "../record/fixtures/shaders.toml"), "utf8"));
if (!SHADERS.ok) throw new Error("the Shaders fixture doesn't parse");

let root: string;
let folders: Folders;
let versionFolder: string;
let harness: ClaudeCodeHarness | null;
/** Processes a test may leave running, each with its start time, so a reused process ID is never killed. */
const strays: { pid: number; startedAt: string | null }[] = [];

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "flight-deck-claude-")));
  folders = { data: join(root, "data"), config: join(root, "config"), sessionRoot: join(root, "shared"), home: join(root, "home") };
  versionFolder = join(folders.data, "versions", "0.1.0");
  for (const folder of [folders.config, folders.home, join(root, "bin"), join(versionFolder, "plugin")]) await mkdir(folder, { recursive: true });
  harness = null;
});

afterEach(async () => {
  // A failed test may leave its stand-in running.
  for (const { pid, startedAt } of strays.splice(0)) if (startedAt !== null && processStartedAt(pid) === startedAt) kill(pid);
  await harness?.close();
  await rm(root, { recursive: true, force: true });
});

function stray(pid: number): void {
  strays.push({ pid, startedAt: processStartedAt(pid) });
}

function kill(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {}
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Writes the stand-in `claude`. `body` runs after it records its arguments, folder, and environment. */
async function fakeClaude(body: string): Promise<string> {
  const path = join(root, "bin", "claude");
  await writeFile(
    path,
    `#!/bin/bash
if [ "$1" = "--version" ]; then echo "2.1.321 (Claude Code)"; exit 0; fi
printf '%s\\n' "$@" > ${root}/args
pwd -P > ${root}/cwd
env > ${root}/env
${body}
`,
  );
  await chmod(path, 0o755);
  return path;
}

/** Writes a stand-in `caffeinate` that records its arguments and process ID, then waits to be killed. */
async function fakeCaffeinate(): Promise<string> {
  const path = join(root, "bin", "caffeinate");
  await writeFile(path, `#!/bin/bash\necho "$$ $*" >> ${root}/caffeinate\nexec /bin/sleep 600\n`);
  await chmod(path, 0o755);
  return path;
}

async function makeHarness(claude: string, options: Partial<ClaudeCodeOptions> = {}): Promise<ClaudeCodeHarness> {
  harness = new ClaudeCodeHarness({ claude, caffeinate: await fakeCaffeinate(), initTimeoutMs: 5_000, killAfterMs: 400, ...options });
  return harness;
}

/** A prepared session, as Poll hands it over: a worktree, a session folder, and a launch. */
async function makeSession(id: string, options: { deadline?: Date } = {}): Promise<HarnessSession> {
  const worktree = paths.worktree(folders, id);
  const sessionFolder = paths.sessionFolder(folders, id);
  const parts = sessionParts(sessionFolder);
  for (const folder of [worktree, parts.inbox, parts.outbox, parts.tmp, parts.deps]) await mkdir(folder, { recursive: true });
  await writeFile(parts.sessionJson, `${JSON.stringify({ session: id, agents_md: null })}\n`);
  if (!SHADERS.ok) throw new Error("unreachable");
  const launch = await buildLaunch({
    folders,
    id,
    stage: "plan",
    repo: "campdotdev/shaders",
    issue: "SHA-12",
    worktree,
    sessionFolder,
    record: SHADERS.record,
    env: { PATH: "/usr/bin:/bin" },
    model: "",
    auth: { kind: "subscription" },
    versionFolder,
    environment: { USER: "maintainer", LOGNAME: "maintainer" },
  });
  return {
    id,
    stage: "plan",
    mode: "issue",
    repo: "campdotdev/shaders",
    issue: "SHA-12",
    worktree,
    sessionFolder,
    sessionJson: parts.sessionJson,
    transcript: paths.transcript(folders, "campdotdev/shaders", id),
    deadline: (options.deadline ?? new Date(Date.now() + 60 * 60 * 1000)).toISOString(),
    model: "",
    versionFolder,
    launch,
  };
}

interface Started {
  session: HarnessSession;
  handle: Handle;
  exit: Promise<Exit>;
  /** When the exit came, in ms since the epoch. */
  exitedAt: () => number;
  rateLimits: { event: RateLimitEvent; beforeExit: boolean }[];
  warnings: string[];
}

async function start(h: ClaudeCodeHarness, id: string, options: { deadline?: Date } = {}): Promise<Started> {
  const session = await makeSession(id, options);
  let resolve!: (exit: Exit) => void;
  const exit = new Promise<Exit>((done) => (resolve = done));
  let exitedAt = 0;
  let ended = false;
  const rateLimits: Started["rateLimits"] = [];
  const warnings: string[] = [];
  const handle = await h.start(session, {
    exit: (each) => {
      ended = true;
      exitedAt = Date.now();
      resolve(each);
    },
    rateLimit: (event) => rateLimits.push({ event, beforeExit: !ended }),
    loginExpiring: (warning) => warnings.push(warning),
  });
  stray(handle.pid);
  return { session, handle, exit, exitedAt: () => exitedAt, rateLimits, warnings };
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await Bun.sleep(20);
  }
}

describe("a session that runs to its end", () => {
  test("runs the launch's command line from the worktree with exactly the launch's environment", async () => {
    const h = await makeHarness(await fakeClaude(`cat ${INIT}; cat ${RESULT}`));
    const run = await start(h, "a1b2c3");
    expect(await run.exit).toEqual({ kind: "exited", code: 0, transcript: run.session.transcript, claudeCodeVersion: "2.1.321", costUsd: 2.0853960000000002 });

    const args = (await readFile(join(root, "args"), "utf8")).split("\n").slice(0, -1);
    expect(args).toEqual(run.session.launch.args);
    expect(args.slice(0, 2)).toEqual(["-p", "/flight-deck:flight-plan SHA-12"]);
    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe(run.handle.uuid);
    expect(args).not.toContain("--worktree");
    expect((await readFile(join(root, "cwd"), "utf8")).trim()).toBe(run.session.worktree);

    // bash adds PWD, SHLVL, and _ itself.
    const env = Object.fromEntries(
      (await readFile(join(root, "env"), "utf8"))
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    for (const name of ["PWD", "SHLVL", "_", "OLDPWD"]) delete env[name];
    expect(env).toEqual(run.session.launch.environment);
    expect(env.CLAUDE_CODE_RETRY_WATCHDOG).toBeUndefined();
  });

  test("carries the result event's total_cost_usd as the exit's cost", async () => {
    const h = await makeHarness(await fakeClaude(`cat ${INIT}; cat ${RESULT}`));
    expect((await (await start(h, "c0s7a1")).exit).costUsd).toBe(2.0853960000000002);
  });

  test("gives no cost when the session sent no result event", async () => {
    const h = await makeHarness(await fakeClaude(`cat ${INIT}; exit 1`));
    expect(await (await start(h, "c0s7b2")).exit).not.toHaveProperty("costUsd");
  });

  test("passes --plugin-dir with the exact version folder, never current", async () => {
    const h = await makeHarness(await fakeClaude(`cat ${INIT}`));
    const run = await start(h, "d4e5f6");
    await run.exit;
    const args = (await readFile(join(root, "args"), "utf8")).split("\n");
    expect(args[args.indexOf("--plugin-dir") + 1]).toBe(join(versionFolder, "plugin"));
    expect(args.some((arg) => arg.includes("/current"))).toBe(false);
  });

  test("writes settings.json and mcp.json before claude starts, the transcript, and the UUID beside it", async () => {
    const h = await makeHarness(await fakeClaude(`test -f ${paths.sessionFolder(folders, "g7h8i9")}/settings.json || exit 9; cat ${INIT}; cat ${RESULT}`));
    const run = await start(h, "g7h8i9");
    await run.exit;
    const parts = sessionParts(run.session.sessionFolder);
    expect(JSON.parse(await readFile(parts.settingsJson, "utf8"))).toEqual(run.session.launch.settings);
    expect(JSON.parse(await readFile(parts.mcpJson, "utf8"))).toEqual(run.session.launch.mcp);
    expect(await readFile(run.session.transcript, "utf8")).toBe(`${await readFile(INIT, "utf8")}${await readFile(RESULT, "utf8")}`);
    expect(run.session.transcript).toBe(join(folders.data, "repos/campdotdev/shaders/transcripts/g7h8i9.jsonl"));
    expect(await readFile(join(folders.data, "repos/campdotdev/shaders/transcripts/g7h8i9.uuid"), "utf8")).toBe(`${run.handle.uuid}\n`);
  });

  test("writes exit.json in the session folder before it reports the exit", async () => {
    const h = await makeHarness(await fakeClaude(`cat ${INIT}; exit 3`));
    const session = await makeSession("j1k2l3");
    let seen: unknown = null;
    await new Promise<void>((done) => {
      void h.start(session, {
        exit: (exit) => {
          seen = JSON.parse(readFileSync(join(session.sessionFolder, "exit.json"), "utf8"));
          expect(seen).toMatchObject(exit);
          done();
        },
        rateLimit: () => {},
      });
    });
    expect(seen).toMatchObject({ kind: "exited", code: 3, transcript: session.transcript, claudeCodeVersion: "2.1.321" });
  });

  test("reports each rate_limit_event while the session runs", async () => {
    const h = await makeHarness(await fakeClaude(`cat ${INIT}; cat ${RATE_LIMIT}; sleep 0.3; cat ${RESULT}`));
    const run = await start(h, "m4n5o6");
    await run.exit;
    expect(run.rateLimits).toEqual([
      {
        beforeExit: true,
        event: expect.objectContaining({ status: "allowed", type: "five_hour", resetsAt: "2026-10-24T06:30:00.000Z" }),
      },
    ]);
  });

  test("reports the login-expiring warning from stderr", async () => {
    const warning = (await readFile(join(FIXTURES, "placeholder.stderr.login-expiring.txt"), "utf8")).trimEnd();
    const h = await makeHarness(await fakeClaude(`cat ${INIT}; echo '${warning}' >&2; cat ${RESULT}`));
    const run = await start(h, "p7q8r9");
    expect((await run.exit).kind).toBe("exited");
    expect(run.warnings).toEqual([warning]);
  });

  test("a stream that hit a plan limit ends rate_limited", async () => {
    const h = await makeHarness(await fakeClaude(`cat ${INIT}; cat ${join(FIXTURES, "placeholder.rate-limit-event.rejected.json")}; exit 1`));
    const run = await start(h, "s1t2u3");
    expect(await run.exit).toMatchObject({ kind: "rate_limited", resetsAt: "2026-10-24T06:30:00.000Z" });
  });

  test("a revoked login ends login_expired", async () => {
    const h = await makeHarness(await fakeClaude(`cat ${INIT}; cat ${join(FIXTURES, "placeholder.result.login-expired.json")}; exit 1`));
    const run = await start(h, "v4w5x6");
    expect(await run.exit).toMatchObject({ kind: "login_expired" });
  });
});

describe("the watchdogs", () => {
  // Each stand-in logs every SIGTERM it gets and keeps running, so only SIGKILL ends it.
  const ignoreTerm = `trap 'echo TERM >> ${"$ROOT"}/signals' TERM; while true; do sleep 0.05; done`;
  const script = (before: string) => `ROOT=${root}; ${before}; ${ignoreTerm}`;

  test("no init within the watchdog: SIGKILL, with no SIGTERM first", async () => {
    const h = await makeHarness(await fakeClaude(script("true")), { initTimeoutMs: 300, killAfterMs: 5_000 });
    const begun = Date.now();
    const run = await start(h, "nina01");
    expect(await run.exit).toMatchObject({ kind: "no_init" });
    expect(run.exitedAt() - begun).toBeGreaterThanOrEqual(300);
    // Far short of the SIGTERM wait.
    expect(run.exitedAt() - begun).toBeLessThan(2_000);
    expect(existsSync(join(root, "signals"))).toBe(false);
  });

  test("an init in time disarms it", async () => {
    const h = await makeHarness(await fakeClaude(`cat ${INIT}; sleep 0.5; cat ${RESULT}`), { initTimeoutMs: 200 });
    const run = await start(h, "nina02");
    expect(await run.exit).toMatchObject({ kind: "exited", code: 0 });
  });

  test("timed_out at the deadline: SIGTERM, then SIGKILL after the wait", async () => {
    const h = await makeHarness(await fakeClaude(script(`cat ${INIT}`)), { killAfterMs: 500 });
    const deadline = new Date(Date.now() + 300);
    const run = await start(h, "tout01", { deadline });
    expect(await run.exit).toMatchObject({ kind: "timed_out" });
    expect(await readFile(join(root, "signals"), "utf8")).toBe("TERM\n");
    expect(run.exitedAt() - deadline.getTime()).toBeGreaterThanOrEqual(500);
  });

  test("stopped on request: SIGTERM, then SIGKILL after the wait", async () => {
    const h = await makeHarness(await fakeClaude(script(`cat ${INIT}`)), { killAfterMs: 500 });
    const run = await start(h, "stop01");
    await waitFor(async () => existsSync(run.session.transcript) && (await readFile(run.session.transcript, "utf8")).length > 0);
    const asked = Date.now();
    await h.stop(run.handle);
    expect(await run.exit).toMatchObject({ kind: "stopped" });
    expect(await readFile(join(root, "signals"), "utf8")).toBe("TERM\n");
    expect(run.exitedAt() - asked).toBeGreaterThanOrEqual(500);
  });

  test("a session that ends on SIGTERM needs no SIGKILL", async () => {
    const h = await makeHarness(await fakeClaude(`cat ${INIT}; trap 'exit 143' TERM; while true; do sleep 0.05; done`), { killAfterMs: 5_000 });
    const run = await start(h, "stop02");
    await waitFor(async () => (await readFile(run.session.transcript, "utf8")).length > 0);
    const asked = Date.now();
    await h.stop(run.handle);
    expect(await run.exit).toMatchObject({ kind: "stopped" });
    expect(run.exitedAt() - asked).toBeLessThan(2_000);
  });

  test("a stop before init wins over no_init", async () => {
    const h = await makeHarness(await fakeClaude(script("true")), { initTimeoutMs: 300, killAfterMs: 100 });
    const run = await start(h, "stop03");
    await h.stop(run.handle);
    expect(await run.exit).toMatchObject({ kind: "stopped" });
  });
});

describe("clean-up at every end", () => {
  test("kills the process group of a background process left in the worktree or deps/", async () => {
    const h = await makeHarness(
      await fakeClaude(`set -m
sleep 300 &
echo $! > ${root}/worktree-pid
(cd ../../sessions/kill01/deps && exec sleep 300) &
echo $! > ${root}/deps-pid
cat ${INIT}`),
    );
    // A process outside both folders stays.
    const outside = Bun.spawn(["/bin/sleep", "300"], { cwd: root });
    stray(outside.pid);
    const run = await start(h, "kill01");
    await run.exit;
    const worktreePid = Number((await readFile(join(root, "worktree-pid"), "utf8")).trim());
    const depsPid = Number((await readFile(join(root, "deps-pid"), "utf8")).trim());
    stray(worktreePid);
    stray(depsPid);
    await waitFor(() => !alive(worktreePid) && !alive(depsPid));
    expect(alive(outside.pid)).toBe(true);
  });

  test("holds caffeinate -i while any session runs, and lets it go after the last one ends", async () => {
    const h = await makeHarness(await fakeClaude(`cat ${INIT}; trap 'exit 143' TERM; while true; do sleep 0.05; done`));
    const one = await start(h, "caf001");
    const two = await start(h, "caf002");
    await waitFor(() => existsSync(join(root, "caffeinate")));
    await Bun.sleep(100);
    const lines = (await readFile(join(root, "caffeinate"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    const [pid, ...args] = lines[0]!.split(" ");
    expect(args).toEqual(["-i", "-w", String(process.pid)]);
    expect(alive(Number(pid))).toBe(true);

    await h.stop(one.handle);
    await one.exit;
    expect(alive(Number(pid))).toBe(true);
    await h.stop(two.handle);
    await two.exit;
    await waitFor(() => !alive(Number(pid)));
  });
});

describe("version()", () => {
  test("returns the installed Claude Code version", async () => {
    const h = await makeHarness(await fakeClaude("true"));
    expect(await h.version()).toBe("2.1.321");
  });
});

describe("the handle", () => {
  test("names the process and its start time, so a reused process ID never matches", async () => {
    const h = await makeHarness(await fakeClaude(`cat ${INIT}; trap 'exit 143' TERM; while true; do sleep 0.05; done`));
    const run = await start(h, "hand01");
    expect(alive(run.handle.pid)).toBe(true);
    const lstart = Bun.spawnSync(["/bin/ps", "-o", "lstart=", "-p", String(run.handle.pid)]).stdout.toString().trim();
    expect(run.handle.pidStartedAt).toBe(new Date(lstart).toISOString());
    await h.stop(run.handle);
    await run.exit;
  });
});
