// The scenario harness: the in-memory world at the one seam (spec 1, "The seam"). A scenario builds the world,
// scripts each session, runs ticks, and asserts on the in-memory Tracker, the scripted Harness, and
// `status.json`. It never reads or writes the session list or issue memory.
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { paths, type Folders } from "../../src/folders/index.ts";
import { ScriptedHarness } from "../../src/harness/index.ts";
import type { Config } from "../../src/install/index.ts";
import { Poll } from "../../src/poll/index.ts";
import { readRecord, type Role } from "../../src/record/index.ts";
import type { Status } from "../../src/state/index.ts";
import { InMemoryTracker, type NewIssue, type StoredIssue } from "../../src/tracker/index.ts";
import { Workspace } from "../../src/workspace/index.ts";
import { toToml } from "../../src/install/toml.ts";
import { STATUS_NAMES, STATUSES } from "../statuses.ts";

/**
 * The test record's dependency install: it writes a package into `node_modules` and a blob into pnpm's store,
 * with only the commands the registration's `PATH` holds.
 */
export const INSTALL = 'mkdir -p node_modules/pkg "$pnpm_config_store_dir" && echo installed > node_modules/pkg/index.js && echo stored > "$pnpm_config_store_dir/blob"';

/**
 * Shaders' schema-1 record, without its `[app]` table, because ports come in a later ticket, and with
 * `INSTALL` as its dependency install, because the test Mac has no pnpm on the registration's `PATH`.
 */
