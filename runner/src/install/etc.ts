// `etc/` under the session root: the files every session's sandbox reads, outside `~` because sandboxed
// commands can't read under it (spec 1, "Folders and files", ADR 0007). The runner writes them at each start,
// from the running version's `data/` and `config.toml`'s `[machine_user]`, and again when `[machine_user]` changes.
import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import retryReset from "../../../data/retry-reset.cjs" with { type: "text" };
import { paths, type Folders } from "../folders/index.ts";
import { writeAtomic } from "../state/files.ts";
import type { Config } from "./config.ts";

export type MachineUser = NonNullable<Config["machine_user"]>;

/**
 * Writes `etc/gitconfig`, `etc/npmrc`, and `etc/retry-reset.cjs`. The session root comes first, with mode `0700`,
 * and a looser mode it had goes, because every session's worktree and folder sit under it.
 */
export async function writeEtc(folders: Folders, machineUser: MachineUser | undefined): Promise<void> {
  // `/Users/Shared/flight-deck/` keeps its own mode, because each user on the Mac has a root inside it.
  await mkdir(dirname(folders.sessionRoot), { recursive: true });
  await mkdir(folders.sessionRoot, { recursive: true, mode: 0o700 });
  await chmod(folders.sessionRoot, 0o700);
  await writeAtomic(paths.etcGitconfig(folders), gitconfig(machineUser));
  await writeAtomic(paths.etcNpmrc(folders), NPMRC);
  await writeAtomic(paths.etcRetryReset(folders), retryReset);
}

/**
 * The commit identity is the machine user's name and GitHub noreply email (ADR 0007). Before `login github`
 * there is no machine user, so the file holds no identity and a commit fails until there is one.
 */
function gitconfig(machineUser: MachineUser | undefined): string {
  const lines: string[] = [];
  if (machineUser !== undefined) lines.push("[user]", `\tname = ${quote(machineUser.name)}`, `\temail = ${quote(machineUser.email)}`);
  // No hook runs, and a session's git asks no credential helper.
  lines.push("[core]", "\thooksPath = /dev/null", "[credential]", '\thelper = ""', "[init]", "\tdefaultBranch = main");
  return `${lines.join("\n")}\n`;
}

/** No registry token reaches a session (ADR 0018). */
const NPMRC = "registry=https://registry.npmjs.org/\nfund=false\naudit=false\nupdate-notifier=false\n";

/** A git config value in double quotes, so `#`, `;`, and spaces at either end stay part of it. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}
