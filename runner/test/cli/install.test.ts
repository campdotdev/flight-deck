// `flight-deck install` (spec 1, "Install", ADRs 0005, 0015, and 0024): from a local build, it copies the version
// in, then runs its 8 steps in order, skipping each one whose result exists, and stops with the fix when one fails.
// Its file writes run against a temporary root. `launchctl`, `gh`, `claude`, and `open` are a scripted stand-in,
// and a stand-in runner answers `runner.sock`, so nothing here loads an agent, signs in, or registers a plugin.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Folders } from "../../src/folders/index.ts";
import { TEST_NOTIFICATION } from "../../src/poll/index.ts";
import { listen, type Listening, type Reply, type Request } from "../../src/socket/index.ts";
import { InMemoryTracker } from "../../src/tracker/index.ts";
import { cliAt, type Cli } from "./cli.ts";
import { FakeShell } from "./shell.ts";

const VERSION = "0.1.0-dev.20261110T090000Z";
const TOKEN = "ghp_machineusertoken";
const START = new Date("2026-11-10T09:00:00Z");

let root: string;
let folders: Folders;
let out: string;
let tools: { claude: string; git: string; gh: string };
let now: Date;
let shell: FakeShell;
let socket: Listening | null;
/** What the stand-in runner was asked over its socket, in order. */
let requests: Request[];
/** How the stand-in runner answers a trial. */
let trial: (request: Request) => Promise<Reply>;
/** What the stand-in Mac knows: the agent, the plugin, and the marketplace. */
let mac: { loaded: boolean; polls: boolean; plugin: boolean; marketplace: boolean };
let versions: Record<"claude" | "git" | "gh", string>;

const plist = () => join(folders.home, "Library/LaunchAgents/dev.campdotdev.flight-deck.plist");
const launchctl = (...args: string[]) => ["/bin/launchctl", ...args];

