// The runner's launcher and LaunchAgent (spec 1, "Install", ADRs 0002 and 0024), written against a temporary
// root. Install writes the launcher once and never changes it, so macOS doesn't post its "can run in the
// background" notice after every update. The plist is read back with `plutil`, as launchd would read it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Folders } from "../../src/folders/index.ts";
import { LAUNCH_AGENT_LABEL, writeLaunchAgent, writeLauncher } from "../../src/install/index.ts";

let root: string;
let folders: Folders;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "flight-deck-launchd-"));
  folders = { data: join(root, "data"), config: join(root, "config"), sessionRoot: join(root, "sessions"), home: join(root, "home") };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const launcher = () => join(root, "data/launch/flight-deck");
const plist = () => join(root, "home/Library/LaunchAgents/dev.campdotdev.flight-deck.plist");

async function plistJson(path: string): Promise<unknown> {
  const proc = Bun.spawn(["/usr/bin/plutil", "-convert", "json", "-o", "-", path], { stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(code).toBe(0);
  return JSON.parse(out);
}

describe("the launcher", () => {
  test("execs current's runner, with mode 0755", async () => {
    expect(await writeLauncher(folders)).toBe(true);
    expect(await readFile(launcher(), "utf8")).toBe(`#!/bin/sh\nexec '${root}/data/current/bin/flight-deck' runner\n`);
    expect((await stat(launcher())).mode & 0o777).toBe(0o755);
  });

  test("is written once and never changed", async () => {
    await mkdir(join(root, "data/launch"), { recursive: true });
    await writeFile(launcher(), "#!/bin/sh\nexec old\n", { mode: 0o755 });
    expect(await writeLauncher(folders)).toBe(false);
    expect(await readFile(launcher(), "utf8")).toBe("#!/bin/sh\nexec old\n");
  });

  test("quotes a data folder with a quote in its path", async () => {
    folders = { ...folders, data: join(root, "it's data") };
    await writeLauncher(folders);
    expect(await readFile(join(root, "it's data/launch/flight-deck"), "utf8")).toBe(`#!/bin/sh\nexec '${root}/it'\\''s data/current/bin/flight-deck' runner\n`);
  });
});

describe("the LaunchAgent", () => {
  test("runs the launcher at load, keeps it alive, as Standard, with 65536 files, logging to state/launchd.log", async () => {
    expect(await writeLaunchAgent(folders)).toBe(true);
    expect(LAUNCH_AGENT_LABEL).toBe("dev.campdotdev.flight-deck");
    expect(await plistJson(plist())).toEqual({
      Label: "dev.campdotdev.flight-deck",
      ProgramArguments: [launcher()],
      RunAtLoad: true,
      KeepAlive: true,
      ProcessType: "Standard",
      SoftResourceLimits: { NumberOfFiles: 65536 },
      StandardOutPath: join(root, "data/state/launchd.log"),
      StandardErrorPath: join(root, "data/state/launchd.log"),
    });
    // launchd opens the log before the runner starts, so its folder has to exist.
    expect((await stat(join(root, "data/state"))).isDirectory()).toBe(true);
  });

  test("escapes paths for XML", async () => {
    folders = { ...folders, data: join(root, "a&b <data>") };
    await writeLaunchAgent(folders);
    expect(((await plistJson(plist())) as { ProgramArguments: string[] }).ProgramArguments).toEqual([join(root, "a&b <data>/launch/flight-deck")]);
  });

  test("isn't rewritten when it already says the same, because each write starts a background-item rescan", async () => {
    await writeLaunchAgent(folders);
    const before = (await stat(plist())).mtimeMs;
    await Bun.sleep(20);
    expect(await writeLaunchAgent(folders)).toBe(false);
    expect((await stat(plist())).mtimeMs).toBe(before);
  });
});
