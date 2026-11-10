// Dependency folders outside the worktree (ADR 0018). Each folder the record lists is a symlink from the
// worktree into the session folder's `deps/`, which holds an APFS clone of the dependency cache, or an empty
// folder when the repo has no good cache yet.
import { existsSync, lstatSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** The file every symlink target holds, because pnpm 11 deletes an empty target and then fails (ADR 0018). */
export const PLACEHOLDER = ".flight-deck-keep";

/** A `dependencies.folders` entry as a path: no trailing `/`. */
export function folderPath(folder: string): string {
  return folder.replace(/\/+$/, "");
}

/** An APFS copy-on-write clone of a folder, with `cp -c -R`, so a write to the copy never reaches the source. */
export async function cloneFolder(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const proc = Bun.spawn(["/bin/cp", "-c", "-R", source, target], { stdout: "ignore", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`cp -c -R ${source}: ${err.trim() || `exit ${code}`}`);
}

/** Makes each dependency folder's target under `deps`, cloned from `cached` when it has a copy, holding at least one file. */
export async function fillDeps(deps: string, folders: string[], cached: string | null): Promise<void> {
  for (const folder of folders.map(folderPath)) {
    const target = join(deps, folder);
    const source = cached === null ? null : join(cached, folder);
    if (source !== null && existsSync(source)) await cloneFolder(source, target);
    else await mkdir(target, { recursive: true });
    if ((await readdir(target)).length === 0) {
      await writeFile(join(target, PLACEHOLDER), "Flight Deck keeps this file so the package manager never finds an empty symlink target.\n");
    }
  }
}

/**
 * Points each dependency folder in the worktree at its target under `deps`, and adds it to the worktree
 * repo's `info/exclude`, because a `.gitignore` entry of `node_modules/` doesn't match a symlink (ADR 0018).
 */
export async function linkDeps(worktree: string, deps: string, folders: string[]): Promise<void> {
  const lines: string[] = [];
  for (const folder of folders.map(folderPath)) {
    const link = join(worktree, folder);
    if (existsSync(link) || isSymlink(link)) {
      throw new Error(`The worktree already holds ${folder}, which dependencies.folders lists. The record can't list a folder the repo commits.`);
    }
    await mkdir(dirname(link), { recursive: true });
    await symlink(join(deps, folder), link);
    lines.push(`/${folder}`);
  }
  if (lines.length === 0) return;
  const exclude = join(worktree, ".git", "info", "exclude");
  await mkdir(dirname(exclude), { recursive: true });
  const have = existsSync(exclude) ? await readFile(exclude, "utf8") : "";
  const gap = have === "" || have.endsWith("\n") ? "" : "\n";
  await appendFile(exclude, `${gap}# Flight Deck: dependency folders are symlinks out of the worktree (ADR 0018)\n${lines.join("\n")}\n`);
}

/** Copies each `copy_files` path from the repo's `files/` folder into the worktree (ADR 0007). */
export async function copyFiles(repo: string, files: string, worktree: string, list: string[]): Promise<void> {
  for (const path of list.map(folderPath)) {
    const source = join(files, path);
    if (!existsSync(source)) throw new Error(`copy_files lists ${path}, which register hasn't copied. Run flight-deck register ${repo} --files.`);
    const target = join(worktree, path);
    await mkdir(dirname(target), { recursive: true });
    await rm(target, { recursive: true, force: true });
    const proc = Bun.spawn(["/bin/cp", "-R", source, target], { stdout: "ignore", stderr: "pipe" });
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`cp -R ${source}: ${err.trim() || `exit ${code}`}`);
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
