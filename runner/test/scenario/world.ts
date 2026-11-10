// The scenario harness: the in-memory world at the one seam (spec 1, "The seam"). A scenario builds the world,
// scripts each session, runs ticks, and asserts on the in-memory Tracker, the scripted Harness, and
// `status.json`. It never reads or writes the session list or issue memory.
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Folders } from "../../src/folders/index.ts";
import { ScriptedHarness } from "../../src/harness/index.ts";
import type { Config } from "../../src/install/index.ts";
import { Poll } from "../../src/poll/index.ts";
import type { Role } from "../../src/record/index.ts";
import type { Status } from "../../src/state/index.ts";
import { InMemoryTracker, type NewIssue, type StatusType, type StoredIssue } from "../../src/tracker/index.ts";
import { toToml } from "./toml.ts";

/** Shaders' statuses, with the status type Linear gives each. */
export const STATUSES: Record<Role, [string, StatusType]> = {
  intake: ["Triage", "triage"],
  backlog: ["Backlog", "backlog"],
  ready_to_plan: ["Ready to plan", "unstarted"],
  planning: ["Planning", "started"],
  ready_to_build: ["Ready to build", "unstarted"],
  building: ["Building", "started"],
  ready_to_check: ["Ready to check", "unstarted"],
  checking: ["Checking", "started"],
  landed: ["Landed", "started"],
  paused: ["Paused", "started"],
  in_review: ["In Review", "started"],
  done: ["Done", "completed"],
  canceled: ["Canceled", "canceled"],
  duplicate: ["Duplicate", "duplicate"],
};

const statusNames = Object.fromEntries(Object.entries(STATUSES).map(([role, [name]]) => [role, name])) as Record<Role, string>;

/** Shaders' schema-1 record, without its `[app]` table, because ports come in a later ticket. */
export const SHADERS_RECORD = (await Bun.file(new URL("../record/fixtures/shaders.toml", import.meta.url)).text()).replace(
  /\n\[app\]\n(?:[^\n[]*\n)*/,
  "\n",
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
/** `credentials.env` with every campdotdev secret, so the workspace has a Linear login. */
const CREDENTIALS = ["APP_ID", "APP_SECRET", "READER_ID", "READER_SECRET", "SETUP_KEY"].map((name) => `LINEAR_${name}_CAMPDOTDEV=test-${name.toLowerCase()}`).join("\n") + "\n";
const START = new Date("2026-11-10T09:00:00Z");

export interface WorldOptions {
  /** The record on the bare repo's default branch. `null` commits none. */
  record?: string | null;
}

export class World {
  readonly version = VERSION;
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
          tracker: { kind: "linear", workspace: "campdotdev", team: "SHA", statuses: statusNames },
        },
      ],
      linear: { campdotdev: { maintainer_id: this.maintainer.id, maintainer_name: this.maintainer.name, app_user_id: this.appUser } },
    };
    this.poll = this.newPoll();
  }

  static async create(options: WorldOptions = {}): Promise<World> {
    // realpath, because macOS's temp folder sits behind the /var symlink and git reports the real path.
    const root = await realpath(await mkdtemp(join(tmpdir(), "flight-deck-")));
    const folders: Folders = {
      data: join(root, "data"),
      config: join(root, "config"),
      sessionRoot: join(root, "session-root"),
      home: join(root, "home"),
    };
    const versionFolder = join(folders.data, "versions", VERSION);
    for (const folder of [folders.config, folders.sessionRoot, folders.home, join(versionFolder, "skills"), join(versionFolder, "plugin")]) {
      await mkdir(folder, { recursive: true });
    }
    await writeFile(join(folders.config, "gitconfig-runner"), "");
    // The shipped skill Shaders' record names in `plan.reproduce`, so its slot resolves.
    await mkdir(join(versionFolder, "skills", "reproducing-bugs"), { recursive: true });
    await writeFile(join(versionFolder, "skills", "reproducing-bugs", "SKILL.md"), "---\nname: reproducing-bugs\n---\n");
    await writeFile(join(folders.config, "credentials.env"), CREDENTIALS, { mode: 0o600 });
    // A stub `osascript` first on the runner's PATH, which records each notification instead of posting it.
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "bin", "osascript"), `#!/bin/sh\nfor arg in "$@"; do last="$arg"; done\nprintf '%s\\n' "$last" >> '${join(root, "notifications.log")}'\n`, { mode: 0o755 });
    const remote = join(root, "remote.git");
    const commit = await makeRemote(root, remote, options.record === undefined ? SHADERS_RECORD : options.record);
    const world = new World(root, folders, versionFolder, remote, commit);
    await world.writeConfig();
    return world;
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

  /**
   * `flight-deck hold` or `stop` when the runner doesn't answer: the command writes the hold marker itself, and
   * the runner reads it at its next start (spec 1, "The runner's socket").
   */
  async writeHoldMarker(by: "hold" | "stop"): Promise<void> {
    await mkdir(join(this.folders.data, "state"), { recursive: true });
    await writeFile(join(this.folders.data, "state", "hold"), `${JSON.stringify({ by, since: this.now.toISOString() })}\n`);
  }

  /** `status.json`, the state file. */
  async status(): Promise<Status> {
    return JSON.parse(await readFile(join(this.folders.data, "state", "status.json"), "utf8")) as Status;
  }

  /** `state/trial.json`, the last passing trial, or `null` before one passed. */
  async trialRecord(): Promise<unknown> {
    return JSON.parse(await readFile(join(this.folders.data, "state", "trial.json"), "utf8").catch(() => "null"));
  }

  /** The text of each macOS notification the runner posted, in order. */
  async notifications(): Promise<string[]> {
    const text = await readFile(join(this.root, "notifications.log"), "utf8").catch(() => "");
    return text.split("\n").filter((line) => line !== "");
  }

  /** Replaces `credentials.env`, keeping its mode. */
  async writeCredentials(text: string): Promise<void> {
    await writeFile(join(this.folders.config, "credentials.env"), text);
  }

  /** Sets `credentials.env`'s mode. */
  async credentialsMode(mode: number): Promise<void> {
    await chmod(join(this.folders.config, "credentials.env"), mode);
  }

  /** A new runner over the same data folder, as after a restart. */
  restart(): void {
    this.poll = this.newPoll();
  }

  async writeConfig(): Promise<void> {
    await writeFile(join(this.folders.config, "config.toml"), toToml(this.config as unknown as Record<string, unknown>));
  }

  /** Commits files on the remote's default branch, and returns the new tip. */
  async push(files: Record<string, string>, message = "Change"): Promise<string> {
    this.commit = await commitTo(this.root, this.remote, files, message);
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
