// `flight-deck update --from <folder>` (spec 1, "Install", ADR 0015): it holds the runner with the cause `update`,
// checks the session list, and only when the list is empty copies the build into `versions/<version>/`, switches
// `current`, and restarts the runner with `launchctl kickstart -k`. While any session is listed, it ends the hold,
// refuses, and changes nothing. A stand-in runner answers `runner.sock`, and `launchctl` is a scripted stand-in.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Folders } from "../../src/folders/index.ts";
import { switchCurrent } from "../../src/install/index.ts";
import { listen, type Listening, type Request } from "../../src/socket/index.ts";
import type { SessionEntry } from "../../src/state/index.ts";
import { InMemoryTracker } from "../../src/tracker/index.ts";
import { cliAt, type Cli } from "./cli.ts";
import { FakeShell } from "./shell.ts";

const OLD = "0.1.0-dev.20261101T000000Z";
const NEW = "0.1.0-dev.20261110T090000Z";
const NOW = new Date("2026-11-10T09:00:00Z");
const KICKSTART = "/bin/launchctl kickstart -k gui/501/dev.campdotdev.flight-deck";

let root: string;
let folders: Folders;
let build: string;
let shell: FakeShell;
let socket: Listening | null;
let requests: Request[];
/** The session list the stand-in runner answers with. */
let listed: SessionEntry[];

beforeEach(async () => {
  root = await mkdtemp("/tmp/fd-update-");
  folders = { data: join(root, "data"), config: join(root, "config"), sessionRoot: join(root, "sessions"), home: join(root, "home") };
  await versionFolder(join(folders.data, `versions/${OLD}`), OLD);
  await switchCurrent(folders, OLD);
  build = await versionFolder(join(root, "build"), NEW);
  shell = new FakeShell().on(["/bin/launchctl", "kickstart"], {});
  requests = [];
  listed = [];
  socket = null;
});

afterEach(async () => {
  await socket?.close();
  await rm(root, { recursive: true, force: true });
});

async function versionFolder(at: string, version: string): Promise<string> {
  await mkdir(join(at, "bin"), { recursive: true });
  await writeFile(join(at, "bin/flight-deck"), "#!/bin/sh\n", { mode: 0o755 });
  await mkdir(join(at, "plugin/.claude-plugin"), { recursive: true });
  await writeFile(join(at, "plugin/.claude-plugin/plugin.json"), JSON.stringify({ name: "flight-deck", version }));
  return at;
}

/** The running runner, as `listenRunnerSocket` answers the ops update sends. */
async function runner(): Promise<void> {
  socket = await listen(join(folders.data, "state/runner.sock"), async (request) => {
    requests.push(request);
    if (request.op === "hold" || request.op === "release") return { ok: true };
    if (request.op === "sessions") return { ok: true, sessions: listed };
    return { ok: false, error: `no ${request.op}` };
  });
}

function entry(id: string, issue: string, state: SessionEntry["state"]): SessionEntry {
  return {
    id,
    repo: "campdotdev/shaders",
    issue,
    issue_id: `uuid-${id}`,
    title: "Save button is blue",
    stage: "plan",
    mode: "issue",
    attempt: 1,
    pid: null,
    pid_started_at: null,
    claude_uuid: null,
    worktree: join(folders.sessionRoot, "worktrees", id),
    started_at: null,
    deadline: null,
    state,
  };
}

function command(): Cli {
  const tracker = new InMemoryTracker({ clock: () => NOW, appUser: "user-app" });
  return cliAt({
    folders,
    clock: () => NOW,
    version: OLD,
    versionFolder: join(folders.data, `versions/${OLD}`),
    adapters: { maintainerTracker: () => tracker, appTracker: () => tracker },
    shell,
    answerMs: 300,
  });
}

const current = async () => readlink(join(folders.data, "current"));

describe("with no session listed", () => {
  test("holds the runner for the update, copies the build in, switches current, and restarts the runner", async () => {
    await runner();
    const cli = command();
    expect(await cli.run("update", "--from", build)).toBe(0);
    expect(requests).toEqual([{ op: "hold", cause: "update" }, { op: "sessions" }]);
    expect(existsSync(join(folders.data, `versions/${NEW}/bin/flight-deck`))).toBe(true);
    expect(await current()).toBe(join(folders.data, `versions/${NEW}`));
    expect(shell.commands).toEqual([KICKSTART]);
    expect(cli.out).toEqual([`Updated Flight Deck from ${OLD} to ${NEW}, and restarted the runner on it.`]);
  });

  test("when the runner doesn't answer, reads the session list itself and goes ahead", async () => {
    await mkdir(join(folders.data, "state"), { recursive: true });
    await writeFile(join(folders.data, "state/sessions.json"), "[]\n");
    const cli = command();
    expect(await cli.run("update", "--from", build)).toBe(0);
    expect(await current()).toBe(join(folders.data, `versions/${NEW}`));
    expect(shell.commands).toEqual([KICKSTART]);
  });
});

