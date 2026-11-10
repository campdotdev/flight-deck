// `flight-deck register <owner/repo>` (spec 1, "Install", ADRs 0006, 0007, 0017, and 0018): it checks the
// maintainer's checkout and its record's `[tracker]`, checks the team with a Flight Deck app token it mints and
// revokes, copies the record's `copy_files` into the repo's `files/` folder with mode 0600, adds the repo to
// `config.toml`, and makes Flight Deck's clone. The runner starts the cache refresh at its next poll.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readConfig } from "../../src/install/index.ts";
import { SHADERS_RECORD, World, outbox } from "../scenario/world.ts";
import { cli, type Cli } from "./cli.ts";

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const RECORD_PATH = ".flight-deck/record.toml";
/** The record in the checkout, still uncommitted, with two files to copy: one at the root, one in a folder. */
const RECORD = SHADERS_RECORD.replace("copy_files = []", 'copy_files = [".env", "apps/docs/.env.local"]');

let world: World;
let checkout: string;
/** A folder of stand-in package managers, first on the command's `PATH`. */
let bin: string;
let pathEnv: string;

function git(cwd: string, ...args: string[]): string {
  const run = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}

beforeEach(async () => {
  world = await World.create({ cache: false });
  // The repo isn't registered yet.
  world.config.repos.length = 0;
  await world.writeConfig();
  checkout = join(world.root, "checkout");
  git(world.root, "clone", "-q", world.remote, checkout);
  git(checkout, "remote", "set-url", "origin", "https://github.com/campdotdev/shaders.git");
  await writeFile(join(checkout, RECORD_PATH), RECORD);
  await writeFile(join(checkout, ".env"), "DATABASE_URL=postgres://local\n");
  await mkdir(join(checkout, "apps/docs"), { recursive: true });
  await writeFile(join(checkout, "apps/docs/.env.local"), "NEXT_PUBLIC_X=1\n");
  bin = join(world.root, "pm-bin");
  await mkdir(bin);
  await writeFile(join(bin, "pnpm"), "#!/bin/sh\n", { mode: 0o755 });
  pathEnv = `/opt/homebrew/bin:${bin}:/usr/bin:/bin`;
});

afterEach(async () => {
  await world.cleanup();
});

function command(): Cli {
  return cli(world, {}, { cwd: checkout, env: { PATH: pathEnv } });
}

const configText = () => readFile(join(world.folders.config, "config.toml"), "utf8");
const filesFolder = () => join(world.folders.data, "repos", "campdotdev", "shaders", "files");

