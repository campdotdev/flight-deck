// Workspace runs with real git in a temporary root (spec 1, "Other module tests").
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../../src/folders/index.ts";
import { readRecord, type RepoRecord } from "../../src/record/index.ts";
import { sessionEnv, Workspace, type PreparePlan } from "../../src/workspace/index.ts";
import { SHADERS_RECORD, World } from "../scenario/world.ts";

let world: World;
let workspace: Workspace;

beforeEach(async () => {
  world = await World.create();
  workspace = new Workspace({ folders: world.folders, git: world.config.paths.git });
});

afterEach(async () => {
  await world.cleanup();
});

const registration = () => world.config.repos[0]!;

function record(): RepoRecord {
  const result = readRecord(SHADERS_RECORD);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.record;
}

function git(cwd: string, ...args: string[]): string {
  return Bun.spawnSync(["git", ...args], { cwd }).stdout.toString().trim();
}

function plan(session: string, commit: string, inbox: PreparePlan["inbox"] = { previousBrief: null, syncedComments: [] }): PreparePlan {
  return {
    session,
    stage: "plan",
    mode: "issue",
    repo: registration(),
    record: record(),
    issue: "SHA-1",
    team: "SHA",
    branch: "main",
    base: "main",
    commit,
    deadline: "2026-11-10T09:30:00.000Z",
    attempt: 1,
    maintainer: { id: "maintainer", name: "Hunter" },
    appUser: "flight-deck-app",
    version: world.version,
    versionFolder: world.versionFolder,
    inbox,
  };
}

describe("the clone", () => {
  test("fetch makes the clone, reads the default branch, and follows its tip", async () => {
    expect(await workspace.fetch(registration())).toEqual({ ok: true, branch: "main", head: world.commit });
    expect(existsSync(join(paths.clone(world.folders, "campdotdev/shaders"), ".git"))).toBe(true);
    const next = await world.push({ "src/a.ts": "export {};\n" });
    expect(await workspace.fetch(registration())).toEqual({ ok: true, branch: "main", head: next });
    expect(await workspace.head(registration())).toBe(next);
  });

  test("show reads a file at a commit, and null when it isn't there", async () => {
    const { head } = (await workspace.fetch(registration())) as { head: string };
    expect(await workspace.show(registration(), head, ".flight-deck/record.toml")).toBe(SHADERS_RECORD);
    expect(await workspace.show(registration(), head, "missing.toml")).toBeNull();
  });

  test("a failed fetch keeps the last fetched commit", async () => {
    await workspace.fetch(registration());
    const gone = { ...registration(), remote: join(world.root, "nowhere.git") };
    const result = await workspace.fetch(gone);
    expect(result.ok).toBe(false);
    expect(await workspace.head(registration())).toBe(world.commit);
  });
});

describe("prepare", () => {
  test("makes the session folder and a worktree detached at the plan's commit", async () => {
    const first = world.commit;
    await world.push({ "src/a.ts": "export {};\n" });
    await workspace.fetch(registration());
    const id = await workspace.newSessionId();
    const prepared = await workspace.prepare(plan(id, first, { previousBrief: "## Summary\n\nOld.", syncedComments: ["comment-1"] }));

    const folder = paths.sessionFolder(world.folders, id);
    expect(prepared).toEqual({
      session: id,
      sessionFolder: folder,
      sessionJson: join(folder, "session.json"),
      inbox: join(folder, "inbox"),
      outbox: join(folder, "outbox"),
      tmp: join(folder, "tmp"),
      deps: join(folder, "deps"),
      home: join(folder, "home"),
      worktree: paths.worktree(world.folders, id),
      port: null,
      appUrl: null,
      env: sessionEnv({ folders: world.folders, sessionFolder: folder, path: registration().path }),
    });
    expect((await readdir(folder)).sort()).toEqual(["deps", "home", "inbox", "outbox", "session.json", "tmp"]);
    // The env block's empty config folders for turbo and Vercel.
    expect((await readdir(join(folder, "home", "config"))).sort()).toEqual(["turborepo", "vercel"]);
    expect(await readdir(join(folder, "outbox"))).toEqual(["media"]);
    expect(await readFile(join(folder, "inbox", "previous-brief.md"), "utf8")).toBe("## Summary\n\nOld.");
    expect(await readFile(join(folder, "inbox", "synced-comments.json"), "utf8")).toBe('["comment-1"]');

    // A repo of its own that borrows the clone's objects, not a `git worktree`.
    expect(git(prepared.worktree, "rev-parse", "HEAD")).toBe(first);
    expect(git(prepared.worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    expect(existsSync(join(prepared.worktree, ".git", "objects", "info", "alternates"))).toBe(true);
    expect(existsSync(join(prepared.worktree, "README.md"))).toBe(true);
    expect(existsSync(join(prepared.worktree, "src", "a.ts"))).toBe(false);
  });

  test("leaves previous-brief.md out when issue memory holds no brief", async () => {
    await workspace.fetch(registration());
    const prepared = await workspace.prepare(plan(await workspace.newSessionId(), world.commit));
    expect(await readdir(prepared.inbox)).toEqual(["synced-comments.json"]);
    expect(await readFile(join(prepared.inbox, "synced-comments.json"), "utf8")).toBe("[]");
  });
});

describe("dispose", () => {
  test("removes the worktree, the session folder, and the session's folder under ~/.claude/projects/", async () => {
    await workspace.fetch(registration());
    const prepared = await workspace.prepare(plan(await workspace.newSessionId(), world.commit));
    const project = paths.claudeProject(world.folders, prepared.worktree);
    await mkdir(project, { recursive: true });
    await workspace.dispose(prepared);
    expect(existsSync(prepared.worktree)).toBe(false);
    expect(existsSync(prepared.sessionFolder)).toBe(false);
    expect(existsSync(project)).toBe(false);
  });

  test("with keepFolder, leaves the session folder", async () => {
    await workspace.fetch(registration());
    const prepared = await workspace.prepare(plan(await workspace.newSessionId(), world.commit));
    await workspace.dispose(prepared, { keepFolder: true });
    expect(existsSync(prepared.worktree)).toBe(false);
    expect(existsSync(prepared.sessionFolder)).toBe(true);
  });
});

describe("session IDs", () => {
  test("are 6 lowercase base-36 characters, and never one a session folder already has", async () => {
    const taken = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const id = await workspace.newSessionId();
      expect(id).toMatch(/^[0-9a-z]{6}$/);
      expect(taken.has(id)).toBe(false);
      taken.add(id);
      await mkdir(paths.sessionFolder(world.folders, id), { recursive: true });
    }
  });
});
