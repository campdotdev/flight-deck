// The dependency cache, the dependency folders, and the copied files, with real git, real APFS clones, and the
// vendored sandbox-runtime in a temporary root (spec 1, "Workspace" and "Other module tests").
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paths, type Folders } from "../../src/folders/index.ts";
import { readRecord, type RepoRecord } from "../../src/record/index.ts";
import { Workspace, type PreparePlan } from "../../src/workspace/index.ts";
import { SHADERS_RECORD, World } from "../scenario/world.ts";

let world: World;
let workspace: Workspace;

beforeEach(async () => {
  world = await World.create({ cache: false });
  workspace = new Workspace({ folders: world.folders, git: world.config.paths.git });
  await workspace.fetch(registration());
});

afterEach(async () => {
  await world.cleanup();
});

const REPO = "campdotdev/shaders";
const registration = () => world.config.repos[0]!;

/** Shaders' test record, with other dependency settings, copied files, or plan time limit. */
function record(change: { command?: string; folders?: string[]; copyFiles?: string[]; plan?: string } = {}): RepoRecord {
  let text = SHADERS_RECORD;
  if (change.command !== undefined) text = text.replace(/^command = .*$/m, `command = '${change.command}'`);
  if (change.folders !== undefined) text = text.replace('folders = ["node_modules"]', `folders = ${JSON.stringify(change.folders)}`);
  if (change.copyFiles !== undefined) text = text.replace("copy_files = []", `copy_files = ${JSON.stringify(change.copyFiles)}`);
  if (change.plan !== undefined) text = text.replace('plan = "30m"', `plan = "${change.plan}"`);
  const result = readRecord(text);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.record;
}

function plan(session: string, repoRecord: RepoRecord = record()): PreparePlan {
  return {
    session,
    stage: "plan",
    mode: "issue",
    repo: registration(),
    record: repoRecord,
    issue: "SHA-1",
    team: "SHA",
    branch: "main",
    base: "main",
    commit: world.commit,
    deadline: "2026-11-10T09:30:00.000Z",
    attempt: 1,
    maintainer: { id: "maintainer", name: "Hunter" },
    appUser: "flight-deck-app",
    version: world.version,
    versionFolder: world.versionFolder,
    inbox: { previousBrief: null, syncedComments: [] },
  };
}

async function refresh(repoRecord: RepoRecord = record()) {
  const job = await workspace.refreshCache({ repo: registration(), record: repoRecord, commit: world.commit, versionFolder: world.versionFolder, now: world.now });
  return { job, result: await job.done };
}

function git(cwd: string, ...args: string[]): string {
  return Bun.spawnSync(["git", ...args], { cwd }).stdout.toString().trim();
}

const cache = () => paths.cache(world.folders, REPO);

describe("dependency folders", () => {
  test("with no cache, each one is a symlink to an empty folder of the session's that holds one file, and git ignores it", async () => {
    const prepared = await workspace.prepare(plan(await workspace.newSessionId(), record({ folders: ["node_modules", "packages/core/node_modules/"] })));
    for (const folder of ["node_modules", "packages/core/node_modules"]) {
      const link = join(prepared.worktree, folder);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link)).toBe(join(prepared.deps, folder));
      // pnpm 11 deletes an empty symlink target and then fails (ADR 0018).
      expect(await readdir(link)).toEqual([".flight-deck-keep"]);
    }
    expect(await readFile(join(prepared.worktree, ".git", "info", "exclude"), "utf8")).toContain("/node_modules\n/packages/core/node_modules\n");
    expect(git(prepared.worktree, "status", "--porcelain", "--untracked-files=all")).toBe("");
    // The cache's `home/` is missing too, so `home/` holds only the empty config folders.
    expect((await readdir(join(prepared.home, "config"))).sort()).toEqual(["turborepo", "vercel"]);
  });

  test("the session's folders are APFS clones of the cache, and a write to them leaves the cache as it was", async () => {
    expect((await refresh()).result).toEqual({ ok: true });
    const prepared = await workspace.prepare(plan(await workspace.newSessionId()));

    const cached = join(cache(), "current", "deps", "node_modules", "pkg", "index.js");
    const cloned = join(prepared.worktree, "node_modules", "pkg", "index.js");
    expect(await readFile(cloned, "utf8")).toBe("installed\n");
    expect(realpathSync(cloned)).toBe(join(prepared.deps, "node_modules", "pkg", "index.js"));
    expect(statSync(cloned).ino).not.toBe(statSync(cached).ino);
    expect(await readFile(join(prepared.home, "data", "pnpm", "store", "blob"), "utf8")).toBe("stored\n");

    await writeFile(cloned, "patched\n");
    await writeFile(join(prepared.home, "data", "pnpm", "store", "blob"), "patched\n");
    expect(await readFile(cached, "utf8")).toBe("installed\n");
    expect(await readFile(join(cache(), "current", "home", "data", "pnpm", "store", "blob"), "utf8")).toBe("stored\n");
  });

  test("the empty config folders turbo and Vercel get stay empty when the cache's home has them", async () => {
    const command = 'mkdir -p node_modules "$TURBO_CONFIG_DIR_PATH" && echo login > "$TURBO_CONFIG_DIR_PATH/config.json"';
    expect((await refresh(record({ command }))).result).toEqual({ ok: true });
    const prepared = await workspace.prepare(plan(await workspace.newSessionId()));
    expect(await readdir(join(prepared.home, "config", "turborepo"))).toEqual([]);
    expect(await readdir(join(prepared.home, "config", "vercel"))).toEqual([]);
  });
});