describe("register", () => {
  test("adds the repo with its remote, checkout, package manager, PATH, and a copy of [tracker]", async () => {
    const register = command();
    expect(await register.run("register", "campdotdev/shaders", "--package-manager", join(bin, "pnpm"))).toBe(0);
    const config = await readConfig(world.folders);
    expect(config.repos).toEqual([
      {
        name: "campdotdev/shaders",
        remote: world.remote,
        checkout,
        package_manager: join(bin, "pnpm"),
        // The package manager's folder comes first, once.
        path: `${bin}:/opt/homebrew/bin:/usr/bin:/bin`,
        // The record's own `[tracker]`, read from the checkout.
        tracker: (Bun.TOML.parse(RECORD) as { tracker: never }).tracker,
      },
    ]);
    expect(register.out).toEqual([
      "Registered campdotdev/shaders on team SHA in campdotdev, with 2 copied files. The runner refreshes its dependency cache at its next poll.",
    ]);
    expect(register.err).toEqual([]);
  });

  test("checks the team with a Flight Deck app token it mints and revokes", async () => {
    expect(await command().run("register", "campdotdev/shaders")).toBe(0);
    expect(world.tracker.mints).toEqual([{ app: "flight_deck", workspace: "campdotdev", session: null, ok: true }]);
    expect(world.tracker.runnerTokens.map((each) => each.revoked)).toEqual([true]);
    expect(world.tracker.runnerRevokes).toEqual(["campdotdev"]);
  });

  test("copies each copy_files path into files/, keeping its path, with mode 0600", async () => {
    expect(await command().run("register", "campdotdev/shaders")).toBe(0);
    expect(await readFile(join(filesFolder(), ".env"), "utf8")).toBe("DATABASE_URL=postgres://local\n");
    expect(await readFile(join(filesFolder(), "apps/docs/.env.local"), "utf8")).toBe("NEXT_PUBLIC_X=1\n");
    for (const path of [".env", "apps/docs/.env.local"]) expect((await stat(join(filesFolder(), path))).mode & 0o777).toBe(0o600);
  });

  test("copies a folder in copy_files whole, each file with mode 0600", async () => {
    await writeFile(join(checkout, RECORD_PATH), SHADERS_RECORD.replace("copy_files = []", 'copy_files = ["apps/docs/"]'));
    await writeFile(join(checkout, "apps/docs/.env"), "A=1\n", { mode: 0o644 });
    expect(await command().run("register", "campdotdev/shaders")).toBe(0);
    expect((await readdir(join(filesFolder(), "apps/docs"))).sort()).toEqual([".env", ".env.local"]);
    expect((await stat(join(filesFolder(), "apps/docs/.env"))).mode & 0o777).toBe(0o600);
  });

  test("a missing file stops register, names the file, and registers nothing", async () => {
    await rm(join(checkout, "apps/docs/.env.local"));
    const register = command();
    const before = await configText();
    expect(await register.run("register", "campdotdev/shaders")).toBe(1);
    expect(register.err).toEqual([
      `Refused: copy_files lists apps/docs/.env.local, which ${checkout} doesn't hold. Create the file, or take it out of copy_files, then run flight-deck register campdotdev/shaders again.`,
    ]);
    expect(await configText()).toBe(before);
    await expect(stat(filesFolder())).rejects.toThrow();
  });

  test("makes Flight Deck's clone", async () => {
    expect(await command().run("register", "campdotdev/shaders")).toBe(0);
    expect(git(join(world.folders.data, "repos", "campdotdev", "shaders", "clone"), "rev-parse", "HEAD")).toBe(world.commit);
  });

  test("defaults to the folder it runs in, and to the package manager package.json names, found on PATH", async () => {
    await writeFile(join(checkout, "package.json"), JSON.stringify({ name: "shaders", packageManager: "pnpm@10.34.5+sha512.abc" }));
    const register = command();
    expect(await register.run("register", "campdotdev/shaders")).toBe(0);
    const [repo] = (await readConfig(world.folders)).repos;
    expect(repo!.checkout).toBe(checkout);
    expect(repo!.package_manager).toBe(join(bin, "pnpm"));
  });

  test("falls back to the lockfile, then to the first word of the record's dependency install", async () => {
    await writeFile(join(bin, "yarn"), "#!/bin/sh\n", { mode: 0o755 });
    await writeFile(join(checkout, "yarn.lock"), "");
    expect(await command().run("register", "campdotdev/shaders")).toBe(0);
    expect((await readConfig(world.folders)).repos[0]!.package_manager).toBe(join(bin, "yarn"));

    // The World's record installs with `mkdir`, so a checkout with no package.json or lockfile finds mkdir.
    await rm(join(checkout, "yarn.lock"));
    world.config.repos.length = 0;
    await world.writeConfig();
    expect(await command().run("register", "campdotdev/shaders")).toBe(0);
    expect((await readConfig(world.folders)).repos[0]!.package_manager).toBe("/bin/mkdir");
  });

  test("refuses when it can't find the package manager, and asks for --package-manager", async () => {
    await writeFile(join(checkout, "package-lock.json"), "{}");
    const register = cli(world, {}, { cwd: checkout, env: { PATH: "/nowhere" } });
    expect(await register.run("register", "campdotdev/shaders")).toBe(1);
    expect(register.err).toEqual([`Refused: npm, which package-lock.json names, isn't on your PATH. Pass --package-manager <absolute path>.`]);
    expect(await register.run("register", "campdotdev/shaders", "--package-manager", join(bin, "npm"))).toBe(1);
    expect(register.err[1]).toBe(`Refused: ${join(bin, "npm")} isn't a program Flight Deck can run. Pass --package-manager <absolute path>.`);
  });

  test("a team the record names with a missing status still registers, and says what's missing", async () => {
    world.tracker.renameStatus("SHA", "Paused", "On hold");
    const register = command();
    expect(await register.run("register", "campdotdev/shaders")).toBe(0);
    expect(register.out[0]).toBe(
      "Team SHA has no status named Paused, which [tracker.statuses] names for paused. The runner starts no session for the repo until the team has it.",
    );
  });

  test("the runner starts the first cache refresh at its next poll, and then a sent issue's session", async () => {
    expect(await command().run("register", "campdotdev/shaders")).toBe(0);
    const issue = world.issue({ title: "Save button is blue" });
    world.send(issue);
    world.harness.script(issue.identifier, { outbox: outbox.brief({ summary: "Brief ready", brief: "## Summary\n\nTurn it red.\n" }), exit: { kind: "exited", code: 0 } });
    world.restart();
    await world.tick();
    expect(world.harness.started).toEqual([]);
    await world.poll.refreshesEnded();
    await world.tick();
    expect(world.harness.started.map((each) => each.session.issue)).toEqual([issue.identifier]);
  });
});

