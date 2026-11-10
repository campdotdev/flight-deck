// The cache refresh (spec 1, "Workspace", ADR 0018): the record's dependency install in a scratch worktree of
// the default branch, under the pinned `sandbox-runtime`, run with the `flight-deck` binary as its JavaScript
// runtime through BUN_BE_BUN. It writes `next/`, then swaps it in for `current/` with two renames. A failed
// refresh deletes `next/` and keeps the last good `current/`.
import { spawn } from "node:child_process";
import { existsSync, openSync, closeSync } from "node:fs";
import { mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paths, sessionParts, type Folders } from "../folders/index.ts";
import type { Registration } from "../install/index.ts";
import { durationMs, type RepoRecord } from "../record/index.ts";
import { sandboxPolicy } from "../sandbox-policy/index.ts";
import { writeJson } from "../state/files.ts";
import { fillDeps, linkDeps } from "./deps.ts";
import { emptyConfigFolders, sessionEnv } from "./env.ts";

/** `sandbox-runtime`'s command line inside the version folder's `vendor/sandbox-runtime/`. */
export const SANDBOX_RUNTIME_CLI = "node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js";

export interface RefreshInput {
  folders: Folders;
  repo: Registration;
  /** The record at `commit`, which names the install and its folders. */
  record: RepoRecord;
  /** The default branch's tip. */
  commit: string;
  /** The running version's folder, whose binary and `vendor/sandbox-runtime/` run the install. */
  versionFolder: string;
  /** When the refresh starts, on the runner's clock. */
  now: Date;
  /** The refresh's own session ID, which names its session folder and temp folder (spec 1, "Session IDs"). */
  session: string;
  /** Makes the scratch worktree: a shared clone of Flight Deck's clone, detached at the commit. */
  clone: (worktree: string, commit: string) => Promise<void>;
}

export type RefreshResult = { ok: true } | { ok: false; error: string };

export interface RefreshJob {
  repo: string;
  session: string;
  commit: string;
  /** ISO time, on the runner's clock. */
  startedAt: string;
  /** Resolves once the refresh has ended and cleaned up. */
  done: Promise<RefreshResult>;
  /** Kills the install's process group. The cache stays at the last good copy. */
  kill: () => void;
}

export async function refreshCache(input: RefreshInput): Promise<RefreshJob> {
  const { folders, repo, record, commit, session } = input;
  const cache = paths.cache(folders, repo.name);
  const next = join(cache, "next");
  const sessionFolder = paths.sessionFolder(folders, session);
  const parts = sessionParts(sessionFolder);
  const worktree = paths.cacheWorktree(folders, repo.name);
  const log = join(sessionFolder, "install.log");
  let pid: number | null = null;
  let stopped: string | null = null;
  const kill = (why: string) => {
    if (stopped !== null) return;
    stopped = why;
    if (pid !== null) killGroup(pid);
  };

  const run = async (): Promise<RefreshResult> => {
    // A crashed earlier refresh can leave each of these.
    for (const leftover of [next, worktree, sessionFolder]) await rm(leftover, { recursive: true, force: true });

    // `next/` holds `deps/<folder>` for each dependency folder and `home/` for the package manager's folders.
    // The refresh's session folder points its `deps/` and `home/` there, so it gets a session's `env` block
    // and symlinks, with its own `tmp/` as its temp folder.
    await fillDeps(join(next, "deps"), record.dependencies.folders, null);
    await mkdir(join(next, "home"), { recursive: true });
    await mkdir(parts.tmp, { recursive: true });
    await symlink(join(next, "deps"), parts.deps);
    await symlink(join(next, "home"), parts.home);
    for (const folder of emptyConfigFolders(sessionFolder)) await mkdir(folder, { recursive: true });
    await mkdir(paths.worktrees(folders), { recursive: true });
    await input.clone(worktree, commit);
    await linkDeps(worktree, parts.deps, record.dependencies.folders);

    const settings = join(sessionFolder, "sandbox-runtime.json");
    const policy = sandboxPolicy({ kind: "refresh", folders, repo: repo.name, record, versionFolder: input.versionFolder, worktree, sessionFolder });
    await writeFile(settings, `${JSON.stringify(policy, null, 2)}\n`);
    if (stopped !== null) return { ok: false, error: stopped };

    const limit = record.time_limits.plan;
    const timer = setTimeout(() => kill(`the dependency install ran past plan's time limit of ${limit}`), durationMs(limit));
    const code = await install(input, worktree, sessionFolder, settings, log, (started) => {
      pid = started;
      if (stopped !== null) killGroup(started);
    });
    clearTimeout(timer);
    if (stopped !== null) return { ok: false, error: stopped };
    if (code !== 0) return { ok: false, error: `the dependency install exited ${code}:\n${await tail(log)}` };

    // Two renames, so `current/` is never half a copy. A session that starts between them gets empty folders.
    const current = join(cache, "current");
    const old = join(cache, "old");
    await rm(old, { recursive: true, force: true });
    if (existsSync(current)) await rename(current, old);
    await rename(next, current);
    await rm(old, { recursive: true, force: true });
    return { ok: true };
  };

  const done = run()
    .catch((error: Error): RefreshResult => ({ ok: false, error: error.message }))
    .then(async (result) => {
      await rm(next, { recursive: true, force: true });
      await rm(worktree, { recursive: true, force: true });
      await rm(sessionFolder, { recursive: true, force: true });
      await writeJson(paths.refresh(folders, repo.name), { commit, at: input.now.toISOString(), ok: result.ok });
      return result;
    });
  return { repo: repo.name, session, commit, startedAt: input.now.toISOString(), done, kill: () => kill("the dependency install was stopped") };
}

/** Runs the install under `sandbox-runtime` in its own process group, and resolves with its exit code. */
function install(input: RefreshInput, worktree: string, sessionFolder: string, settings: string, log: string, started: (pid: number) => void): Promise<number> {
  const env = {
    HOME: input.folders.home,
    USER: process.env.USER ?? "",
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "",
    SHELL: "/bin/bash",
    ...sessionEnv({ folders: input.folders, sessionFolder, path: input.repo.path }),
    // The binary acts as Bun, so Node needn't be on the Mac (ADR 0003).
    BUN_BE_BUN: "1",
  };
  const runtime = paths.bin(input.versionFolder);
  const cli = join(input.versionFolder, "vendor", "sandbox-runtime", SANDBOX_RUNTIME_CLI);
  const out = openSync(log, "a");
  return new Promise((resolve) => {
    const child = spawn(runtime, [cli, "--settings", settings, "-c", input.record.dependencies.command], {
      cwd: worktree,
      env,
      detached: true,
      stdio: ["ignore", out, out],
    });
    closeSync(out);
    if (child.pid !== undefined) started(child.pid);
    child.on("error", () => resolve(127));
    child.on("exit", (code, signal) => {
      // The install may leave children in its group, such as a package manager's workers.
      if (child.pid !== undefined) killGroup(child.pid);
      resolve(code ?? (signal === null ? 1 : 128));
    });
  });
}

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group has already gone.
  }
}

/** The install's last 20 lines, for the log. */
async function tail(log: string): Promise<string> {
  const text = await readFile(log, "utf8").catch(() => "");
  return text.trimEnd().split("\n").slice(-20).join("\n");
}
