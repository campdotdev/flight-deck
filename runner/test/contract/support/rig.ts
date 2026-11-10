// The sessions the Harness contract suite and the probes start, prepared the way the runner prepares one: a bare
// repo stands in for the remote, Workspace fetches it into Flight Deck's clone and prepares a real worktree and
// session folder, and `buildLaunch` builds the command line, `settings.json`, and `mcp.json` (spec 1, "Harness").
//
// A real rig uses the maintainer's session root, so a session's temp folder has its real length, and a data folder
// of its own under `~`, so the sandbox denies it as it denies the real one. It answers `runner.sock` itself: a
// session's `headersHelper` asks it for a real Reader token, which the Linear adapter mints. A scripted rig puts
// everything in a temporary folder.
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { macFolders, paths, type Folders } from "../../../src/folders/index.ts";
import { buildLaunch, type Auth, type HarnessSession } from "../../../src/harness/index.ts";
import { writeEtc, type Registration } from "../../../src/install/index.ts";
import { readRecord, type RepoRecord } from "../../../src/record/index.ts";
import { listen, type Listening, type Request } from "../../../src/socket/index.ts";
import type { Tracker, TrackerRepo } from "../../../src/tracker/index.ts";
import { Workspace, type PreparedWorkspace } from "../../../src/workspace/index.ts";

const REPO_ROOT = join(import.meta.dir, "../../../..");

/** Where a real rig keeps its data and config folders, beside the real ones under `~`. */
export const CONTRACT_DATA = join(homedir(), ".local/share/flight-deck-contract");
export const CONTRACT_CONFIG = join(homedir(), ".config/flight-deck-contract");

export interface RigOptions {
  /** The maintainer's session root and a data folder under `~`, or else a temporary folder. */
  real: boolean;
  /** The `claude` the sessions run. A real rig wraps it to copy each session's stderr. */
  claude?: string;
  /** Answers each session's `linear_token` request with a Reader token for `repo`. */
  linear?: { tracker: Tracker; repo: TrackerRepo };
}

export interface RigSession {
  id: string;
  session: HarnessSession;
  prepared: PreparedWorkspace;
  /** The bare repo that stands in for the remote. */
  bare: string;
  registration: Registration;
  /** The file Claude Code's stderr goes to on a real rig. */
  stderr: string;
}

export interface PrepareInput {
  /** The repo's files at its one commit, by path. */
  files: Record<string, string>;
  /** The record to start with. The Shaders fixture with `hosts = ["registry.npmjs.org"]` by default. */
  record?: RepoRecord;
  /** The session's prompt, in place of the flow's `/flight-deck:flight-plan <issue>`. */
  prompt?: (session: HarnessSession) => string;
  auth?: Auth;
  /** Arguments added after the launch's own. */
  args?: string[];
  /** Variables added to the environment `claude` starts with. */
  environment?: Record<string, string>;
  /** Minutes until the session's deadline. 30 by default. */
  minutes?: number;
}

export class Rig {
  /** Every request a client sent to the rig's `runner.sock`. */
  readonly requests: Request[] = [];
  readonly sessions: RigSession[] = [];
  private socket: Listening | null = null;
  private next = 1;

  private constructor(
    readonly folders: Folders,
    readonly versionFolder: string,
    readonly claude: string,
    private readonly root: string,
    private readonly temporary: boolean,
    private readonly workspace: Workspace,
    private readonly linear: RigOptions["linear"],
  ) {}

