// Version folders (spec 1, "Install", ADR 0015), against a temporary root: a local build is copied into
// `versions/<version>/`, `current` points at the version in use, and `~/.local/bin/flight-deck` links to
// `current/bin/flight-deck`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Folders } from "../../src/folders/index.ts";
import { copyVersion, currentVersion, folderVersion, isInstalled, linkBin, switchCurrent } from "../../src/install/index.ts";

let root: string;
let folders: Folders;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "flight-deck-versions-"));
  folders = { data: join(root, "data"), config: join(root, "config"), sessionRoot: join(root, "sessions"), home: join(root, "home") };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A version folder as `build-version.sh` lays it out, small. */
async function build(at: string, version: string): Promise<string> {
  await mkdir(join(at, "bin"), { recursive: true });
  await writeFile(join(at, "bin/flight-deck"), "#!/bin/sh\n", { mode: 0o755 });
  await mkdir(join(at, "plugin/.claude-plugin"), { recursive: true });
  await writeFile(join(at, "plugin/.claude-plugin/plugin.json"), JSON.stringify({ name: "flight-deck", version }));
  await mkdir(join(at, "vendor/sandbox-runtime/node_modules/.bin"), { recursive: true });
  await writeFile(join(at, "vendor/sandbox-runtime/node_modules/cli.js"), "x");
  await symlink("../cli.js", join(at, "vendor/sandbox-runtime/node_modules/.bin/srt"));
  await writeFile(join(at, "LICENSE"), "MIT");
  return at;
}

describe("folderVersion", () => {
  test("reads the version the build stamped on the plugin", async () => {
    expect(await folderVersion(await build(join(root, "out"), "0.1.0-dev.20261110T090000Z"))).toBe("0.1.0-dev.20261110T090000Z");
  });

  test("names what's missing in a folder that isn't a version folder", async () => {
    await mkdir(join(root, "empty"));
    await expect(folderVersion(join(root, "empty"))).rejects.toThrow(`${join(root, "empty")} isn't a Flight Deck version folder: it has no bin/flight-deck`);
  });
});

describe("copyVersion", () => {
  test("copies the folder into versions/<version>/, keeping modes and links", async () => {
    const out = await build(join(root, "out"), "0.1.0-dev.1");
    await copyVersion(folders, out, "0.1.0-dev.1");
    const copy = join(root, "data/versions/0.1.0-dev.1");
    expect(await readFile(join(copy, "LICENSE"), "utf8")).toBe("MIT");
    expect((await stat(join(copy, "bin/flight-deck"))).mode & 0o777).toBe(0o755);
    expect(await readlink(join(copy, "vendor/sandbox-runtime/node_modules/.bin/srt"))).toBe("../cli.js");
    expect(await isInstalled(folders, "0.1.0-dev.1")).toBe(true);
    expect(await isInstalled(folders, "0.1.0-dev.2")).toBe(false);
  });

  test("refuses a version already in versions/", async () => {
    const out = await build(join(root, "out"), "0.1.0-dev.1");
    await copyVersion(folders, out, "0.1.0-dev.1");
    await expect(copyVersion(folders, out, "0.1.0-dev.1")).rejects.toThrow("0.1.0-dev.1 is already in versions/");
  });
});

describe("switchCurrent and linkBin", () => {
  test("current points at the version, and the bin link at current's binary", async () => {
    expect(await currentVersion(folders)).toBeNull();
    await copyVersion(folders, await build(join(root, "a"), "0.1.0-dev.1"), "0.1.0-dev.1");
    await switchCurrent(folders, "0.1.0-dev.1");
    await linkBin(folders);
    expect(await readlink(join(root, "data/current"))).toBe(join(root, "data/versions/0.1.0-dev.1"));
    expect(await readlink(join(root, "home/.local/bin/flight-deck"))).toBe(join(root, "data/current/bin/flight-deck"));
    expect(await currentVersion(folders)).toBe("0.1.0-dev.1");

    await copyVersion(folders, await build(join(root, "b"), "0.1.0-dev.2"), "0.1.0-dev.2");
    await switchCurrent(folders, "0.1.0-dev.2");
    await linkBin(folders);
    expect(await currentVersion(folders)).toBe("0.1.0-dev.2");
    expect((await lstat(join(root, "data/current"))).isSymbolicLink()).toBe(true);
  });

  test("linkBin leaves a file that isn't a link, and says so", async () => {
    await mkdir(join(root, "home/.local/bin"), { recursive: true });
    await writeFile(join(root, "home/.local/bin/flight-deck"), "mine");
    await expect(linkBin(folders)).rejects.toThrow(`${join(root, "home/.local/bin/flight-deck")} is a file, not a link`);
    expect(await readFile(join(root, "home/.local/bin/flight-deck"), "utf8")).toBe("mine");
  });
});