beforeEach(async () => {
  // Under /tmp, because macOS caps a socket's path at 104 bytes.
  root = await mkdtemp("/tmp/fd-install-");
  folders = { data: join(root, "data"), config: join(root, "config"), sessionRoot: join(root, "sessions"), home: join(root, "home") };
  out = await build(join(root, "out"), VERSION);
  await mkdir(join(root, "tools"));
  tools = { claude: join(root, "tools/claude"), git: join(root, "tools/git"), gh: join(root, "tools/gh") };
  for (const path of Object.values(tools)) await writeFile(path, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  now = START;
  versions = { claude: "2.1.321 (Claude Code)", git: "git version 2.55.0", gh: "gh version 2.102.0 (2026-10-01)\nhttps://github.com/cli/cli/releases/tag/v2.102.0" };
  mac = { loaded: false, polls: true, plugin: false, marketplace: false };
  requests = [];
  trial = async () => {
    await writeFile(join(folders.data, "state/trial.json"), JSON.stringify({ version: VERSION, claude_code_version: "2.1.321", session: "tr1a1s", passed_at: now.toISOString() }));
    return { ok: true, result: "passed", session: "tr1a1s", exit: "exited" };
  };
  socket = null;
  shell = new FakeShell();
  shell.onSleep = (ms) => void (now = new Date(now.getTime() + ms));
  for (const name of ["claude", "git", "gh"] as const) shell.on([tools[name], "--version"], () => ({ stdout: `${versions[name]}\n` }));
  shell
    .on([tools.gh, "api", "user", "-i"], () => ({ stdout: `HTTP/2.0 200 OK\r\nX-Oauth-Scopes: repo, read:org\r\n\r\n${JSON.stringify({ login: "fd-bot", id: 123456, name: "Flight Deck Bot" })}` }))
    .on([tools.gh, "api", "user", "--jq", ".login"], { stdout: "hunterbecton\n" })
    .on([tools.gh, "auth", "login"], {})
    .on([tools.claude, "plugin", "list"], () => ({ stdout: mac.plugin ? "Installed plugins:\n\n  ❯ flight-deck@flight-deck\n    Scope: user\n" : "No plugins installed.\n" }))
    .on([tools.claude, "plugin", "marketplace", "list"], () => ({ stdout: mac.marketplace ? "  ❯ flight-deck\n" : "No marketplaces configured\n" }))
    .on([tools.claude, "plugin", "marketplace", "add"], () => {
      mac.marketplace = true;
      return {};
    })
    .on([tools.claude, "plugin", "install"], () => {
      mac.plugin = true;
      return {};
    })
    .on(launchctl("print"), () => (mac.loaded ? {} : { code: 113, stderr: "Could not find service" }))
    .on(launchctl("bootstrap"), async () => {
      mac.loaded = true;
      if (mac.polls) await runnerPolls();
      return {};
    })
    .on(launchctl("bootout"), () => {
      mac.loaded = false;
      return {};
    })
    .on(launchctl("kickstart"), async () => {
      if (mac.polls) await runnerPolls();
      return {};
    });
});

afterEach(async () => {
  await socket?.close();
  await rm(root, { recursive: true, force: true });
});

/** A version folder as `build-version.sh` lays it out, small. */
async function build(at: string, version: string): Promise<string> {
  await mkdir(join(at, "bin"), { recursive: true });
  await writeFile(join(at, "bin/flight-deck"), "#!/bin/sh\n", { mode: 0o755 });
  await mkdir(join(at, "plugin/.claude-plugin"), { recursive: true });
  await writeFile(join(at, "plugin/.claude-plugin/plugin.json"), JSON.stringify({ name: "flight-deck", version }));
  await writeFile(join(at, "LICENSE"), "MIT");
  return at;
}

/** The runner's first poll after launchd starts it: it listens, then writes the heartbeat and `status.json`. */
async function runnerPolls(): Promise<void> {
  await mkdir(join(folders.data, "state"), { recursive: true });
  socket ??= await listen(join(folders.data, "state/runner.sock"), async (request) => {
    requests.push(request);
    if (request.op === "notify") return { ok: true };
    if (request.op === "trial") return trial(request);
    return { ok: false, error: `no ${request.op}` };
  });
  await writeFile(join(folders.data, "state/heartbeat"), JSON.stringify({ at: now.toISOString() }));
  await writeFile(join(folders.data, "state/status.json"), JSON.stringify({ version: VERSION, heartbeat_at: now.toISOString(), polled_at: now.toISOString(), sessions: [] }));
}

function command(options: { versionFolder?: string } = {}): Cli {
  const tracker = new InMemoryTracker({ clock: () => now, appUser: "user-app" });
  return cliAt({
    folders,
    clock: () => now,
    version: VERSION,
    versionFolder: options.versionFolder ?? out,
    adapters: { maintainerTracker: () => tracker, appTracker: () => tracker },
    env: { PATH: `${join(root, "tools")}:/usr/bin:/bin`, HOME: folders.home },
    shell,
  });
}

const config = async () => Bun.TOML.parse(await readFile(join(folders.config, "config.toml"), "utf8")) as Record<string, unknown>;

const NEXT_STEPS = [
  "Next:",
  "1. Create the Flight Deck Reader app in your Linear workspace, with only the read scope.",
  "2. Run flight-deck login linear <workspace>, where <workspace> is the URL key in linear.app/<workspace>.",
  "3. Commit a repo record at .flight-deck/record.toml on the repo's default branch.",
  "4. Run flight-deck register owner/repo in your checkout of the repo.",
];

describe("a first install from a local build", () => {
  test("copies the version in, then runs the 8 steps in order", async () => {
    const cli = command();
    cli.answers.push("subscription", "", TOKEN);
    expect(await cli.run("install")).toBe(0);
    expect(cli.err).toEqual([]);

    // The local build is copied in, and both links point at it.
    expect(await readFile(join(folders.data, `versions/${VERSION}/LICENSE`), "utf8")).toBe("MIT");
    expect(await readlink(join(folders.data, "current"))).toBe(join(folders.data, `versions/${VERSION}`));
    expect(await readlink(join(folders.home, ".local/bin/flight-deck"))).toBe(join(folders.data, "current/bin/flight-deck"));

    expect(cli.asked).toEqual([
      "Do sessions use your Claude subscription or an API key? Answer subscription or api_key",
      "Press Return once the machine user's account exists",
      "Machine user's classic token",
    ]);
    expect(shell.opened).toEqual(["https://github.com/signup", "https://github.com/settings/tokens/new?scopes=repo,read:org&description=Flight%20Deck"]);
    expect(shell.commands).toEqual([
      `${tools.claude} --version`,
      `${tools.git} --version`,
      `${tools.gh} --version`,
      `${tools.gh} api user -i`,
      `${tools.gh} api user --jq .login`,
      `${tools.gh} auth login --hostname github.com --git-protocol https --with-token --insecure-storage`,
      `${tools.claude} plugin list`,
      `${tools.claude} plugin marketplace list`,
      `${tools.claude} plugin marketplace add ${join(folders.data, "current/plugin")}`,
      `${tools.claude} plugin install flight-deck@flight-deck`,
      "/bin/launchctl print gui/501/dev.campdotdev.flight-deck",
      `/bin/launchctl bootstrap gui/501 ${plist()}`,
    ]);

    expect(await config()).toEqual({
      auth: "subscription",
      concurrency_cap: 2,
      usage: { five_hour: 0.8, weekly: 0.7 },
      models: { plan: "", build: "", check: "", debrief: "" },
      paths: tools,
      machine_user: { login: "fd-bot", id: 123456, name: "Flight Deck Bot", email: "123456+fd-bot@users.noreply.github.com" },
      repos: [],
    });
    expect(existsSync(join(folders.config, "credentials.env"))).toBe(false);
    expect(await readFile(join(folders.data, "launch/flight-deck"), "utf8")).toBe(`#!/bin/sh\nexec '${join(folders.data, "current/bin/flight-deck")}' runner\n`);
    expect(existsSync(plist())).toBe(true);
    expect(requests).toEqual([{ op: "notify", text: TEST_NOTIFICATION }, { op: "trial" }]);

    expect(cli.out).toEqual([
      `Installed Flight Deck ${VERSION} in ${join(folders.data, `versions/${VERSION}`)}, and ${join(folders.home, ".local/bin/flight-deck")} runs it.`,
      "1. Claude Code 2.1.321, git 2.55.0, and gh 2.102.0 are ready.",
      "3. Flight Deck acts on GitHub as a machine user: a second GitHub account that only the factory signs in to. GitHub's signup page opens now. Make the account in a private window, so you stay signed in as yourself.",
      "   The classic-token page opens now. Sign in to it as the machine user, keep the repo and read:org scopes, set the expiration to one year, and copy the token.",
      "Signed in to GitHub as fd-bot. Flight Deck's commits name Flight Deck Bot <123456+fd-bot@users.noreply.github.com>.",
      `4. Wrote ${join(folders.config, "config.toml")}.`,
      "5. Registered the flight-deck plugin, so /flight-plan works in your own Claude Code sessions.",
      "6. The runner is loaded, and it polled at 2026-11-10 09:00 UTC.",
      `7. The runner posted a test notification, "${TEST_NOTIFICATION}" If it didn't appear, turn on notifications for Script Editor in System Settings.`,
      "   The trial run passed, in session tr1a1s.",
      ...NEXT_STEPS,
    ]);
  });

  test("on an API key, writes the key to credentials.env with mode 0600, and the budget and caps to config.toml", async () => {
    const cli = command();
    cli.answers.push("API key", "api_key", "sk-ant-secret", "five", "5", "20", "200", "", TOKEN);
    expect(await cli.run("install")).toBe(0);
    expect(cli.asked.slice(0, 7)).toEqual([
      "Do sessions use your Claude subscription or an API key? Answer subscription or api_key",
      "Do sessions use your Claude subscription or an API key? Answer subscription or api_key",
      "Claude API key",
      "Session budget, in US dollars",
      "Session budget, in US dollars",
      "Daily cap, in US dollars",
      "Monthly cap, in US dollars",
    ]);
    expect(await readFile(join(folders.config, "credentials.env"), "utf8")).toBe("ANTHROPIC_API_KEY=sk-ant-secret\n");
    expect((await stat(join(folders.config, "credentials.env"))).mode & 0o777).toBe(0o600);
    expect(await config()).toMatchObject({ auth: "api_key", api: { session_budget_usd: 5, daily_cap_usd: 20, monthly_cap_usd: 200 } });
    for (const line of [...cli.out, ...cli.err]) expect(line).not.toContain("sk-ant-secret");
  });
});

describe("a rerun", () => {
  test("after a failed step reruns from the top and skips each step already done", async () => {
    mac.polls = false;
    const first = command();
    first.answers.push("subscription", "", TOKEN);
    expect(await first.run("install")).toBe(1);
    expect(first.err).toEqual([
      `6. The runner didn't poll within 2 minutes of loading. Read ${join(folders.data, "state/launchd.log")} and ${join(folders.data, "state/runner.log")}, fix what they show, then run flight-deck install again.`,
    ]);
    expect(requests).toEqual([]);

    // The maintainer fixes it, and runs the same build's install again.
    mac.polls = true;
    await mkdir(join(folders.data, "launch"), { recursive: true });
    const launcher = await readFile(join(folders.data, "launch/flight-deck"), "utf8");
    shell.calls.length = 0;
    const again = command();
    expect(await again.run("install")).toBe(0);
    expect(again.asked).toEqual([]);
    expect(shell.opened).toHaveLength(2);
    expect(shell.commands).toEqual([
      `${tools.claude} --version`,
      `${tools.git} --version`,
      `${tools.gh} --version`,
      `${tools.claude} plugin list`,
      "/bin/launchctl print gui/501/dev.campdotdev.flight-deck",
      "/bin/launchctl kickstart -k gui/501/dev.campdotdev.flight-deck",
    ]);
    expect(await readFile(join(folders.data, "launch/flight-deck"), "utf8")).toBe(launcher);
    expect(again.out).toEqual([
      "1. Claude Code 2.1.321, git 2.55.0, and gh 2.102.0 are ready.",
      "2. Sessions use your Claude subscription.",
      "3. Flight Deck's machine user on GitHub is fd-bot.",
      "4. config.toml holds Flight Deck's settings.",
      "5. The flight-deck plugin is registered.",
      "6. The runner is loaded, and it polled at 2026-11-10 09:02 UTC.",
      `7. The runner posted a test notification, "${TEST_NOTIFICATION}" If it didn't appear, turn on notifications for Script Editor in System Settings.`,
      "   The trial run passed, in session tr1a1s.",
      ...NEXT_STEPS,
    ]);
  });

  test("of a whole install from the installed version changes nothing", async () => {
    const first = command();
    first.answers.push("subscription", "", TOKEN);
    expect(await first.run("install")).toBe(0);
    shell.calls.length = 0;
    requests.length = 0;
    const again = command({ versionFolder: join(folders.data, `versions/${VERSION}`) });
    expect(await again.run("install")).toBe(0);
    expect(shell.commands).toEqual([`${tools.claude} --version`, `${tools.git} --version`, `${tools.gh} --version`, `${tools.claude} plugin list`, "/bin/launchctl print gui/501/dev.campdotdev.flight-deck"]);
    expect(requests).toEqual([]);
    expect(again.out.slice(5, 7)).toEqual(["6. The runner is loaded and polling.", `7. The trial run passed on ${VERSION}.`]);
  });
});

describe("stops with the fix", () => {
  test("when a tool is missing or too old, and writes nothing", async () => {
    await rm(tools.claude);
    versions.gh = "gh version 2.98.0 (2026-06-01)";
    const cli = command();
    expect(await cli.run("install")).toBe(1);
    expect(cli.err).toEqual([
      "1. Claude Code isn't on your PATH. Install it from https://code.claude.com/docs/en/setup, then run flight-deck install again.",
      "1. gh 2.98.0 is older than 2.99.0. Update it with brew upgrade gh, then run flight-deck install again.",
    ]);
    expect(existsSync(join(folders.config, "config.toml"))).toBe(false);
    expect(cli.asked).toEqual([]);
  });

  test("when Claude Code is older than this version's minimum", async () => {
    versions.claude = "2.1.300 (Claude Code)";
    const cli = command();
    expect(await cli.run("install")).toBe(1);
    expect(cli.err).toEqual(["1. Claude Code 2.1.300 is older than 2.1.321, the oldest this Flight Deck runs. Update it with claude update, then run flight-deck install again."]);
  });

  test("when the trial fails, with its exit and transcript, and a rerun asks for a trial again", async () => {
    trial = async () => ({ ok: true, result: "failed", session: "tr1a1s", exit: "no_init" });
    const cli = command();
    cli.answers.push("subscription", "", TOKEN);
    expect(await cli.run("install")).toBe(1);
    expect(cli.err).toEqual([
      `7. The trial run failed: session tr1a1s ended no_init. Its transcript is ${join(folders.data, "state/trials/tr1a1s.jsonl")}. Fix what it shows, then run flight-deck install again.`,
    ]);
    requests.length = 0;
    trial = async () => {
      await writeFile(join(folders.data, "state/trial.json"), JSON.stringify({ version: VERSION, claude_code_version: "2.1.321", session: "tr2a2s", passed_at: now.toISOString() }));
      return { ok: true, result: "passed", session: "tr2a2s", exit: "exited" };
    };
    expect(await command().run("install")).toBe(0);
    expect(requests).toEqual([{ op: "notify", text: TEST_NOTIFICATION }, { op: "trial" }]);
  });

  test("when a hold stops the trial, naming the hold", async () => {
    trial = async () => ({ ok: true, result: "held", cause: "stop" });
    const cli = command();
    cli.answers.push("subscription", "", TOKEN);
    expect(await cli.run("install")).toBe(1);
    expect(cli.err).toEqual(["7. The trial run didn't start, because the runner holds with the cause stop. Run flight-deck start, then run flight-deck install again."]);
  });

  test("when the login fails, and the rerun asks for it again", async () => {
    shell.on([tools.gh, "api", "user", "-i"], { stdout: `HTTP/2.0 200 OK\r\nX-Oauth-Scopes: repo, read:org, workflow\r\n\r\n${JSON.stringify({ login: "fd-bot", id: 1 })}` });
    const cli = command();
    cli.answers.push("subscription", "", TOKEN);
    expect(await cli.run("install")).toBe(1);
    expect(cli.err[0]).toStartWith("Refused: the token can't be the machine user's, because it has the workflow scope.");
    expect(existsSync(join(folders.config, "config.toml"))).toBe(false);
  });
});

describe("while the cap is full", () => {
  test("says the trial waits for a free place", async () => {
    let release: () => void = () => {};
    const done = new Promise<void>((resolve) => (release = resolve));
    trial = async () => {
      await writeFile(
        join(folders.data, "state/status.json"),
        JSON.stringify({ version: VERSION, heartbeat_at: now.toISOString(), polled_at: now.toISOString(), sessions: [{ stage: "plan", state: "running" }, { stage: "plan", state: "running" }] }),
      );
      await done;
      await writeFile(join(folders.data, "state/trial.json"), JSON.stringify({ version: VERSION, claude_code_version: "2.1.321", session: "tr1a1s", passed_at: now.toISOString() }));
      return { ok: true, result: "passed", session: "tr1a1s", exit: "exited" };
    };
    const cli = command();
    cli.answers.push("subscription", "", TOKEN);
    const run = cli.run("install");
    while (!cli.out.some((line) => line.includes("waits"))) await Bun.sleep(5);
    release();
    expect(await run).toBe(0);
    expect(cli.out.filter((line) => line.includes("waits"))).toEqual(["   The trial run waits for a free place: 2 sessions run, and the cap is 2."]);
  });
});

describe("refuses", () => {
  test("a local build while another version is current, and points at update --from", async () => {
    const old = "0.1.0-dev.20261101T000000Z";
    await build(join(folders.data, `versions/${old}`), old);
    const { switchCurrent } = await import("../../src/install/index.ts");
    await switchCurrent(folders, old);
    const cli = command();
    expect(await cli.run("install")).toBe(1);
    expect(cli.err).toEqual([`Flight Deck ${old} is installed. Run flight-deck update --from ${out} to switch to this build.`]);
    expect(existsSync(join(folders.data, `versions/${VERSION}`))).toBe(false);
    expect(shell.calls).toEqual([]);
  });

  test("a binary that doesn't run from a version folder", async () => {
    await mkdir(join(root, "bun-itself/bin"), { recursive: true });
    const cli = command({ versionFolder: join(root, "bun-itself") });
    expect(await cli.run("install")).toBe(1);
    expect(cli.err).toEqual([`${join(root, "bun-itself")} isn't a Flight Deck version folder: it has no bin/flight-deck. Run the flight-deck in a folder scripts/build-version.sh wrote.`]);
    expect(existsSync(join(folders.data, "versions"))).toBe(false);
  });

  test("arguments", async () => {
    const cli = command();
    expect(await cli.run("install", "now")).toBe(64);
    expect(cli.err).toEqual(["Usage: flight-deck install"]);
  });
});