  static async open(options: RigOptions): Promise<Rig> {
    const temporary = !options.real;
    // A temporary root sits under /tmp: macOS's own temp folder makes a session's `tmp/` too long for a socket.
    const root = temporary ? await realpath(await mkdtemp("/tmp/fd-contract-")) : join(CONTRACT_DATA, "rig");
    const folders: Folders = temporary
      ? { data: join(root, "data"), config: join(root, "config"), sessionRoot: join(root, "shared"), home: join(root, "home") }
      : { data: CONTRACT_DATA, config: CONTRACT_CONFIG, sessionRoot: macFolders().sessionRoot, home: homedir() };
    for (const folder of [folders.data, folders.config, folders.home, root]) await mkdir(folder, { recursive: true });
    if (!existsSync(folders.sessionRoot)) await mkdir(folders.sessionRoot, { recursive: true, mode: 0o700 });
    // A real rig shares `etc/` with an installed runner, so it writes it only when there's none.
    if (temporary || !existsSync(paths.etcGitconfig(folders))) await writeEtc(folders, undefined);

    const versionFolder = join(folders.data, "versions", "contract");
    await rm(versionFolder, { recursive: true, force: true });
    await mkdir(join(versionFolder, "bin"), { recursive: true });
    await cp(join(REPO_ROOT, "plugin"), join(versionFolder, "plugin"), { recursive: true });
    await cp(join(REPO_ROOT, "skills"), join(versionFolder, "skills"), { recursive: true });
    await script(paths.bin(versionFolder), `#!/bin/sh\nexec ${word(process.execPath)} ${word(join(import.meta.dir, "flight-deck.ts"))} ${word(folders.data)} "$@"\n`);

    let claude = options.claude ?? "claude";
    if (!temporary) {
      // Claude Code's stderr carries the login-expiring warning, which the adapter reads but doesn't keep.
      const wrapper = join(root, "bin", "claude");
      await mkdir(join(root, "stderr"), { recursive: true });
      await script(wrapper, `#!/bin/bash\nexec 2> >(tee -a ${word(join(root, "stderr"))}/"$(basename "$PWD")".stderr >&2)\nexec ${word(claude)} "$@"\n`);
      claude = wrapper;
    }

    const git = which("git");
    const rig = new Rig(folders, versionFolder, claude, root, temporary, new Workspace({ folders, git }), options.linear);
    if (options.linear !== undefined) rig.socket = await listen(paths.socket(folders), (request) => rig.answer(request));
    return rig;
  }

