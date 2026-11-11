// A repo can commit a symlink to a folder outside the worktree. Flight Deck's writes into the worktree refuse to
// go through one (ADRs 0007 and 0018).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyFiles, linkDeps } from "../../src/workspace/deps.ts";

let root: string;
let worktree: string;
let outside: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "deps-")));
  worktree = join(root, "worktree");
  outside = join(root, "outside");
  await mkdir(worktree);
  await mkdir(outside);
  await writeFile(join(outside, ".env"), "KEEP=1\n");
  // The repo's committed symlink: `apps` points out of the worktree.
  await symlink(outside, join(worktree, "apps"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("copyFiles refuses a path under a symlinked folder and leaves its target alone", async () => {
  const files = join(root, "files");
  await mkdir(join(files, "apps"), { recursive: true });
  await writeFile(join(files, "apps", ".env"), "SECRET=1\n");
  await expect(copyFiles("campdotdev/shaders", files, worktree, ["apps/.env"])).rejects.toThrow(
    "The worktree holds apps as a symlink or a file, so Flight Deck won't write apps/.env through it.",
  );
  expect(await readFile(join(outside, ".env"), "utf8")).toBe("KEEP=1\n");
});

test("linkDeps refuses a folder under a symlinked folder and makes no link outside the worktree", async () => {
  await expect(linkDeps(worktree, join(root, "deps"), ["apps/web/node_modules"])).rejects.toThrow(
    "The worktree holds apps as a symlink or a file, so Flight Deck won't write apps/web/node_modules through it.",
  );
  expect(await readdir(outside)).toEqual([".env"]);
});

test("copyFiles and linkDeps still make the folders a path needs inside the worktree", async () => {
  const files = join(root, "files");
  await mkdir(join(files, "packages", "web"), { recursive: true });
  await writeFile(join(files, "packages", "web", ".env"), "LOCAL=1\n");
  await copyFiles("campdotdev/shaders", files, worktree, ["packages/web/.env"]);
  await linkDeps(worktree, join(root, "deps"), ["packages/web/node_modules"]);
  expect(await readFile(join(worktree, "packages", "web", ".env"), "utf8")).toBe("LOCAL=1\n");
  expect(existsSync(join(worktree, ".git", "info", "exclude"))).toBe(true);
});
