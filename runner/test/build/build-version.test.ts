// `scripts/build-version.sh <out>` (spec 1, "Install"): it compiles the runner with Bun 1.4.3 for
// `bun-darwin-arm64` and lays out a version folder at `<out>`. A local build's version is the `package.json`
// version plus `-dev.<UTC time>` to the second, so two builds never share one. The built binary runs here only
// with `HOME` in a temporary root, and only `status`, which reads files and writes none.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");
const SCRIPT = join(ROOT, "scripts/build-version.sh");
const VERSION = /^0\.1\.0-dev\.\d{8}T\d{6}Z$/;
const BUILD_MS = 240_000;

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "flight-deck-build-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function build(out: string, env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([SCRIPT, out], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? root, BUN: process.execPath, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

async function versionOf(out: string): Promise<string> {
  return (JSON.parse(await readFile(join(out, "plugin/.claude-plugin/plugin.json"), "utf8")) as { version: string }).version;
}

/** Every path under `folder`, relative to it. */
async function walk(folder: string): Promise<string[]> {
  return (await readdir(folder, { recursive: true })).map(String);
}

describe("a local build", () => {
  let first: string;
  let firstRun: { code: number; stdout: string; stderr: string };

  beforeAll(async () => {
    first = join(root, "out-a");
    firstRun = await build(first);
  }, BUILD_MS);

  test("lays out the version folder", async () => {
    expect(firstRun.stderr).toBe("");
    expect(firstRun.code).toBe(0);
    expect((await readdir(first)).sort()).toEqual(["CREDITS.md", "LICENSE", "bin", "data", "plugin", "skills", "vendor"]);
    expect(statSync(join(first, "bin/flight-deck")).mode & 0o111).not.toBe(0);
    for (const path of [
      "plugin/.claude-plugin/marketplace.json",
      "plugin/skills/flight-plan/SKILL.md",
      "plugin/shared/session.md",
      "skills/reproducing-bugs/SKILL.md",
      "data/record.schema.json",
      "data/claude-code.toml",
      "vendor/betterleaks",
      "vendor/sandbox-runtime/node_modules/@anthropic-ai/sandbox-runtime/dist/cli.js",
    ]) {
      expect(existsSync(join(first, path))).toBe(true);
    }
    expect(await readFile(join(first, "LICENSE"), "utf8")).toBe(await readFile(join(ROOT, "LICENSE"), "utf8"));
    expect(await readFile(join(first, "CREDITS.md"), "utf8")).toBe(await readFile(join(ROOT, "CREDITS.md"), "utf8"));
    // Neither Finder's files nor the repo's ignore files ship.
    expect((await walk(first)).filter((path) => /(^|\/)\.(DS_Store|gitignore)$/.test(path))).toEqual([]);
  });

  test("stamps the version on the plugin and in the binary", async () => {
    const version = await versionOf(first);
    expect(version).toMatch(VERSION);
    expect(firstRun.stdout).toContain(version);
    expect(Buffer.from(await Bun.file(join(first, "bin/flight-deck")).arrayBuffer()).includes(version)).toBe(true);
  });

  test("the binary runs from the version folder", async () => {
    const home = join(root, "home");
    await mkdir(home, { recursive: true });
    const proc = Bun.spawn([join(first, "bin/flight-deck"), "status"], { env: { HOME: home, PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(stderr).toContain("The runner hasn't written status.json yet.");
    expect(code).toBe(1);
  });

  test(
    "a second build gets another version",
    async () => {
      const second = join(root, "out-b");
      const run = await build(second);
      expect(run.code).toBe(0);
      expect(await versionOf(second)).toMatch(VERSION);
      expect(await versionOf(second)).not.toBe(await versionOf(first));
    },
    BUILD_MS,
  );
});

describe("refuses", () => {
  test("an out folder that holds anything", async () => {
    const out = join(root, "full");
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "keep.txt"), "mine");
    const run = await build(out);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain(`${out} isn't empty`);
    expect(await readdir(out)).toEqual(["keep.txt"]);
  });

  test("a Bun that isn't 1.4.3", async () => {
    const fake = join(root, "fake-bun");
    await writeFile(fake, "#!/bin/sh\necho 1.0.3\n", { mode: 0o755 });
    const run = await build(join(root, "never"), { BUN: fake });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("needs Bun 1.4.3");
    expect(existsSync(join(root, "never"))).toBe(false);
  });
});