export const SHADERS_RECORD = (await Bun.file(new URL("../record/fixtures/shaders.toml", import.meta.url)).text())
  .replace(/\n\[app\]\n(?:[^\n[]*\n)*/, "\n")
  .replace('command = "pnpm install --frozen-lockfile"', `command = '${INSTALL}'`);

/** Shaders' whole schema-1 record, `[app]` included, with `INSTALL` as its dependency install. */
export const SHADERS_APP_RECORD = (await Bun.file(new URL("../record/fixtures/shaders.toml", import.meta.url)).text()).replace(
  'command = "pnpm install --frozen-lockfile"',
  `command = '${INSTALL}'`,
);

/** Each outbox a scenario's session can leave, as files. */
export const outbox = {
  /** Plan's handoff: a brief that moves the issue to Ready to build. */
  brief(input: { summary: string; brief: string; version?: string }): Record<string, string> {
    return {
      "outcome.json": JSON.stringify({ version: input.version ?? VERSION, stage: "plan", move: "ready_to_build" }),
      "summary.md": input.summary,
      "brief.md": input.brief,
    };
  },
  /** A pause, with its answers and what it needs. */
  pause(input: {
    summary: string;
    pause: string;
    answers: { word: string; does: string; move: Role }[];
    needs: "answer" | "help";
    version?: string;
  }): Record<string, string> {
    return {
      "outcome.json": JSON.stringify({ version: input.version ?? VERSION, stage: "plan", move: "paused", answers: input.answers, needs: input.needs }),
      "summary.md": input.summary,
      "pause.md": input.pause,
    };
  },
  /** A duplicate of the open issue `of` names. */
  duplicate(input: { summary: string; of: string; version?: string }): Record<string, string> {
    return {
      "outcome.json": JSON.stringify({ version: input.version ?? VERSION, stage: "plan", move: "duplicate", of: input.of }),
      "summary.md": input.summary,
    };
  },
};

const VERSION = "0.1.0";
/** The repo's `vendor/sandbox-runtime/`, which `bun install` fills. */
const VENDOR_SANDBOX_RUNTIME = new URL("../../../vendor/sandbox-runtime", import.meta.url).pathname;
/** The repo's `vendor/betterleaks`, which `scripts/fetch-betterleaks.sh` puts there. */
const VENDOR_BETTERLEAKS = new URL("../../../vendor/betterleaks", import.meta.url).pathname;
/** `credentials.env` with every campdotdev secret, so the workspace has a Linear login. */
function credentialsFor(workspace: string): string {
  const key = workspace.toUpperCase().replaceAll("-", "_");
  return ["APP_ID", "APP_SECRET", "READER_ID", "READER_SECRET", "SETUP_KEY"].map((name) => `LINEAR_${name}_${key}=test-${name.toLowerCase()}`).join("\n") + "\n";
}
const CREDENTIALS = credentialsFor("campdotdev");
const START = new Date("2026-11-10T09:00:00Z");

export interface WorldOptions {
  /** The record on the bare repo's default branch. `null` commits none. */
  record?: string | null;
  /** Whether the repo starts with a good dependency cache, built from the default branch. Default `true`. */
  cache?: boolean;
}

export class World {
  /** The running version, which `restart({ version })` changes as `flight-deck update` does. */
  version = VERSION;
  readonly maintainer = { id: "maintainer", name: "Hunter" };
  readonly appUser = "flight-deck-app";
  readonly repo = "campdotdev/shaders";
  readonly tracker: InMemoryTracker;
  readonly harness = new ScriptedHarness();
  /** What `config.toml` holds. Change it, then call `writeConfig`. */
  readonly config: Config;
  poll: Poll;
  now = START;

  private constructor(
    readonly root: string,
    readonly folders: Folders,
    readonly versionFolder: string,
    /** The local bare repo the clone fetches from. */
    readonly remote: string,
    /** The default branch's tip on the remote. */
    public commit: string,
  ) {
    this.tracker = new InMemoryTracker({ clock: () => this.now, appUser: this.appUser });
    this.tracker.addUser({ id: this.maintainer.id, name: this.maintainer.name });
    this.tracker.addUser({ id: this.appUser, name: "Flight Deck" });
    this.tracker.addTeam({ key: "SHA", name: "Shaders", statuses: Object.values(STATUSES).map(([name, type]) => ({ name, type })) });
    this.config = {
      auth: "subscription",
      concurrency_cap: 2,
      usage: { five_hour: 0.8, weekly: 0.7 },
      models: { plan: "", build: "", check: "", debrief: "" },
      paths: { claude: "/usr/local/bin/claude", git: Bun.which("git") ?? "/usr/bin/git", gh: "/usr/local/bin/gh" },
      machine_user: { login: "flight-deck-bot", id: 1, name: "Flight Deck Bot", email: "1+flight-deck-bot@users.noreply.github.com" },
      repos: [
        {
          name: this.repo,
          remote,
          checkout: join(root, "checkout"),
          package_manager: "/usr/bin/true",
          path: "/usr/bin:/bin:/usr/sbin:/sbin",
          tracker: { kind: "linear", workspace: "campdotdev", team: "SHA", statuses: STATUS_NAMES },
        },
      ],
      linear: { campdotdev: { maintainer_id: this.maintainer.id, maintainer_name: this.maintainer.name, app_user_id: this.appUser } },
    };
    this.poll = this.newPoll();
  }

  static async create(options: WorldOptions = {}): Promise<World> {
    // Under /tmp, because macOS's own temp folder is so long that a session's temp folder would fail the
    // socket path limit. realpath, because /tmp sits behind a symlink and git reports the real path.
    const root = await realpath(await mkdtemp("/tmp/fd-"));
    const folders: Folders = {
      data: join(root, "data"),
      config: join(root, "config"),
      sessionRoot: join(root, "session-root"),
      home: join(root, "home"),
    };
    const versionFolder = paths.version(folders, VERSION);
    for (const folder of [folders.config, folders.sessionRoot, folders.home, join(versionFolder, "skills"), join(versionFolder, "plugin")]) {
      await mkdir(folder, { recursive: true });
    }
    await writeFile(paths.runnerGitconfig(folders), "");
    // The version folder's binary is Bun itself, which acts as Bun under BUN_BE_BUN as the compiled binary
    // does, and its vendored sandbox-runtime and Betterleaks are the repo's.
    await mkdir(join(versionFolder, "bin"), { recursive: true });
    await symlink(process.execPath, paths.bin(versionFolder));
    await mkdir(join(versionFolder, "vendor"), { recursive: true });
    await symlink(VENDOR_SANDBOX_RUNTIME, join(versionFolder, "vendor", "sandbox-runtime"));
    if (!existsSync(VENDOR_BETTERLEAKS)) throw new Error("vendor/betterleaks is missing. Run scripts/fetch-betterleaks.sh.");
    await symlink(VENDOR_BETTERLEAKS, paths.betterleaks(versionFolder));
    // The shipped skill Shaders' record names in `plan.reproduce`, so its slot resolves.
    await mkdir(join(versionFolder, "skills", "reproducing-bugs"), { recursive: true });
    await writeFile(join(versionFolder, "skills", "reproducing-bugs", "SKILL.md"), "---\nname: reproducing-bugs\n---\n");
    await writeFile(paths.credentials(folders), CREDENTIALS, { mode: 0o600 });
    // A stub `osascript` first on the runner's PATH, which records each notification instead of posting it.
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "bin", "osascript"), `#!/bin/sh\nfor arg in "$@"; do last="$arg"; done\nprintf '%s\\n' "$last" >> '${join(root, "notifications.log")}'\n`, { mode: 0o755 });
    const remote = join(root, "remote.git");
    const commit = await makeRemote(root, remote, options.record === undefined ? SHADERS_RECORD : options.record);
    const world = new World(root, folders, versionFolder, remote, commit);
    await world.writeConfig();
    if (options.cache !== false) await world.refreshCache();
    return world;
  }

  /**
   * Builds a repo's dependency cache from its default branch's tip, as a refresh the runner made earlier
   * would have, so the next poll finds a good cache for the tip. Does nothing when the fetch fails or the tip
   * holds no valid record.
   */
  async refreshCache(name = this.repo): Promise<void> {
    const workspace = new Workspace({ folders: this.folders, git: this.config.paths.git });
    const repo = this.config.repos.find((each) => each.name === name);
    if (repo === undefined) throw new Error(`no repo ${name}`);
    const fetched = await workspace.fetch(repo);
    // A scenario that breaks the remote gets no cache.
    if (!fetched.ok) return;
    const text = await workspace.show(repo, fetched.head, ".flight-deck/record.toml");
    const record = text === null ? null : readRecord(text);
    if (record?.ok !== true) return;
    const job = await workspace.refreshCache({ repo, record: record.record, commit: fetched.head, versionFolder: this.versionFolder, now: this.now });
    const result = await job.done;
    if (!result.ok) throw new Error(`the world's cache refresh failed: ${result.error}`);
  }

  /**
   * Registers a second repo on its own team, with Shaders' statuses and record, on its own bare remote. Issues on
   * it are filed with `world.issue({ team, ... })`. With `workspace`, the repo's team sits in another Linear
   * workspace, with its own login.
   */
  async addRepo(input: { name: string; team: string; workspace?: string }): Promise<void> {
    const slug = input.name.replace("/", "-");
    const remote = join(this.root, `${slug}.git`);
    const workspace = input.workspace ?? "campdotdev";
    await makeRemote(this.root, remote, SHADERS_RECORD.replace('team = "SHA"', `team = "${input.team}"`).replace('workspace = "campdotdev"', `workspace = "${workspace}"`));
    this.tracker.addTeam({ key: input.team, name: input.name, statuses: Object.values(STATUSES).map(([name, type]) => ({ name, type })) });
    const first = this.config.repos[0]!;
    this.config.repos.push({ ...first, name: input.name, remote, checkout: join(this.root, `checkout-${slug}`), tracker: { ...first.tracker, workspace, team: input.team } });
    if (this.config.linear[workspace] === undefined) {
      this.config.linear[workspace] = { ...this.config.linear.campdotdev! };
      const credentials = await readFile(paths.credentials(this.folders), "utf8");
      await this.writeCredentials(credentials + credentialsFor(workspace));
    }
    await this.writeConfig();
    await this.refreshCache(input.name);
  }

  /** Copies a gitignored file into Flight Deck's own folder, as `flight-deck register --files` does (ADR 0007). */
  async copyFile(path: string, text: string, name = this.repo): Promise<void> {
    const target = join(paths.files(this.folders, name), path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
  }

  /** Files an issue as the maintainer, in Backlog unless it says otherwise. */
  issue(input: Partial<NewIssue> & { title: string }): StoredIssue {
    return this.tracker.addIssue({ team: "SHA", status: "Backlog", creator: this.maintainer.id, description: "", ...input });
  }

  /** The maintainer sends the issue: a move to Ready to plan. */
  send(issue: StoredIssue): void {
    this.tracker.setStatus(issue.id, STATUSES.ready_to_plan[0]);
  }

  /** A comment the maintainer posts, a second after the clock's last reading. */
  reply(issue: StoredIssue, body: string, options: { parent?: string; synced?: boolean; author?: string } = {}): string {
    this.now = new Date(this.now.getTime() + 1000);
    return this.tracker.addComment(issue.id, { author: this.maintainer.id, body, ...options }).id;
  }

  /** Advances the clock, by a minute unless told otherwise, and runs one poll. */
  async tick(at?: Date): Promise<void> {
    this.now = at ?? new Date(this.now.getTime() + 60_000);
    await this.poll.tick(this.now);
  }

  /** `flight-deck hold`, at the clock's time. */
  async hold(): Promise<void> {
    await this.poll.hold(this.now);
  }

  /** `flight-deck start`. */
  async start(): Promise<void> {
    await this.poll.start(this.now);
  }

  /** `flight-deck stop`, at the clock's time. */
  async stop(): Promise<void> {
    await this.poll.stop(this.now);
  }

  /** SIGTERM from launchd, at logout, shutdown, or `bootout`, at the clock's time. */
  async shutdown(): Promise<void> {
    await this.poll.shutdown(this.now);
  }

  /**
   * `flight-deck hold` or `stop` when the runner doesn't answer: the command writes the hold marker itself, and
   * the runner reads it at its next start (spec 1, "The runner's socket").
   */
  async writeHoldMarker(by: "hold" | "stop"): Promise<void> {
    await mkdir(paths.state(this.folders), { recursive: true });
    await writeFile(paths.holdMarker(this.folders), `${JSON.stringify({ by, since: this.now.toISOString() })}\n`);
  }

  /** `status.json`, the state file. */
  async status(): Promise<Status> {
    return JSON.parse(await readFile(paths.status(this.folders), "utf8")) as Status;
  }

  /** The text of each macOS notification the runner posted, in order. */
  async notifications(): Promise<string[]> {
    const text = await readFile(join(this.root, "notifications.log"), "utf8").catch(() => "");
    return text.split("\n").filter((line) => line !== "");
  }

  /** Replaces `credentials.env`, keeping its mode. */
  async writeCredentials(text: string): Promise<void> {
    await writeFile(paths.credentials(this.folders), text);
  }

  /** Sets `credentials.env`'s mode. */
  async credentialsMode(mode: number): Promise<void> {
    await chmod(paths.credentials(this.folders), mode);
  }

  /** A new runner over the same data folder, as after a restart, or after `flight-deck update` with `version`. */
  restart(options: { version?: string } = {}): void {
    if (options.version !== undefined) this.version = options.version;
    this.poll = this.newPoll();
  }

  async writeConfig(): Promise<void> {
    await writeFile(paths.configToml(this.folders), toToml(this.config as unknown as Record<string, unknown>));
  }

  /**
   * Commits files on the remote's default branch, and returns the new tip. Then it rebuilds the cache for the
   * new tip, so the next poll starts sessions at once, unless `refresh` is `false`, which leaves the cache
   * for the runner to refresh.
   */
  async push(files: Record<string, string>, message = "Change", options: { refresh?: boolean } = {}): Promise<string> {
    this.commit = await commitTo(this.root, this.remote, files, message);
    if (options.refresh !== false) await this.refreshCache();
    return this.commit;
  }

  async cleanup(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }

  private newPoll(): Poll {
    return new Poll({
      folders: this.folders,
      version: this.version,
      versionFolder: this.versionFolder,
      tracker: this.tracker,
      harness: this.harness,
      path: `${join(this.root, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    });
  }
}

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Maintainer",
  GIT_AUTHOR_EMAIL: "maintainer@example.com",
  GIT_COMMITTER_NAME: "Maintainer",
  GIT_COMMITTER_EMAIL: "maintainer@example.com",
  PATH: process.env.PATH ?? "/usr/bin:/bin",
};

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

async function makeRemote(root: string, remote: string, record: string | null): Promise<string> {
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  const files: Record<string, string> = { "README.md": "# Shaders\n" };
  if (record !== null) files[".flight-deck/record.toml"] = record;
  return commitTo(root, remote, files, "Initial commit");
}

async function commitTo(root: string, remote: string, files: Record<string, string>, message: string): Promise<string> {
  const work = await mkdtemp(join(root, "work-"));
  git(work, "init", "-q", "-b", "main");
  const hasMain = Bun.spawnSync(["git", "rev-parse", "--verify", "-q", "refs/heads/main"], { cwd: remote, env: GIT_ENV }).exitCode === 0;
  if (hasMain) {
    git(work, "fetch", "-q", remote, "main");
    git(work, "reset", "-q", "--hard", "FETCH_HEAD");
  }
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(work, path, ".."), { recursive: true });
    await writeFile(join(work, path), text);
  }
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", message);
  git(work, "push", "-q", remote, "HEAD:main");
  const commit = git(work, "rev-parse", "HEAD");
  await rm(work, { recursive: true, force: true });
  return commit;
}
