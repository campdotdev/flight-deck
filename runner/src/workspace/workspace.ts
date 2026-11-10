// Workspace: Flight Deck's clone of each repo, the worktrees and session folders under the session root
// (spec 1, "Workspace"). It's local and has no port, so its tests use real git in a temporary root.
// Later tickets add the dependency cache, copied files, ports, the temp-folder check, and the sweep.
import { randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import limits from "../../../data/limits.toml";
import { paths, sessionParts, type Folders } from "../folders/index.ts";
import type { Registration } from "../install/index.ts";
import type { RepoRecord } from "../record/index.ts";
import type { Mode, Stage } from "../state/index.ts";
import { cloneFolder, copyFiles, fillDeps, linkDeps } from "./deps.ts";
import { emptyConfigFolders, sessionEnv } from "./env.ts";
import { refreshCache, type RefreshInput, type RefreshJob } from "./refresh.ts";
import { appUrl, sessionPort } from "./ports.ts";
import type { SessionJson } from "./session.ts";
import { sweep } from "./sweep.ts";

/** The longest socket file name a sandbox makes in a temp folder, from `data/limits.toml` (spec 1, "Session IDs"). */
export const SOCKET_NAME_BYTES: number = (limits as { socket_name_bytes: number }).socket_name_bytes;

/** macOS caps a Unix socket path at 104 bytes, and that includes the terminating NUL. */
const SOCKET_PATH_BYTES = 103;

/** The repo's dependency cache: whether it has a good copy, and how its last refresh went. */
export interface CacheState {
  current: boolean;
  last: LastRefresh | null;
}

/** The repo's last cache refresh: the commit it installed, when it started (ISO), and whether it passed. */
export interface LastRefresh {
  commit: string;
  at: string;
  ok: boolean;
}

export interface PreparePlan {
  session: string;
  stage: Stage;
  mode: Mode;
  repo: Registration;
  /** The record at `commit`. */
  record: RepoRecord;
  /** The issue's identifier. */
  issue: string;
  /** The record's team key. */
  team: string;
  branch: string;
  base: string;
  /** The commit the worktree starts from: plan's is the default branch's tip at the take. */
  commit: string;
  /** ISO time. */
  deadline: string;
  attempt: number;
  maintainer: { id: string; name: string };
  appUser: string;
  version: string;
  versionFolder: string;
  inbox: {
    /** The brief the runner last wrote for the issue, or `null`. */
    previousBrief: string | null;
    /** The IDs of the issue's comments that came through the GitHub sync. */
    syncedComments: string[];
  };
  /** The ports the session list's live sessions hold, which a session of an app that runs more than once skips. */
  heldPorts?: readonly number[];
}

/** What a trial run's `prepare` needs (spec 1, "Trial run"). It has no repo, no issue, and no record. */
export interface TrialPlan {
  session: string;
  /** ISO time: 5 minutes after the trial starts. */
  deadline: string;
  version: string;
  versionFolder: string;
  /** The `PATH` a trial gets: the folders of `[paths]` `claude`, `git`, and `gh`, then the system's. */
  path: string;
}

/** What `prepare` returns, and what `dispose` takes. */
export interface PreparedWorkspace {
  session: string;
  sessionFolder: string;
  sessionJson: string;
  inbox: string;
  outbox: string;
  tmp: string;
  deps: string;
  home: string;
  worktree: string;
  port: number | null;
  appUrl: string | null;
  /** The session's `env` block, which the Harness puts in `settings.json`. */
  env: Record<string, string>;
}

/** A failed fetch says whether git failed to authenticate, which opens the trouble cause `github_token` (ADR 0005). */
export type FetchResult = { ok: true; branch: string; head: string } | { ok: false; error: string; auth: boolean };

/** What git prints when a remote refuses its login, over HTTPS or SSH. */
const AUTH_FAILURE = /Authentication failed|could not read (?:Username|Password)|terminal prompts disabled|Invalid username or (?:password|token)|returned error: 40[13]|Permission denied \(publickey/i;

function fetchFailed(error: string): FetchResult {
  return { ok: false, error, auth: AUTH_FAILURE.test(error) };
}

export interface WorkspaceOptions {
  folders: Folders;
  /** The absolute path of git, from `config.toml`'s `[paths]`. */
  git: string;
}

export class Workspace {
  private readonly folders: Folders;
  private readonly gitPath: string;

  constructor(options: WorkspaceOptions) {
    this.folders = options.folders;
    this.gitPath = options.git;
  }

  /**
   * Fetches the default branch and tags from the registration's remote into the clone, making the clone
   * first if there is none. A failed fetch keeps the last fetched commit.
   */
  async fetch(repo: Registration): Promise<FetchResult> {
    const clone = paths.clone(this.folders, repo.name);
    const symref = await this.git(null, "ls-remote", "--symref", repo.remote, "HEAD");
    if (!symref.ok) return fetchFailed(symref.error);
    const branch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(symref.out)?.[1];
    if (branch === undefined) return fetchFailed(`${repo.remote} names no default branch`);
    if (!existsSync(join(clone, ".git"))) {
      await mkdir(dirname(clone), { recursive: true });
      const made = await this.git(null, "clone", "--quiet", "--no-checkout", repo.remote, clone);
      if (!made.ok) return fetchFailed(made.error);
    }
    const ref = `refs/heads/${branch}`;
    const fetched = await this.git(clone, "fetch", "--quiet", "--tags", "--update-head-ok", repo.remote, `+${ref}:${ref}`);
    if (!fetched.ok) return fetchFailed(fetched.error);
    await this.git(clone, "symbolic-ref", "HEAD", ref);
    return { ok: true, branch, head: await this.head(repo) };
  }

  /** The default branch's name, as the last fetch read it. */
  async branch(repo: Registration): Promise<string> {
    return this.must(paths.clone(this.folders, repo.name), "symbolic-ref", "--short", "HEAD");
  }

  /** The default branch's tip, as the last fetch left it. */
  async head(repo: Registration): Promise<string> {
    return this.must(paths.clone(this.folders, repo.name), "rev-parse", "HEAD");
  }

  /** A file's text at a commit in the clone, or `null` when the commit doesn't hold it. */
  async show(repo: Registration, commit: string, path: string): Promise<string | null> {
    const shown = await this.git(paths.clone(this.folders, repo.name), "show", `${commit}:${path}`);
    return shown.ok ? shown.out : null;
  }

  /** A new session ID: 6 lowercase base-36 characters that no session folder, worktree, transcript, or hand run has. */
  async newSessionId(): Promise<string> {
    const taken = await this.takenIds();
    for (;;) {
      const id = randomInt(36 ** 6).toString(36).padStart(6, "0");
      if (!taken.has(id)) return id;
    }
  }

  /**
   * Makes one session's folder and worktree: the dependency folders, cloned from the cache's good copy or
   * empty, the cache's `home/`, and the copied files. Fails before it makes anything when the session's temp
   * folder is too long for the sandboxes' sockets.
   */
  async prepare(plan: PreparePlan): Promise<PreparedWorkspace> {
    const sessionFolder = paths.sessionFolder(this.folders, plan.session);
    const parts = sessionParts(sessionFolder);
    const worktree = paths.worktree(this.folders, plan.session);
    checkTempFolder(parts.tmp);
    // A session that starts between the refresh's two renames finds no `current/`, and gets empty folders.
    const current = join(paths.cache(this.folders, plan.repo.name), "current");
    const cached = existsSync(current) ? current : null;
    for (const folder of [parts.inbox, join(parts.outbox, "media"), parts.tmp, parts.deps]) await mkdir(folder, { recursive: true });
    if (cached !== null && existsSync(join(cached, "home"))) await cloneFolder(join(cached, "home"), parts.home);
    // The `env` block's config folders for turbo and Vercel stay empty, whatever the cache's `home/` holds.
    for (const folder of emptyConfigFolders(sessionFolder)) {
      await rm(folder, { recursive: true, force: true });
      await mkdir(folder, { recursive: true });
    }
    await fillDeps(parts.deps, plan.record.dependencies.folders, cached === null ? null : join(cached, "deps"));
    if (plan.inbox.previousBrief !== null) await writeFile(join(parts.inbox, "previous-brief.md"), plan.inbox.previousBrief);
    await writeFile(join(parts.inbox, "synced-comments.json"), JSON.stringify(plan.inbox.syncedComments));

    // A repo of its own, not a `git worktree`: it borrows the clone's objects and copies its branches and tags (ADR 0007).
    await mkdir(paths.worktrees(this.folders), { recursive: true });
    await this.must(null, "clone", "--quiet", "--shared", "--no-checkout", paths.clone(this.folders, plan.repo.name), worktree);
    await this.must(worktree, "checkout", "--quiet", "--detach", plan.commit);
    await linkDeps(worktree, parts.deps, plan.record.dependencies.folders);
    await copyFiles(plan.repo.name, paths.files(this.folders, plan.repo.name), worktree, plan.record.copy_files);

    // The runner prepares one session at a time, so two sessions never pick the same port.
    const app = plan.record.app;
    const port = app === undefined ? null : await sessionPort(app, new Set(plan.heldPorts ?? []));
    const url = app === undefined || port === null ? null : appUrl(app, port);

    const json: SessionJson = {
      version: plan.version,
      session: plan.session,
      stage: plan.stage,
      mode: plan.mode,
      repo: plan.repo.name,
      issue: plan.issue,
      branch: plan.branch,
      base: plan.base,
      commit: plan.commit,
      worktree,
      deadline: plan.deadline,
      port,
      app_url: url,
      inbox: parts.inbox,
      outbox: parts.outbox,
      skills: join(plan.versionFolder, "skills"),
      slots: slotPaths(plan, worktree),
      maintainer: plan.maintainer,
      app_user: plan.appUser,
      team: plan.team,
      plugin: join(plan.versionFolder, "plugin"),
      attempt: plan.attempt,
      // The Harness sets this when it appends AGENTS.md.
      agents_md: null,
    };
    await writeFile(parts.sessionJson, `${JSON.stringify(json, null, 2)}\n`);
    const env = sessionEnv({ folders: this.folders, sessionFolder, path: plan.repo.path });
    const { sessionJson, inbox, outbox, tmp, deps, home } = parts;
    return { session: plan.session, sessionFolder, sessionJson, inbox, outbox, tmp, deps, home, worktree, port, appUrl: url, env };
  }

  /**
   * Makes a trial run's session folder, and a throwaway git repo at `worktrees/<session-id>` with one empty
   * commit on `main`. The repo isn't a clone of anything, so `dispose` deletes it outright.
   */
  async prepareTrial(plan: TrialPlan): Promise<PreparedWorkspace> {
    const sessionFolder = paths.sessionFolder(this.folders, plan.session);
    const parts = sessionParts(sessionFolder);
    const worktree = paths.worktree(this.folders, plan.session);
    for (const folder of [parts.inbox, join(parts.outbox, "media"), parts.tmp, parts.deps, ...emptyConfigFolders(sessionFolder)]) {
      await mkdir(folder, { recursive: true });
    }
    await mkdir(paths.worktrees(this.folders), { recursive: true });
    await this.must(null, "init", "--quiet", "--initial-branch", "main", worktree);
    await this.must(worktree, "-c", "user.name=Flight Deck", "-c", "user.email=flight-deck@localhost", "commit", "--quiet", "--allow-empty", "-m", "Trial run");
    const commit = await this.must(worktree, "rev-parse", "HEAD");

    const json: SessionJson = {
      version: plan.version,
      session: plan.session,
      stage: "trial",
      mode: "issue",
      repo: "",
      issue: "",
      branch: "main",
      base: "main",
      commit,
      worktree,
      deadline: plan.deadline,
      port: null,
      app_url: null,
      inbox: parts.inbox,
      outbox: parts.outbox,
      skills: join(plan.versionFolder, "skills"),
      slots: {},
      maintainer: null,
      app_user: "",
      team: "",
      plugin: join(plan.versionFolder, "plugin"),
      attempt: 1,
      agents_md: null,
    };
    await writeFile(parts.sessionJson, `${JSON.stringify(json, null, 2)}\n`);
    const env = sessionEnv({ folders: this.folders, sessionFolder, path: plan.path });
    const { sessionJson, inbox, outbox, tmp, deps, home } = parts;
    return { session: plan.session, sessionFolder, sessionJson, inbox, outbox, tmp, deps, home, worktree, port: null, appUrl: null, env };
  }

  /**
   * Deletes the worktree, the session folder, and the session's folder under `~/.claude/projects/`. With
   * `keepFolder`, it leaves the session folder, which an `apply_waiting` entry still needs. The transcript stays.
   */
  async dispose(workspace: Pick<PreparedWorkspace, "session" | "worktree">, options: { keepFolder?: boolean } = {}): Promise<void> {
    await rm(workspace.worktree, { recursive: true, force: true });
    await rm(paths.claudeProject(this.folders, workspace.worktree), { recursive: true, force: true });
    if (options.keepFolder !== true) await rm(paths.sessionFolder(this.folders, workspace.session), { recursive: true, force: true });
  }

  /**
   * Starts a cache refresh: the record's dependency install in a scratch worktree of `commit`, under the
   * pinned `sandbox-runtime` (ADR 0018). `done` resolves when it ends, and `kill` stops its process group.
   * Only a refresh writes the cache.
   */
  async refreshCache(input: Omit<RefreshInput, "folders" | "session" | "clone">): Promise<RefreshJob> {
    const session = await this.newSessionId();
    checkTempFolder(sessionParts(paths.sessionFolder(this.folders, session)).tmp);
    return refreshCache({
      ...input,
      folders: this.folders,
      session,
      clone: async (worktree, commit) => {
        await this.must(null, "clone", "--quiet", "--shared", "--no-checkout", paths.clone(this.folders, input.repo.name), worktree);
        await this.must(worktree, "checkout", "--quiet", "--detach", commit);
      },
    });
  }

  /**
   * The daily sweep: removes every worktree and session folder whose name `keep` doesn't hold, with Claude
   * Code's folder for each removed worktree, and transcripts and hand-run folders older than 30 days.
   */
  async sweep(input: { now: Date; keep: Set<string> }): Promise<string[]> {
    return sweep({ folders: this.folders, ...input });
  }

  /** Whether the repo's cache has a good copy, and how its last refresh went. */
  async cacheState(repo: string): Promise<CacheState> {
    let last: LastRefresh | null = null;
    try {
      last = JSON.parse(await readFile(paths.refresh(this.folders, repo), "utf8")) as LastRefresh;
    } catch {
      // No refresh has ended yet.
    }
    return { current: existsSync(join(paths.cache(this.folders, repo), "current")), last };
  }

  private async takenIds(): Promise<Set<string>> {
    const taken = new Set<string>([...(await list(paths.sessions(this.folders))), ...(await list(paths.worktrees(this.folders)))]);
    for (const file of await list(paths.trials(this.folders))) taken.add(file.replace(/\.jsonl$/, ""));
    for (const owner of await list(join(this.folders.data, "repos"))) {
      for (const repo of await list(join(this.folders.data, "repos", owner))) {
        for (const file of await list(paths.transcripts(this.folders, `${owner}/${repo}`))) taken.add(file.replace(/\.jsonl$/, ""));
      }
    }
    for (const run of await list(paths.handRuns(this.folders))) {
      try {
        const json = JSON.parse(await readFile(join(paths.handRuns(this.folders), run, "session.json"), "utf8")) as { session?: string };
        if (typeof json.session === "string") taken.add(json.session);
      } catch {
        // A hand-run folder without a readable session.json holds no ID.
      }
    }
    return taken;
  }

  /** Runs git with hooks off and none of the maintainer's own git config (ADR 0007). */
  private async git(cwd: string | null, ...args: string[]): Promise<{ ok: true; out: string } | { ok: false; error: string }> {
    const proc = Bun.spawn([this.gitPath, "-c", "core.hooksPath=/dev/null", ...args], {
      cwd: cwd ?? "/",
      env: {
        HOME: process.env.HOME ?? this.folders.home,
        PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
        GIT_CONFIG_GLOBAL: paths.runnerGitconfig(this.folders),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) return { ok: false, error: `git ${args[0]}: ${err.trim() || `exit ${code}`}` };
    return { ok: true, out };
  }

  private async must(cwd: string | null, ...args: string[]): Promise<string> {
    const result = await this.git(cwd, ...args);
    if (!result.ok) throw new Error(result.error);
    return result.out.trim();
  }
}

/** Throws, naming the temp folder, when its path plus `/` plus the longest socket name passes the limit. */
function checkTempFolder(tmp: string): void {
  const bytes = Buffer.byteLength(tmp) + 1 + SOCKET_NAME_BYTES;
  if (bytes <= SOCKET_PATH_BYTES) return;
  throw new Error(
    `The temp folder ${tmp} is too long: with a ${SOCKET_NAME_BYTES}-byte socket name, a socket path in it takes ${bytes} bytes, and macOS allows ${SOCKET_PATH_BYTES}.`,
  );
}

/** Each of the stage's slots, by name, as the absolute paths of its skills' `SKILL.md` files (ADR 0014). */
function slotPaths(plan: PreparePlan, worktree: string): Record<string, string[]> {
  if (plan.stage === "trial" || plan.stage === "debrief") return {};
  const slots: Record<string, string[]> = plan.record.slots[plan.stage];
  return Object.fromEntries(
    Object.entries(slots).map(([slot, entries]) => [
      slot,
      // A shipped skill resolves under the version folder, and a `.claude/skills/` path inside the worktree.
      entries.map((entry) => join(entry.includes("/") ? join(worktree, entry) : join(plan.versionFolder, "skills", entry), "SKILL.md")),
    ]),
  );
}

async function list(folder: string): Promise<string[]> {
  try {
    return await readdir(folder);
  } catch {
    return [];
  }
}
