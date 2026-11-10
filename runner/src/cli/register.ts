// `flight-deck register <owner/repo>` (spec 1, "Install", ADRs 0006, 0007, 0017, and 0018). It adds the repo to
// `config.toml` and makes Flight Deck's clone, and the runner starts the repo's first cache refresh at its next
// poll, because only the runner writes a cache. It reads the maintainer's checkout, which the runner never does:
// the origin, the record's `[tracker]` (committed or not, so a record still being written can register), and
// each of the record's `copy_files`, which it copies into `repos/<owner>/<repo>/files/` with mode 0600. It checks
// the team with a Flight Deck app token it mints and revokes before it exits (ADR 0005). `--files` copies the
// files again and changes nothing else. Setup's `apply` calls the same code in spec 6.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { paths, type Folders } from "../folders/index.ts";
import { hasWorkspace, readConfig, readCredentials, updateConfig, type Config, type Registration } from "../install/index.ts";
import { readRecordPart, type RepoRecord } from "../record/index.ts";
import { isUnavailable, MintFailed, type TeamCheck } from "../tracker/index.ts";
import { Workspace } from "../workspace/index.ts";
import type { CommandContext } from "./context.ts";

const USAGE = "Usage: flight-deck register <owner/repo> [--checkout <folder>] [--package-manager <path>] [--files]";
const RECORD_PATH = ".flight-deck/record.toml";
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** The lockfiles that name a package manager, in the order `register` looks for them. */
const LOCKFILES: [string, string][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

/** One of `register`'s refusals: the text names the fix. */
class Refusal extends Error {}

interface Options {
  repo: string;
  checkout?: string;
  packageManager?: string;
  files: boolean;
}

export async function registerCommand(argv: string[], context: CommandContext): Promise<number> {
  const options = parseArgs(argv);
  if (options === null) {
    context.err(USAGE);
    return 64;
  }
  try {
    if (options.files) await copyAgain(options.repo, context);
    else await register(options, context);
    return 0;
  } catch (error) {
    if (error instanceof Refusal) context.err(`Refused: ${error.message}`);
    else if (isUnavailable(error)) context.err(`Linear didn't answer (${(error as Error).message}). Run flight-deck register ${options.repo} again.`);
    else throw error;
    return 1;
  }
}

function parseArgs(argv: string[]): Options | null {
  const options: Options = { repo: "", files: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    const value = () => (equals === -1 ? argv[++i] : arg.slice(equals + 1)) || null;
    if (flag === "--files" && equals === -1) options.files = true;
    else if (flag === "--checkout") options.checkout = value() ?? "";
    else if (flag === "--package-manager") options.packageManager = value() ?? "";
    else if (arg.startsWith("-")) return null;
    else positional.push(arg);
  }
  if (positional.length !== 1 || !REPO.test(positional[0]!) || options.checkout === "" || options.packageManager === "") return null;
  // `--files` changes nothing but the copies, so it takes the registration's checkout and package manager.
  if (options.files && (options.checkout !== undefined || options.packageManager !== undefined)) return null;
  options.repo = positional[0]!;
  return options;
}

async function register(options: Options, context: CommandContext): Promise<void> {
  const { repo } = options;
  const config = await readConfigOrEmpty(context.folders);
  const PATH = context.env.PATH ?? "";
  const git = config.paths?.git ?? Bun.which("git", { PATH }) ?? "/usr/bin/git";
  const checkout = resolve(context.cwd, options.checkout ?? ".");

  await checkOrigin(git, checkout, repo, context);
  if (findRepo(config, repo) !== undefined) {
    throw new Refusal(`${repo} is already registered. To copy its copy_files again, run flight-deck register ${repo} --files.`);
  }
  const text = await readRecordText(checkout);
  const tracker = readRecordPart(text, "tracker");
  if (!tracker.ok) throw new Refusal(`the record's [tracker] isn't valid: ${tracker.errors.join("; ")}. Fix it in ${join(checkout, RECORD_PATH)}, then run flight-deck register ${repo} again.`);
  const copyList = copyFiles(text, checkout, repo);
  const packageManager = await findPackageManager(options.packageManager, checkout, text, PATH, context.cwd);

  const { workspace, team } = tracker.value;
  const linear = config.linear?.[workspace];
  if (linear === undefined || !hasWorkspace(await readCredentials(context.folders), workspace)) {
    throw new Refusal(`Flight Deck isn't signed in to Linear workspace ${workspace}. Run flight-deck login linear ${workspace} first.`);
  }
  // One team holds one repo's factory (ADR 0006).
  const sharing = (config.repos ?? []).find((each) => each.tracker.workspace === workspace && each.tracker.team === team);
  if (sharing !== undefined) {
    throw new Refusal(`${sharing.name} already uses team ${team} in ${workspace}, and one team holds one repo's factory. Give ${repo} a team of its own in the record.`);
  }
  const check = await checkTeam(context, { name: repo, workspace, team, statuses: tracker.value.statuses, maintainer: linear.maintainer_id });
  if (!check.ok && check.reason === "unreadable") {
    throw new Refusal(
      `the Flight Deck app can't read team ${team} in ${workspace}. Check the team key in the record. If the team is private, give both Flight Deck apps access to it in the team's settings in Linear.`,
    );
  }

  const copied = await copyInto(context.folders, repo, checkout, copyList);
  const registration: Registration = {
    name: repo,
    remote: context.remoteOf?.(repo) ?? `https://github.com/${repo}.git`,
    checkout,
    package_manager: packageManager,
    path: capturedPath(packageManager, PATH),
    tracker: tracker.value,
  };
  await updateConfig(context.folders, (file) => {
    file.repos = [...((file.repos as unknown[] | undefined) ?? []), registration];
  });

  if (!check.ok && check.reason === "missing") {
    for (const role of check.roles) {
      context.out(`Team ${team} has no status named ${tracker.value.statuses[role]}, which [tracker.statuses] names for ${role}. The runner starts no session for the repo until the team has it.`);
    }
  }
  const fetched = await new Workspace({ folders: context.folders, git }).fetch(registration);
  if (!fetched.ok) context.out(`Flight Deck couldn't clone ${repo} yet: ${fetched.error.trim()}. The runner tries again at its next poll.`);
  context.out(`Registered ${repo} on team ${team} in ${workspace}, with ${count(copied, "copied file")}. The runner refreshes its dependency cache at its next poll.`);
}

/** `--files`: the record's `copy_files` from the registration's checkout, copied again, and nothing else. */
async function copyAgain(repo: string, context: CommandContext): Promise<void> {
  const config = await readConfigOrEmpty(context.folders);
  const registration = findRepo(config, repo);
  if (registration === undefined) throw new Refusal(`${repo} isn't registered, so there's nothing to copy again. Run flight-deck register ${repo} without --files.`);
  const git = config.paths?.git ?? Bun.which("git", { PATH: context.env.PATH ?? "" }) ?? "/usr/bin/git";
  await checkOrigin(git, registration.checkout, registration.name, context);
  const text = await readRecordText(registration.checkout);
  const copied = await copyInto(context.folders, registration.name, registration.checkout, copyFiles(text, registration.checkout, repo));
  context.out(`Copied ${count(copied, "file")} for ${registration.name} again. The next session gets the new copies.`);
}

async function readConfigOrEmpty(folders: Folders): Promise<Partial<Config>> {
  if (!existsSync(paths.configToml(folders))) return {};
  return readConfig(folders);
}

/** GitHub's names are case-insensitive, so the registration matches in any case. */
function findRepo(config: Partial<Config>, repo: string): Registration | undefined {
  return (config.repos ?? []).find((each) => each.name.toLowerCase() === repo.toLowerCase());
}

/** The checkout's `origin` must name `github.com/<owner>/<repo>`, in its HTTPS or SSH form, with or without `.git`. */
async function checkOrigin(git: string, checkout: string, repo: string, context: CommandContext): Promise<void> {
  const fix = "Run flight-deck register in the repo's own checkout, or pass --checkout <folder>.";
  const run = Bun.spawn([git, "-C", checkout, "remote", "get-url", "origin"], { env: { ...context.env, GIT_TERMINAL_PROMPT: "0" }, stdout: "pipe", stderr: "ignore" });
  const [out, code] = await Promise.all([new Response(run.stdout).text(), run.exited]);
  const origin = out.trim();
  if (code !== 0 || origin === "") throw new Refusal(`${checkout} has no origin remote, so it isn't github.com/${repo}'s checkout. ${fix}`);
  const named = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(origin)?.[1];
  if (named?.toLowerCase() !== repo.toLowerCase()) throw new Refusal(`${checkout}'s origin is ${origin}, which isn't github.com/${repo}. ${fix}`);
}

/** The checkout's record as it is on disk, committed or not. */
async function readRecordText(checkout: string): Promise<string> {
  const text = await readFile(join(checkout, RECORD_PATH), "utf8").catch(() => null);
  if (text === null) throw new Refusal(`${checkout} has no ${RECORD_PATH}. Write the record first: register reads it whether it's committed or not.`);
  return text;
}

/** The record's `copy_files`, or none when a record still being written has no such key. */
function copyFiles(text: string, checkout: string, repo: string): RepoRecord["copy_files"] {
  const read = readRecordPart(text, "copy_files");
  if (read.ok) return read.value;
  if (read.errors.length === 1 && read.errors[0] === "copy_files: is missing") return [];
  throw new Refusal(`the record's copy_files isn't valid: ${read.errors.join("; ")}. Fix it in ${join(checkout, RECORD_PATH)}, then run flight-deck register ${repo} again.`);
}

/**
 * The package manager: `--package-manager`, or else the one the checkout's `packageManager` field or lockfile
 * names, or else the first word of the record's `dependencies.command`, found on the maintainer's `PATH` (ADR 0018).
 */
async function findPackageManager(flag: string | undefined, checkout: string, text: string, PATH: string, cwd: string): Promise<string> {
  const fix = "Pass --package-manager <absolute path>.";
  if (flag !== undefined) {
    const path = resolve(cwd, flag);
    if (!(await isProgram(path))) throw new Refusal(`${path} isn't a program Flight Deck can run. ${fix}`);
    return path;
  }
  const named = await namedPackageManager(checkout, text);
  if (named === null) throw new Refusal(`Flight Deck can't tell which package manager ${checkout} uses. ${fix}`);
  const found = Bun.which(named.name, { PATH });
  if (found === null) throw new Refusal(`${named.name}, which ${named.source} names, isn't on your PATH. ${fix}`);
  return found;
}

async function namedPackageManager(checkout: string, text: string): Promise<{ name: string; source: string } | null> {
  const manifest = await readFile(join(checkout, "package.json"), "utf8").then(
    (json) => JSON.parse(json) as { packageManager?: unknown },
    () => null,
  );
  // `pnpm@10.34.5+sha512.<hash>` names pnpm.
  const field = typeof manifest?.packageManager === "string" ? manifest.packageManager.split("@")[0]! : "";
  if (field !== "") return { name: field, source: "package.json's packageManager" };
  const lockfile = LOCKFILES.find(([file]) => existsSync(join(checkout, file)));
  if (lockfile !== undefined) return { name: lockfile[1], source: lockfile[0] };
  const command = ((Bun.TOML.parse(text) as { dependencies?: { command?: unknown } }).dependencies?.command ?? "") as unknown;
  const word = typeof command === "string" ? command.trim().split(/\s+/)[0]! : "";
  return word === "" ? null : { name: word, source: "the record's dependencies.command" };
}

async function isProgram(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  return info !== null && info.isFile() && (info.mode & 0o111) !== 0;
}

/** The `PATH` register runs in, with the package manager's folder first and only once. */
function capturedPath(packageManager: string, PATH: string): string {
  const folder = dirname(packageManager);
  return [folder, ...PATH.split(":").filter((each) => each !== "" && each !== folder)].join(":");
}

/** The team check, with a Flight Deck app token minted for it and revoked before register goes on (ADR 0005). */
async function checkTeam(context: CommandContext, repo: { name: string; workspace: string; team: string; statuses: RepoRecord["tracker"]["statuses"]; maintainer: string }): Promise<TeamCheck> {
  const tracker = context.adapters.appTracker({ folders: context.folders });
  try {
    await tracker.runnerToken(repo.workspace);
    return await tracker.checkTeam(repo);
  } catch (error) {
    if (error instanceof MintFailed) {
      throw new Refusal(
        `${error.message}, so Flight Deck can't check team ${repo.team}. Run flight-deck login linear ${repo.workspace} again with the Flight Deck app's client ID and secret.`,
      );
    }
    throw error;
  } finally {
    await tracker.revokeRunnerToken(repo.workspace);
  }
}

/**
 * Copies each `copy_files` path from the checkout into the repo's `files/` folder, keeping its path, each file
 * with mode 0600. The copies go to a new folder first, which replaces `files/` only when every path copied, so a
 * missing file leaves the old copies. Returns how many files it copied.
 */
async function copyInto(folders: Folders, repo: string, checkout: string, list: string[]): Promise<number> {
  const files = paths.files(folders, repo);
  await mkdir(dirname(files), { recursive: true });
  const suffix = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const next = `${files}.new-${suffix}`;
  await mkdir(next, { mode: 0o700 });
  let copied = 0;
  try {
    for (const entry of list) {
      const path = entry.replace(/\/+$/, "");
      const source = join(checkout, path);
      if (!existsSync(source)) {
        throw new Refusal(`copy_files lists ${path}, which ${checkout} doesn't hold. Create the file, or take it out of copy_files, then run flight-deck register ${repo} again.`);
      }
      copied += await copy(source, join(next, path));
    }
    const old = `${files}.old-${suffix}`;
    if (existsSync(files)) await rename(files, old);
    await rename(next, files);
    await rm(old, { recursive: true, force: true });
    return copied;
  } finally {
    await rm(next, { recursive: true, force: true });
  }
}

/** Copies a file, or a folder and everything in it, following symlinks. Files get mode 0600 and folders 0700. */
async function copy(source: string, target: string): Promise<number> {
  const info = await stat(source);
  if (info.isDirectory()) {
    await mkdir(target, { recursive: true, mode: 0o700 });
    let copied = 0;
    for (const name of await readdir(source)) copied += await copy(join(source, name), join(target, name));
    return copied;
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, await readFile(source), { mode: 0o600 });
  await chmod(target, 0o600);
  return 1;
}

function count(n: number, noun: string): string {
  return n === 0 ? `no ${noun}s` : `${n} ${noun}${n === 1 ? "" : "s"}`;
}
