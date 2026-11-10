// Version folders (spec 1, "Install", ADR 0015). Each version lives in `versions/<version>/`, `current` links to
// the one in use, and `~/.local/bin/flight-deck` links to `current/bin/flight-deck`. Spec 1 installs local builds
// only: `flight-deck install` run from a build's own `bin/`, and `flight-deck update --from <folder>`.
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readFile, readlink, rename, rm, symlink } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { randomBytes } from "node:crypto";
import { paths, type Folders } from "../folders/index.ts";

/**
 * A version folder's version, which `build-version.sh` stamps on `plugin/.claude-plugin/plugin.json`. Throws
 * when the folder isn't a version folder.
 */
export async function folderVersion(folder: string): Promise<string> {
  const not = `${folder} isn't a Flight Deck version folder`;
  if (!existsSync(join(folder, "bin", "flight-deck"))) throw new Error(`${not}: it has no bin/flight-deck`);
  let version: unknown;
  try {
    version = (JSON.parse(await readFile(join(folder, "plugin", ".claude-plugin", "plugin.json"), "utf8")) as { version?: unknown }).version;
  } catch {
    throw new Error(`${not}: it has no readable plugin/.claude-plugin/plugin.json`);
  }
  if (typeof version !== "string" || !/^[0-9A-Za-z.+-]+$/.test(version)) throw new Error(`${not}: its plugin.json names no version`);
  return version;
}

/** Whether `versions/<version>/` exists. */
export async function isInstalled(folders: Folders, version: string): Promise<boolean> {
  return existsSync(paths.version(folders, version));
}

/** Whether a version folder sits in `versions/`, as an installed binary's does. */
export function inVersions(folders: Folders, versionFolder: string): boolean {
  const path = relative(paths.versions(folders), versionFolder);
  return path !== "" && !path.startsWith("..") && !path.includes("/");
}

/**
 * Copies a version folder into `versions/<version>/`, keeping modes and links. It copies into a temporary
 * folder beside it and renames that into place, so a version in `versions/` is always whole. Throws when the
 * version is already there.
 */
export async function copyVersion(folders: Folders, from: string, version: string): Promise<void> {
  const target = paths.version(folders, version);
  if (existsSync(target)) throw new Error(`${version} is already in versions/`);
  await mkdir(paths.versions(folders), { recursive: true });
  const stage = join(paths.versions(folders), `.${version}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await cp(from, stage, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    await rename(stage, target);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** The version `current` points at, or `null` before the first install. */
export async function currentVersion(folders: Folders): Promise<string | null> {
  try {
    return basename(await readlink(paths.current(folders)));
  } catch {
    return null;
  }
}

/** Points `current` at `versions/<version>/`, in one rename, so nothing ever reads a missing link. */
export async function switchCurrent(folders: Folders, version: string): Promise<void> {
  await replaceLink(paths.current(folders), paths.version(folders, version));
}

/** Links `~/.local/bin/flight-deck` to `current/bin/flight-deck`. It never replaces a file that isn't a link. */
export async function linkBin(folders: Folders): Promise<void> {
  const link = paths.binLink(folders);
  const info = await lstat(link).catch(() => null);
  if (info !== null && !info.isSymbolicLink()) throw new Error(`${link} is a file, not a link. Move it away, then run flight-deck install again.`);
  await replaceLink(link, join(paths.current(folders), "bin", "flight-deck"));
}

async function replaceLink(link: string, target: string): Promise<void> {
  await mkdir(dirname(link), { recursive: true });
  if ((await readlink(link).catch(() => null)) === target) return;
  const temp = `${link}.${randomBytes(4).toString("hex")}.tmp`;
  await symlink(target, temp);
  await rename(temp, link);
}