describe("copied files", () => {
  test("each copy_files path comes from the repo's files/ folder into the worktree", async () => {
    const files = paths.files(world.folders, REPO);
    await mkdir(join(files, "apps", "docs"), { recursive: true });
    await writeFile(join(files, ".env"), "TOKEN=1\n");
    await writeFile(join(files, "apps", "docs", ".env.local"), "TOKEN=2\n");
    const prepared = await workspace.prepare(plan(await workspace.newSessionId(), record({ copyFiles: [".env", "apps/docs/.env.local"] })));
    expect(await readFile(join(prepared.worktree, ".env"), "utf8")).toBe("TOKEN=1\n");
    expect(await readFile(join(prepared.worktree, "apps", "docs", ".env.local"), "utf8")).toBe("TOKEN=2\n");
  });

  test("a file that register never copied fails prepare and names register --files", async () => {
    const id = await workspace.newSessionId();
    await expect(workspace.prepare(plan(id, record({ copyFiles: [".env"] })))).rejects.toThrow(
      "copy_files lists .env, which register hasn't copied. Run flight-deck register campdotdev/shaders --files.",
    );
  });
});

describe("the temp-folder limit", () => {
  test("prepare fails and names the temp folder when its path leaves no room for a socket name", async () => {
    const folders: Folders = { ...world.folders, sessionRoot: join(world.root, "s".repeat(80)) };
    const long = new Workspace({ folders, git: world.config.paths.git });
    const id = await long.newSessionId();
    const tmp = join(folders.sessionRoot, "sessions", id, "tmp");
    await expect(long.prepare(plan(id))).rejects.toThrow(`The temp folder ${tmp} is too long`);
    expect(existsSync(join(folders.sessionRoot, "worktrees", id))).toBe(false);
  });
});

describe("refreshCache", () => {
  test("installs in a scratch worktree into current/, then removes the scratch worktree, its session folder, and next/", async () => {
    const { job, result } = await refresh();
    expect(result).toEqual({ ok: true });
    expect(job.session).toMatch(/^[0-9a-z]{6}$/);
    expect((await readdir(cache())).sort()).toEqual(["current"]);
    expect((await readdir(join(cache(), "current"))).sort()).toEqual(["deps", "home"]);
    expect(await readFile(join(cache(), "current", "deps", "node_modules", "pkg", "index.js"), "utf8")).toBe("installed\n");
    expect(existsSync(paths.worktree(world.folders, "cache-campdotdev-shaders"))).toBe(false);
    expect(existsSync(paths.sessionFolder(world.folders, job.session))).toBe(false);
    expect(await workspace.cacheState(REPO)).toEqual({ current: true, last: { commit: world.commit, at: world.now.toISOString(), ok: true } });
  });

  test("runs the install under sandbox-runtime, so it can't write outside its own folders", async () => {
    const escaped = join(world.folders.home, "escaped");
    const { result } = await refresh(record({ command: `mkdir -p node_modules && echo x > ${escaped}` }));
    expect(result.ok).toBe(false);
    expect(existsSync(escaped)).toBe(false);
  });

  test("a failed refresh deletes next/ and keeps the last good current/", async () => {
    await refresh();
    const { result } = await refresh(record({ command: "mkdir -p node_modules/pkg && echo broken > node_modules/pkg/index.js && exit 3" }));
    expect(result).toEqual({ ok: false, error: expect.stringContaining("exited 3") });
    expect((await readdir(cache())).sort()).toEqual(["current"]);
    expect(await readFile(join(cache(), "current", "deps", "node_modules", "pkg", "index.js"), "utf8")).toBe("installed\n");
    expect(await workspace.cacheState(REPO)).toEqual({ current: true, last: { commit: world.commit, at: world.now.toISOString(), ok: false } });
  });

  test("a refresh past plan's time limit is killed and counts as failed", async () => {
    const started = Date.now();
    const { result } = await refresh(record({ command: "sleep 30", plan: "1s" }));
    expect(result).toEqual({ ok: false, error: "the dependency install ran past plan's time limit of 1s" });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(existsSync(join(cache(), "next"))).toBe(false);
  });

  test("kill stops a running refresh's process group, and the cache stays at the last good copy", async () => {
    await refresh();
    const job = await workspace.refreshCache({
      repo: registration(),
      record: record({ command: "sleep 37" }),
      commit: world.commit,
      versionFolder: world.versionFolder,
      now: world.now,
    });
    await Bun.sleep(500);
    job.kill();
    expect(await job.done).toEqual({ ok: false, error: "the dependency install was stopped" });
    expect(await readFile(join(cache(), "current", "deps", "node_modules", "pkg", "index.js"), "utf8")).toBe("installed\n");
    const sleeping = Bun.spawnSync(["pgrep", "-f", "sleep 37"]).stdout.toString().trim();
    expect(sleeping).toBe("");
  });
});