describe("refuses, and changes nothing,", () => {
  test("while the runner lists any session, in any state, and ends the update hold", async () => {
    listed = [entry("a1b2c3", "SHA-1", "running"), entry("d4e5f6", "SHA-2", "apply_waiting")];
    await runner();
    const cli = command();
    expect(await cli.run("update", "--from", build)).toBe(1);
    expect(requests).toEqual([{ op: "hold", cause: "update" }, { op: "sessions" }, { op: "release", cause: "update" }]);
    expect(cli.err).toEqual([
      `Refused: the runner lists 2 sessions, and an update would cut them off: a1b2c3 on SHA-1 (campdotdev/shaders, running), d4e5f6 on SHA-2 (campdotdev/shaders, apply_waiting). Run flight-deck hold, wait until flight-deck status lists no session, then run flight-deck update --from ${build} again.`,
    ]);
    expect(existsSync(join(folders.data, `versions/${NEW}`))).toBe(false);
    expect(await current()).toBe(join(folders.data, `versions/${OLD}`));
    expect(shell.calls).toEqual([]);
  });

  test("while the session list on disk holds an entry and the runner doesn't answer", async () => {
    await mkdir(join(folders.data, "state"), { recursive: true });
    await writeFile(join(folders.data, "state/sessions.json"), JSON.stringify([{ ...entry("tr1a1s", "", "running"), repo: "", stage: "trial" }]));
    const cli = command();
    expect(await cli.run("update", "--from", build)).toBe(1);
    expect(cli.err[0]).toStartWith("Refused: the session list holds 1 session, and an update would cut it off: tr1a1s, a trial run (running). Run flight-deck hold,");
    expect(await current()).toBe(join(folders.data, `versions/${OLD}`));
    expect(shell.calls).toEqual([]);
  });

  test("while the session list on disk holds an entry and the runner is too busy to answer the hold, and still ends it", async () => {
    await mkdir(join(folders.data, "state"), { recursive: true });
    await writeFile(join(folders.data, "state/sessions.json"), JSON.stringify([entry("a1b2c3", "SHA-1", "running")]));
    // A runner in a tick: the hold's answer comes after the command stops waiting for it.
    socket = await listen(join(folders.data, "state/runner.sock"), async (request) => {
      requests.push(request);
      if (request.op === "hold") await Bun.sleep(600);
      return { ok: true };
    });
    const cli = command();
    expect(await cli.run("update", "--from", build)).toBe(1);
    expect(cli.err[0]).toStartWith("Refused: the session list holds 1 session");
    expect(requests).toEqual([{ op: "hold", cause: "update" }, { op: "release", cause: "update" }]);
  });

  test("a version already in versions/, before it asks the runner anything", async () => {
    await runner();
    const again = await versionFolder(join(root, "again"), OLD);
    const cli = command();
    expect(await cli.run("update", "--from", again)).toBe(1);
    expect(cli.err).toEqual([`Refused: ${OLD} is already in ${join(folders.data, "versions")}. Build a new version with scripts/build-version.sh, then update from it.`]);
    expect(requests).toEqual([]);
    expect(shell.calls).toEqual([]);
  });

  test("a folder that isn't a version folder", async () => {
    await mkdir(join(root, "empty"));
    const cli = command();
    expect(await cli.run("update", "--from", join(root, "empty"))).toBe(1);
    expect(cli.err).toEqual([`Refused: ${join(root, "empty")} isn't a Flight Deck version folder: it has no bin/flight-deck. Name the folder scripts/build-version.sh wrote.`]);
  });
});

describe("when launchctl can't restart the runner", () => {
  test("says current moved and how to restart it", async () => {
    await runner();
    shell.on(["/bin/launchctl", "kickstart"], { code: 113, stderr: "Could not find service \"dev.campdotdev.flight-deck\" in domain for user gui: 501\n" });
    const cli = command();
    expect(await cli.run("update", "--from", build)).toBe(1);
    expect(requests.at(-1)).toEqual({ op: "release", cause: "update" });
    expect(cli.err).toEqual([
      `current now points at ${NEW}, but launchctl couldn't restart the runner: Could not find service "dev.campdotdev.flight-deck" in domain for user gui: 501. Run flight-deck install to load it.`,
    ]);
  });
});

test("usage", async () => {
  const cli = command();
  expect(await cli.run("update")).toBe(64);
  expect(await cli.run("update", "--from")).toBe(64);
  expect(cli.err).toEqual(["Usage: flight-deck update --from <folder>", "Usage: flight-deck update --from <folder>"]);
});
