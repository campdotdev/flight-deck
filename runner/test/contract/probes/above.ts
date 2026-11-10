// The probes' `CLAUDE.md` in the folder above the worktree: `<session root>/worktrees/CLAUDE.md`, beside every
// session's worktree. A probe writes it, and removes it when it ends.
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paths, type Folders } from "../../../src/folders/index.ts";

/** Writes the file and returns what removes it. Refuses when one is already there, so a probe never overwrites one. */
export async function claudeMdAboveWorktrees(folders: Folders, text: string): Promise<{ path: string; remove(): Promise<void> }> {
  const path = join(paths.worktrees(folders), "CLAUDE.md");
  if (existsSync(path)) throw new Error(`${path} exists already. A probe left it, or someone wrote it: read it, remove it, then run the probe again.`);
  await writeFile(path, text);
  return { path, remove: () => rm(path, { force: true }) };
}

/** A probe run's token, which every canary and every file the probe asks the session to write holds. */
export function runToken(): string {
  return Date.now().toString(36).toUpperCase();
}