describe("register --files", () => {
  test("copies the files again and changes nothing else", async () => {
    expect(await command().run("register", "campdotdev/shaders")).toBe(0);
    const before = await configText();
    await writeFile(join(checkout, ".env"), "DATABASE_URL=postgres://changed\n");
    await writeFile(join(checkout, RECORD_PATH), SHADERS_RECORD.replace("copy_files = []", 'copy_files = [".env"]'));
    const mints = world.tracker.mints.length;

    const again = command();
    expect(await again.run("register", "campdotdev/shaders", "--files")).toBe(0);
    expect(await configText()).toBe(before);
    expect(await readFile(join(filesFolder(), ".env"), "utf8")).toBe("DATABASE_URL=postgres://changed\n");
    // A path the record no longer lists goes.
    expect(await readdir(filesFolder())).toEqual([".env"]);
    expect(world.tracker.mints).toHaveLength(mints);
    expect(again.out).toEqual(["Copied 1 file for campdotdev/shaders again. The next session gets the new copies."]);
  });

  test("a missing file stops it and keeps the old copies", async () => {
    expect(await command().run("register", "campdotdev/shaders")).toBe(0);
    await rm(join(checkout, ".env"));
    const again = command();
    expect(await again.run("register", "campdotdev/shaders", "--files")).toBe(1);
    expect(again.err[0]).toContain("copy_files lists .env, which");
    expect(await readFile(join(filesFolder(), ".env"), "utf8")).toBe("DATABASE_URL=postgres://local\n");
  });

  test("refuses a repo that isn't registered", async () => {
    const register = command();
    expect(await register.run("register", "campdotdev/shaders", "--files")).toBe(1);
    expect(register.err).toEqual(["Refused: campdotdev/shaders isn't registered, so there's nothing to copy again. Run flight-deck register campdotdev/shaders without --files."]);
  });
});

