// The runner's log starts a new file past 10 MB, keeping one old log (spec 1, "Workspace").
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Folders } from "../../src/folders/index.ts";
import { State } from "../../src/state/index.ts";

let root: string;
let folders: Folders;
let state: State;

beforeEach(async () => {
  root = await realpath(await mkdtemp("/tmp/fd-state-"));
  folders = { data: join(root, "data"), config: join(root, "config"), sessionRoot: join(root, "session-root"), home: join(root, "home") };
  state = new State(folders);
  await mkdir(join(folders.data, "state"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const log = () => join(folders.data, "state", "runner.log");
const old = () => join(folders.data, "state", "runner.log.1");

test("a log at 10 MB stays", async () => {
  await writeFile(log(), Buffer.alloc(10 * 1024 * 1024, "a"));
  await state.rotateLog();
  expect(existsSync(log())).toBe(true);
  expect(existsSync(old())).toBe(false);
});

test("a log past 10 MB becomes the old log, replacing the one before, and the next line starts a new log", async () => {
  await writeFile(old(), "older\n");
  await writeFile(log(), Buffer.alloc(10 * 1024 * 1024 + 1, "a"));
  await state.rotateLog();
  expect((await readFile(old())).length).toBe(10 * 1024 * 1024 + 1);
  await state.log(new Date("2026-11-10T09:00:00Z"), "polled");
  expect(await readFile(log(), "utf8")).toBe("2026-11-10T09:00:00.000Z polled\n");
});

test("no log yet is fine", async () => {
  await state.rotateLog();
  expect(existsSync(log())).toBe(false);
});
