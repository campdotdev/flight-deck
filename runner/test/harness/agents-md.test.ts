// How the Harness resolves `@` imports to decide whether to append the root AGENTS.md (spec 1, "The command line").
// Scenarios cover the imports inside the worktree. These cover imports that leave it, which need a worktree
// whose path is known before the session starts.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { agentsMdToAppend, importPaths } from "../../src/harness/agents-md.ts";

let root: string;
let worktree: string;
let home: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "flight-deck-agents-")));
  worktree = join(root, "worktree");
  home = join(root, "home");
  await mkdir(worktree);
  await mkdir(home);
  await write(join(worktree, "AGENTS.md"), "# Agents\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

describe("an import that resolves outside the worktree counts as none", () => {
  test("a relative import of a file above the worktree, which imports AGENTS.md back", async () => {
    await write(join(worktree, "CLAUDE.md"), "@../outside.md\n");
    await write(join(root, "outside.md"), `@${join(worktree, "AGENTS.md")}\n`);
    expect(await agentsMdToAppend(worktree, home)).toBe(join(worktree, "AGENTS.md"));
  });

  test("an import under ~/", async () => {
    await write(join(worktree, "CLAUDE.md"), "@~/notes.md\n");
    await write(join(home, "notes.md"), `@${join(worktree, "AGENTS.md")}\n`);
    expect(await agentsMdToAppend(worktree, home)).toBe(join(worktree, "AGENTS.md"));
  });

  test("a file inside the worktree that is a symlink to one outside it", async () => {
    await write(join(root, "outside.md"), `@${join(worktree, "AGENTS.md")}\n`);
    await symlink(join(root, "outside.md"), join(worktree, "notes.md"));
    await write(join(worktree, "CLAUDE.md"), "@notes.md\n");
    expect(await agentsMdToAppend(worktree, home)).toBe(join(worktree, "AGENTS.md"));
  });

  test("an absolute import of the worktree's own AGENTS.md still counts", async () => {
    await write(join(worktree, "CLAUDE.md"), `@${join(worktree, "AGENTS.md")}\n`);
    expect(await agentsMdToAppend(worktree, home)).toBeNull();
  });

  test("a root AGENTS.md that is a symlink out of the worktree is never appended", async () => {
    await rm(join(worktree, "AGENTS.md"));
    await write(join(home, "secret.md"), "secret\n");
    await symlink(join(home, "secret.md"), join(worktree, "AGENTS.md"));
    expect(await agentsMdToAppend(worktree, home)).toBeNull();
  });
});

describe("imports that loop", () => {
  test("end, and a loop that never reaches AGENTS.md appends it", async () => {
    await write(join(worktree, "CLAUDE.md"), "@a.md\n");
    await write(join(worktree, "a.md"), "@CLAUDE.md\n");
    expect(await agentsMdToAppend(worktree, home)).toBe(join(worktree, "AGENTS.md"));
  });
});

describe("importPaths", () => {
  test.each([
    ["@AGENTS.md", ["AGENTS.md"]],
    ["See @docs/a.md and @./b.md.", ["docs/a.md", "./b.md."]],
    ["@Design\\ Docs/api.md", ["Design Docs/api.md"]],
    ["@docs/a.md#section", ["docs/a.md"]],
    ["mail me@example.com", []],
    ["`@AGENTS.md` and ``@a.md``", []],
    ["~~~\n@AGENTS.md\n~~~", []],
    ['"@AGENTS.md"', []],
    ["@@twice and @/", []],
  ])("%p imports %p", (text, paths) => {
    expect(importPaths(text)).toEqual(paths);
  });
});