describe("register's six refusals", () => {
  test("the checkout's origin doesn't name the repo", async () => {
    for (const origin of ["https://github.com/campdotdev/other.git", "git@gitlab.com:campdotdev/shaders.git", "https://github.com/campdotdev/shaders-docs"]) {
      git(checkout, "remote", "set-url", "origin", origin);
      const register = command();
      expect(await register.run("register", "campdotdev/shaders")).toBe(1);
      expect(register.err).toEqual([
        `Refused: ${checkout}'s origin is ${origin}, which isn't github.com/campdotdev/shaders. Run flight-deck register in the repo's own checkout, or pass --checkout <folder>.`,
      ]);
    }
    expect((await readConfig(world.folders)).repos).toEqual([]);
  });

  test("an origin in HTTPS or SSH form, with or without .git, names the repo", async () => {
    expect(await command().run("register", "campdotdev/shaders")).toBe(0);
    for (const origin of ["https://github.com/campdotdev/shaders", "git@github.com:campdotdev/shaders.git", "git@github.com:campdotdev/shaders", "ssh://git@github.com/campdotdev/shaders.git"]) {
      git(checkout, "remote", "set-url", "origin", origin);
      const register = command();
      // Past the origin check, the next refusal is the registration that already exists.
      expect(await register.run("register", "campdotdev/shaders")).toBe(1);
      expect(register.err[0]).toStartWith("Refused: campdotdev/shaders is already registered.");
    }
  });

  test("the repo is already registered", async () => {
    expect(await command().run("register", "campdotdev/shaders")).toBe(0);
    const register = command();
    expect(await register.run("register", "campdotdev/shaders")).toBe(1);
    expect(register.err).toEqual([
      "Refused: campdotdev/shaders is already registered. To copy its copy_files again, run flight-deck register campdotdev/shaders --files.",
    ]);
  });

  test("the checkout has no record, or its [tracker] fails the schema", async () => {
    await rm(join(checkout, RECORD_PATH));
    const register = command();
    expect(await register.run("register", "campdotdev/shaders")).toBe(1);
    expect(register.err[0]).toBe(`Refused: ${checkout} has no ${RECORD_PATH}. Write the record first: register reads it whether it's committed or not.`);

    // A record still being written registers when its [tracker] passes.
    await writeFile(join(checkout, RECORD_PATH), `schema = 1\n\n${RECORD.slice(RECORD.indexOf("[tracker]"), RECORD.indexOf("[dependencies]"))}`.replace('canceled = "Canceled"\n', ""));
    expect(await register.run("register", "campdotdev/shaders", "--package-manager", join(bin, "pnpm"))).toBe(1);
    expect(register.err[1]).toBe(`Refused: the record's [tracker] isn't valid: tracker.statuses.canceled: is missing. Fix it in ${join(checkout, RECORD_PATH)}, then run flight-deck register campdotdev/shaders again.`);
  });

  test("a record still being written registers when its [tracker] passes", async () => {
    await writeFile(join(checkout, RECORD_PATH), `schema = 1\n\n${RECORD.slice(RECORD.indexOf("[tracker]"), RECORD.indexOf("[dependencies]"))}`);
    expect(await command().run("register", "campdotdev/shaders", "--package-manager", join(bin, "pnpm"))).toBe(0);
    expect(await readdir(filesFolder())).toEqual([]);
  });

  test("credentials.env holds no Linear secrets for the record's workspace", async () => {
    await world.writeCredentials("ANTHROPIC_API_KEY=sk-ant\n");
    const register = command();
    expect(await register.run("register", "campdotdev/shaders")).toBe(1);
    expect(register.err).toEqual(["Refused: Flight Deck isn't signed in to Linear workspace campdotdev. Run flight-deck login linear campdotdev first."]);
    expect(world.tracker.mints).toEqual([]);
  });

  test("the Flight Deck app can't read the record's team", async () => {
    world.tracker.setReadable("SHA", false);
    const register = command();
    expect(await register.run("register", "campdotdev/shaders")).toBe(1);
    expect(register.err).toEqual([
      "Refused: the Flight Deck app can't read team SHA in campdotdev. Check the team key in the record. If the team is private, give both Flight Deck apps access to it in the team's settings in Linear.",
    ]);
    expect(world.tracker.runnerRevokes).toEqual(["campdotdev"]);
    expect((await readConfig(world.folders)).repos).toEqual([]);
  });

  test("the Flight Deck app's key is wrong", async () => {
    world.tracker.failMints("flight_deck", "campdotdev");
    const register = command();
    expect(await register.run("register", "campdotdev/shaders")).toBe(1);
    expect(register.err).toEqual([
      "Refused: Linear refused to mint a Flight Deck token for campdotdev, so Flight Deck can't check team SHA. Run flight-deck login linear campdotdev again with the Flight Deck app's client ID and secret.",
    ]);
  });

  test("another registered repo names the same team", async () => {
    world.config.repos.push({
      name: "campdotdev/docs",
      remote: world.remote,
      checkout: join(world.root, "docs"),
      package_manager: "/usr/bin/true",
      path: "/usr/bin:/bin",
      tracker: (Bun.TOML.parse(RECORD) as { tracker: never }).tracker,
    });
    await world.writeConfig();
    const register = command();
    expect(await register.run("register", "campdotdev/shaders")).toBe(1);
    expect(register.err).toEqual([
      "Refused: campdotdev/docs already uses team SHA in campdotdev, and one team holds one repo's factory. Give campdotdev/shaders a team of its own in the record.",
    ]);
    expect(world.tracker.mints).toEqual([]);
  });
});

test("no secret appears in register's output", async () => {
  await writeFile(join(checkout, ".env"), "SECRET_TOKEN=very-secret-value\n");
  await chmod(join(checkout, ".env"), 0o600);
  const register = command();
  expect(await register.run("register", "campdotdev/shaders")).toBe(0);
  for (const line of [...register.out, ...register.err]) {
    expect(line).not.toContain("very-secret-value");
    expect(line).not.toContain("test-app_secret");
  }
});
