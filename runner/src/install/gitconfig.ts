// `gitconfig-runner`, the git config for the runner's own git commands (spec 1, "Workspace", ADR 0005).
// Workspace runs git with `GIT_CONFIG_GLOBAL` set to it and `GIT_CONFIG_NOSYSTEM=1`, so no rule from the
// maintainer's own git config applies. Its one credential helper is `gh auth git-credential` with `GH_CONFIG_DIR`
// set to Flight Deck's `gh/` folder, so git uses only the machine user's login. `login github` writes it.
import { paths, type Folders } from "../folders/index.ts";
import { writeAtomic } from "../state/files.ts";
import { shellQuote } from "./launchd.ts";

export async function writeRunnerGitconfig(folders: Folders, gh: string): Promise<void> {
  // Git runs a `!` helper through the shell, with `get`, `store`, or `erase` after it. The empty helper first
  // drops any helper set before this file.
  const helper = `!GH_CONFIG_DIR=${shellQuote(paths.ghConfig(folders))} ${shellQuote(gh)} auth git-credential`;
  await writeAtomic(paths.runnerGitconfig(folders), `[credential]\n\thelper =\n\thelper = ${gitQuote(helper)}\n`);
}

/** A git config value in double quotes. */
function gitQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
