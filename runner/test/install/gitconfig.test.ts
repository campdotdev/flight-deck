// `gitconfig-runner` (spec 1, "Workspace", ADR 0005): the git config for the runner's own git commands. Its
// credential helper is `gh auth git-credential` under Flight Deck's `gh/` folder, so git uses only the machine
// user's login. Real git runs the helper here, with a stand-in `gh` that prints what it was given.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Folders } from "../../src/folders/index.ts";
import { writeRunnerGitconfig } from "../../src/install/index.ts";

let root: string;
let folders: Folders;

beforeEach(async () => {
  // A space and a quote in every path, so the helper's quoting is tested too.
  root = await mkdtemp(join(tmpdir(), "flight-deck gitconfig 'x-"));
  folders = { data: join(root, "data"), config: join(root, "config"), sessionRoot: join(root, "sessions"), home: root };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("git asks gh for the machine user's login, under Flight Deck's gh folder, and asks no other helper", async () => {
  const gh = join(root, "bin dir/gh");
  await mkdir(join(root, "bin dir"));
  const seen = join(root, "seen.txt");
  await writeFile(gh, `#!/bin/sh\nprintf '%s|%s\\n' "$GH_CONFIG_DIR" "$*" >> '${seen.replaceAll("'", "'\\''")}'\nprintf 'username=x-access-token\\npassword=ghp_machine\\n'\n`, { mode: 0o755 });
  await writeRunnerGitconfig(folders, gh);

  const proc = Bun.spawn(["git", "credential", "fill"], {
    env: { PATH: "/usr/bin:/bin", HOME: root, GIT_CONFIG_GLOBAL: join(folders.config, "gitconfig-runner"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    stdin: new TextEncoder().encode("protocol=https\nhost=github.com\n\n"),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(err).toBe("");
  expect(code).toBe(0);
  expect(out).toContain("password=ghp_machine\n");
  expect(await readFile(seen, "utf8")).toBe(`${join(folders.config, "gh")}|auth git-credential get\n`);
});
