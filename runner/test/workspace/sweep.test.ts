// The daily sweep, with real folders in a temporary root (spec 1, "Workspace").
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../../src/folders/index.ts";
import { Workspace } from "../../src/workspace/index.ts";
import { World } from "../scenario/world.ts";

let world: World;
let workspace: Workspace;

beforeEach(async () => {
  world = await World.create({ cache: false });
  workspace = new Workspace({ folders: world.folders, git: world.config.paths.git });
});

afterEach(async () => {
  await world.cleanup();
});

const NOW = new Date("2026-12-20T03:05:00Z");
const DAY = 24 * 60 * 60_000;

async function folder(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return path;
}

async function file(path: string, age: number): Promise<string> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, "");
  const at = new Date(NOW.getTime() - age);
  await utimes(path, at, at);
  return path;
}

test("removes each worktree and session folder it isn't told to keep, with Claude Code's folder for the worktree", async () => {
  const f = world.folders;
  const listed = [await folder(paths.worktree(f, "aaaaaa")), await folder(paths.sessionFolder(f, "aaaaaa"))];
  const refresh = [await folder(paths.cacheWorktree(f, "campdotdev/shaders")), await folder(paths.sessionFolder(f, "rrrrrr"))];
  const stray = [await folder(paths.worktree(f, "zzzzzz")), await folder(paths.sessionFolder(f, "zzzzzz"))];
  const leftover = await folder(paths.cacheWorktree(f, "campdotdev/other"));
  const strayProject = await folder(paths.claudeProject(f, stray[0]!));
  const listedProject = await folder(paths.claudeProject(f, listed[0]!));

  const removed = await workspace.sweep({ now: NOW, keep: new Set(["aaaaaa", "rrrrrr", "cache-campdotdev-shaders"]) });

  for (const path of [...listed, ...refresh, listedProject]) expect(existsSync(path)).toBe(true);
  for (const path of [...stray, leftover, strayProject]) expect(existsSync(path)).toBe(false);
  expect(removed.sort()).toEqual([...stray, leftover].sort());
});

test("deletes transcripts and hand-run folders older than 30 days", async () => {
  const transcripts = paths.transcripts(world.folders, "campdotdev/shaders");
  const oldTranscript = await file(join(transcripts, "aaaaaa.jsonl"), 31 * DAY);
  const newTranscript = await file(join(transcripts, "bbbbbb.jsonl"), 29 * DAY);
  const handRuns = paths.handRuns(world.folders);
  // A hand-run folder's name carries its time, whatever its files' times say.
  const oldRun = await folder(join(handRuns, "SHA-1-20261119T030000Z"));
  const newRun = await folder(join(handRuns, "SHA-2-20261121T030000Z"));

  await workspace.sweep({ now: NOW, keep: new Set() });

  expect(existsSync(oldTranscript)).toBe(false);
  expect(existsSync(newTranscript)).toBe(true);
  expect(existsSync(oldRun)).toBe(false);
  expect(existsSync(newRun)).toBe(true);
});