  /** Makes a repo from `files`, fetches it, and prepares a plan session on it, as the runner does at a take. */
  async prepare(input: PrepareInput): Promise<RigSession> {
    const record = input.record ?? probeRecord();
    const id = await this.workspace.newSessionId();
    const name = `contract/${id}`;
    const bare = join(this.root, "remotes", `${id}.git`);
    await makeRepo(bare, input.files);
    const path = [...new Set([dirname(which("git")), dirname(this.claude), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
    const registration: Registration = { name, remote: bare, checkout: "", package_manager: "pnpm", path, tracker: record.tracker };
    const fetched = await this.workspace.fetch(registration);
    if (!fetched.ok) throw new Error(`the rig couldn't fetch its repo: ${fetched.error}`);
    const issue = `SHA-${this.next++}`;
    const deadline = new Date(Date.now() + (input.minutes ?? 30) * 60_000).toISOString();
    const prepared = await this.workspace.prepare({
      session: id,
      stage: "plan",
      mode: "issue",
      repo: registration,
      record,
      issue,
      team: record.tracker.team,
      branch: fetched.branch,
      base: fetched.branch,
      commit: fetched.head,
      deadline,
      attempt: 1,
      maintainer: { id: this.linear?.repo.maintainer ?? "maintainer", name: "Maintainer" },
      appUser: "app-user",
      version: "contract",
      versionFolder: this.versionFolder,
      inbox: { previousBrief: null, syncedComments: [] },
    });
    const launch = await buildLaunch({
      folders: this.folders,
      id,
      stage: "plan",
      repo: name,
      issue,
      worktree: prepared.worktree,
      sessionFolder: prepared.sessionFolder,
      record,
      env: prepared.env,
      model: "",
      auth: input.auth ?? { kind: "subscription" },
      versionFolder: this.versionFolder,
    });
    const session: HarnessSession = {
      id,
      stage: "plan",
      mode: "issue",
      repo: name,
      issue,
      worktree: prepared.worktree,
      sessionFolder: prepared.sessionFolder,
      sessionJson: prepared.sessionJson,
      transcript: paths.transcript(this.folders, name, id),
      deadline,
      model: "",
      versionFolder: this.versionFolder,
      launch,
    };
    if (input.prompt !== undefined) launch.args[1] = input.prompt(session);
    launch.args.push(...(input.args ?? []));
    Object.assign(launch.environment, input.environment ?? {});
    const made: RigSession = { id, session, prepared, bare, registration, stderr: join(this.root, "stderr", `${id}.stderr`) };
    this.sessions.push(made);
    return made;
  }

  /** Deletes a session's worktree, session folder, clone, and bare repo. Its transcript stays. */
  async dispose(made: RigSession): Promise<void> {
    await this.workspace.dispose(made.prepared);
    await rm(paths.clone(this.folders, made.registration.name), { recursive: true, force: true });
    await rm(made.bare, { recursive: true, force: true });
  }

  async close(): Promise<void> {
    await this.socket?.close();
    if (this.linear !== undefined) for (const made of this.sessions) await this.linear.tracker.revoke({ id: made.id, repo: this.linear.repo });
    for (const made of this.sessions) await this.dispose(made);
    if (this.temporary) await rm(this.root, { recursive: true, force: true });
  }

  private async answer(request: Request) {
    this.requests.push(request);
    const made = this.sessions.find((each) => each.id === request.session);
    if (request.op !== "linear_token" || made === undefined || this.linear === undefined) return { ok: false as const, error: "the contract rig answers only linear_token for its own sessions" };
    return { ok: true as const, token: await this.linear.tracker.sessionToken({ id: made.id, repo: this.linear.repo }) };
  }
}

/** A schema-1 record whose `hosts` is `["registry.npmjs.org"]`: the Shaders fixture, cut down (spec 1, "Toolchain"). */
export function probeRecord(): RepoRecord {
  const parsed = readRecord(SHADERS_TOML);
  if (!parsed.ok) throw new Error("the Shaders record fixture doesn't parse");
  return { ...parsed.record, sandbox: { ...parsed.record.sandbox, hosts: ["registry.npmjs.org"] } };
}

const SHADERS_TOML = await readFile(join(import.meta.dir, "../../record/fixtures/shaders.toml"), "utf8");

/** The absolute path of a command on the runner's `PATH`. */
export function which(command: string): string {
  const found = Bun.which(command);
  if (found === null) throw new Error(`${command} isn't on PATH`);
  return found;
}

/** A bare repo with one commit on `main` that holds `files`. */
async function makeRepo(bare: string, files: Record<string, string>): Promise<void> {
  const work = `${bare}.work`;
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(work, path)), { recursive: true });
    await writeFile(join(work, path), text);
  }
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Flight Deck", "-c", "user.email=flight-deck@localhost", ...args], { cwd, stderr: "pipe" });
    if (!result.success) throw new Error(`git ${args[0]}: ${result.stderr.toString().trim()}`);
  };
  git(work, "init", "--quiet", "--initial-branch", "main");
  git(work, "add", "--all");
  git(work, "commit", "--quiet", "-m", "The contract suite's repo");
  await mkdir(dirname(bare), { recursive: true });
  git(dirname(bare), "clone", "--quiet", "--bare", work, bare);
  await rm(work, { recursive: true, force: true });
}

async function script(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  await chmod(path, 0o755);
}

/** A word for `sh`, in single quotes. */
function word(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** Waits until `ready` is true, polling every `everyMs`, or throws after `withinMs`. */
export async function until(what: string, ready: () => boolean | Promise<boolean>, withinMs: number, everyMs = 250): Promise<void> {
  const end = Date.now() + withinMs;
  while (!(await ready())) {
    if (Date.now() > end) throw new Error(`${what} didn't happen within ${Math.round(withinMs / 1000)} s`);
    await Bun.sleep(everyMs);
  }
}
