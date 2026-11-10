// `flight-deck login github` (spec 1, "Install", ADRs 0005, 0007, and 0025): it reads the machine user's classic
// token at a hidden prompt, checks its scopes from `X-OAuth-Scopes` and its login against the maintainer's own,
// signs it in with `gh auth login --with-token --insecure-storage` under Flight Deck's `GH_CONFIG_DIR`, and writes
// `[machine_user]` and `gitconfig-runner`. `gh` is a scripted stand-in: no test signs anything in.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Folders } from "../../src/folders/index.ts";
import { updateConfig } from "../../src/install/index.ts";
import { InMemoryTracker } from "../../src/tracker/index.ts";
import { cliAt, type Cli } from "./cli.ts";
import { FakeShell, type Call } from "./shell.ts";

const NOW = new Date("2026-11-10T09:00:00Z");
const TOKEN = "ghp_machineusertoken";

let root: string;
let folders: Folders;
let gh: string;
let shell: FakeShell;
/** What GitHub answers for each token: its scopes and its user. */
let tokens: Record<string, { scopes: string; user: { login: string; id: number; name: string | null } }>;
/** The login of the maintainer's own `gh` session, or `null` when they have none. */
let maintainer: string | null;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "flight-deck-login-github-"));
  folders = { data: join(root, "data"), config: join(root, "config"), sessionRoot: join(root, "sessions"), home: root };
  await mkdir(join(root, "bin"));
  gh = join(root, "bin/gh");
  await writeFile(gh, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  tokens = { [TOKEN]: { scopes: "read:org, repo", user: { login: "fd-bot", id: 123456, name: "Flight Deck Bot" } } };
  maintainer = "hunterbecton";
  shell = new FakeShell()
    .on([gh, "api", "user", "-i"], (call) => {
      const known = tokens[call.env?.GH_TOKEN ?? ""];
      if (known === undefined) return { code: 1, stdout: "HTTP/2.0 401 Unauthorized\r\n\r\n", stderr: "gh: Bad credentials (HTTP 401)\n" };
      return {
        stdout: `HTTP/2.0 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nX-Oauth-Scopes: ${known.scopes}\r\nX-Accepted-Oauth-Scopes: \r\n\r\n${JSON.stringify({ ...known.user, type: "User" })}`,
      };
    })
    .on([gh, "api", "user", "--jq", ".login"], () =>
      maintainer === null ? { code: 4, stderr: "To get started with GitHub CLI, please run:  gh auth login\n" } : { stdout: `${maintainer}\n` },
    )
    .on([gh, "auth", "login"], {});
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function command(): Cli {
  const tracker = new InMemoryTracker({ clock: () => NOW, appUser: "user-app" });
  return cliAt({
    folders,
    clock: () => NOW,
    adapters: { maintainerTracker: () => tracker, appTracker: () => tracker },
    env: ENV(),
    shell,
  });
}

/** The maintainer's environment, with a token of the machine user's left in it by mistake. */
const ENV = () => ({ PATH: join(root, "bin"), HOME: root, GITHUB_TOKEN: "ghp_left-over" });

const config = async () => Bun.TOML.parse(await readFile(join(folders.config, "config.toml"), "utf8").catch(() => "")) as Record<string, unknown>;
const signIns = () => shell.calls.filter((call) => call.argv[1] === "auth");

/** No line the command printed holds the token. */
function expectNoToken(cli: Cli): void {
  for (const line of [...cli.out, ...cli.err]) expect(line).not.toContain(TOKEN);
}

describe("a machine user's token", () => {
  test("is checked, signed in under Flight Deck's gh folder, and written to [machine_user]", async () => {
    const cli = command();
    cli.answers.push(`${TOKEN}\n`);
    expect(await cli.run("login", "github")).toBe(0);

    expect(cli.asked).toEqual(["Machine user's classic token"]);
    // The scope read sees only the machine user's token, with no gh config of the maintainer's.
    const scopes = shell.calls[0]!;
    expect(scopes.argv).toEqual([gh, "api", "user", "-i"]);
    expect(scopes.env).toMatchObject({ GH_TOKEN: TOKEN, GH_CONFIG_DIR: join(folders.config, "gh"), GH_HOST: "github.com" });
    // The maintainer's own login comes from their own gh session, in their own environment.
    expect(shell.calls[1]!.argv).toEqual([gh, "api", "user", "--jq", ".login"]);
    expect(shell.calls[1]!.env).toEqual(ENV());
    const [signIn] = signIns() as [Call];
    expect(signIn.argv).toEqual([gh, "auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--with-token", "--insecure-storage"]);
    expect(signIn.input).toBe(`${TOKEN}\n`);
    expect(signIn.env?.GH_CONFIG_DIR).toBe(join(folders.config, "gh"));
    expect(signIn.env?.GH_TOKEN).toBeUndefined();
    // gh signs nothing in while a token variable is set.
    expect(signIn.env?.GITHUB_TOKEN).toBeUndefined();
    expect(shell.commands).toHaveLength(3);
    expect((await stat(join(folders.config, "gh"))).mode & 0o777).toBe(0o700);

    expect((await config()).machine_user).toEqual({ login: "fd-bot", id: 123456, name: "Flight Deck Bot", email: "123456+fd-bot@users.noreply.github.com" });
    expect(existsSync(join(folders.config, "gitconfig-runner"))).toBe(true);
    expect(cli.out).toEqual(["Signed in to GitHub as fd-bot. Flight Deck's commits name Flight Deck Bot <123456+fd-bot@users.noreply.github.com>."]);
    expectNoToken(cli);
  });

  test("with no name gets its login as the name, and the write keeps config.toml's other keys", async () => {
    await updateConfig(folders, (each) => void (each.concurrency_cap = 3));
    tokens[TOKEN]!.user.name = null;
    const cli = command();
    cli.answers.push(TOKEN);
    expect(await cli.run("login", "github")).toBe(0);
    expect(await config()).toEqual({ concurrency_cap: 3, machine_user: { login: "fd-bot", id: 123456, name: "fd-bot", email: "123456+fd-bot@users.noreply.github.com" } });
  });

  test("uses config.toml's gh when it names one", async () => {
    const other = join(root, "other-gh");
    await updateConfig(folders, (each) => void (each.paths = { claude: "/x/claude", git: "/usr/bin/git", gh: other }));
    shell.on([other], (call) => shell.run([gh, ...call.argv.slice(1)], { ...(call.env ? { env: call.env } : {}), ...(call.input ? { input: call.input } : {}) }));
    const cli = command();
    cli.answers.push(TOKEN);
    expect(await cli.run("login", "github")).toBe(0);
    expect(shell.calls[0]!.argv[0]).toBe(other);
  });
});

describe("refuses", () => {
  test.each([
    ["repo", "read:org", "it lacks the repo scope"],
    ["read:org", "repo", "it lacks the read:org scope"],
    ["", "", "it lacks the repo and read:org scopes"],
    ["workflow", "read:org, repo, workflow", "it has the workflow scope"],
    ["admin:", "admin:org, read:org, repo", "it has the admin:org scope"],
    ["admin:", "admin:repo_hook, read:org, repo", "it has the admin:repo_hook scope"],
    ["delete_repo", "delete_repo, read:org, repo", "it has the delete_repo scope"],
    ["write:packages", "read:org, repo, write:packages", "it has the write:packages scope"],
    ["two", "read:org, repo, workflow, delete_repo", "it has the workflow and delete_repo scopes"],
  ])("a token whose scopes break the rule (%s)", async (_, scopes, reason) => {
    tokens[TOKEN]!.scopes = scopes;
    const cli = command();
    cli.answers.push(TOKEN);
    expect(await cli.run("login", "github")).toBe(1);
    expect(cli.err).toEqual([
      `Refused: the token can't be the machine user's, because ${reason}. Make a classic token with only the repo and read:org scopes at https://github.com/settings/tokens/new?scopes=repo,read:org&description=Flight%20Deck, signed in as the machine user, then run flight-deck login github again.`,
    ]);
    expect(signIns()).toEqual([]);
    expect(existsSync(join(folders.config, "config.toml"))).toBe(false);
    expectNoToken(cli);
  });

  test("a token whose login is the maintainer's own, in any case", async () => {
    tokens[TOKEN]!.user.login = "HunterBecton";
    const cli = command();
    cli.answers.push(TOKEN);
    expect(await cli.run("login", "github")).toBe(1);
    expect(cli.err).toEqual([
      "Refused: the token belongs to HunterBecton, your own GitHub account, and the factory never acts as you. Sign in to GitHub as the machine user, make its token there, then run flight-deck login github again.",
    ]);
    expect(signIns()).toEqual([]);
  });

  test("with no gh session of the maintainer's, it asks for their login and compares with that", async () => {
    maintainer = null;
    tokens[TOKEN]!.user.login = "hunter";
    const cli = command();
    cli.answers.push(TOKEN, " Hunter \n");
    expect(await cli.run("login", "github")).toBe(1);
    expect(cli.asked).toEqual(["Machine user's classic token", "Your own GitHub login (you have no gh session to read it from)"]);
    expect(cli.err[0]).toStartWith("Refused: the token belongs to hunter, your own GitHub account");

    tokens[TOKEN]!.user.login = "fd-bot";
    const again = command();
    again.answers.push(TOKEN, "hunter");
    expect(await again.run("login", "github")).toBe(0);
  });

  test("a token GitHub rejects", async () => {
    const cli = command();
    cli.answers.push("ghp_wrong");
    expect(await cli.run("login", "github")).toBe(1);
    expect(cli.err).toEqual(["GitHub didn't accept the token: gh: Bad credentials (HTTP 401). Copy the whole token, then run flight-deck login github again."]);
    expect(signIns()).toEqual([]);
  });

  test("an empty token, and says what it wrote", async () => {
    const cli = command();
    cli.answers.push("  ");
    expect(await cli.run("login", "github")).toBe(1);
    expect(cli.err).toEqual(["The token is empty, so Flight Deck wrote nothing. Run flight-deck login github again."]);
    expect(shell.calls).toEqual([]);
  });

  test("when gh can't sign the token in", async () => {
    shell.on([gh, "auth", "login"], { code: 1, stderr: "error validating token: missing required scope 'read:org'\n" });
    const cli = command();
    cli.answers.push(TOKEN);
    expect(await cli.run("login", "github")).toBe(1);
    expect(cli.err).toEqual(["gh couldn't sign the token in: error validating token: missing required scope 'read:org'. Run flight-deck login github again."]);
    expect(existsSync(join(folders.config, "config.toml"))).toBe(false);
  });

  test("with no gh on PATH", async () => {
    await rm(gh);
    const cli = command();
    expect(await cli.run("login", "github")).toBe(1);
    expect(cli.err).toEqual(["Flight Deck can't find gh on your PATH. Install it with brew install gh, then run flight-deck login github again."]);
  });

  test("extra arguments", async () => {
    const cli = command();
    expect(await cli.run("login", "github", "fd-bot")).toBe(64);
    expect(cli.err).toEqual(["Usage: flight-deck login github"]);
  });
});
