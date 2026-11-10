// `flight-deck login linear <workspace>` (spec 1, "Install", ADRs 0005 and 0017): it reads both apps' client IDs
// and secrets and the setup key at hidden prompts, writes them to `credentials.env`, mints one token from each app,
// confirms each reaches the workspace, revokes both, and writes the maintainer and the app user to `config.toml`.
// It reaches Linear only through the Tracker: the in-memory adapter, and the Linear adapter over the fake Linear.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Folders } from "../../src/folders/index.ts";
import { linearApps, readCredentials } from "../../src/install/index.ts";
import { InMemoryTracker, LinearTracker } from "../../src/tracker/index.ts";
import { FakeLinear, type Received } from "../tracker/linear/fake-linear.ts";
import { cliAt, type Cli } from "./cli.ts";

const SECRETS = ["fd-client", "fd-secret", "reader-client", "reader-secret", "lin_api_setup"];
const NOW = new Date("2026-11-10T09:00:00Z");

let root: string;
let folders: Folders;
let tracker: InMemoryTracker;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "flight-deck-login-"));
  folders = { data: join(root, "data"), config: join(root, "config"), sessionRoot: join(root, "sessions"), home: root };
  tracker = new InMemoryTracker({ clock: () => NOW, appUser: "user-app", readerUser: "user-reader" });
  tracker.addUser({ id: "user-app", name: "Flight Deck" });
  tracker.addUser({ id: "user-maintainer", name: "Hunter" });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function inMemory(): Cli {
  return cliAt({ folders, clock: () => NOW, adapters: { maintainerTracker: () => tracker.as("user-maintainer"), appTracker: () => tracker } });
}

const config = async () => Bun.TOML.parse(await readFile(join(folders.config, "config.toml"), "utf8").catch(() => "")) as Record<string, unknown>;

/** No line any command printed holds a secret. */
function expectNoSecret(command: Cli): void {
  for (const line of [...command.out, ...command.err]) for (const secret of SECRETS) expect(line).not.toContain(secret);
}

describe("with the in-memory Tracker", () => {
  test("writes the secrets, mints and revokes one token from each app, and writes the maintainer and the app user", async () => {
    const command = inMemory();
    command.answers.push(...SECRETS);
    expect(await command.run("login", "linear", "campdotdev")).toBe(0);

    expect(command.asked).toEqual([
      "Flight Deck app's client ID",
      "Flight Deck app's client secret",
      "Flight Deck Reader app's client ID",
      "Flight Deck Reader app's client secret",
      "Setup key for campdotdev (a personal API key)",
    ]);
    expect((await readCredentials(folders))?.values).toEqual({
      LINEAR_APP_ID_CAMPDOTDEV: "fd-client",
      LINEAR_APP_SECRET_CAMPDOTDEV: "fd-secret",
      LINEAR_READER_ID_CAMPDOTDEV: "reader-client",
      LINEAR_READER_SECRET_CAMPDOTDEV: "reader-secret",
      LINEAR_SETUP_KEY_CAMPDOTDEV: "lin_api_setup",
    });
    expect((await stat(join(folders.config, "credentials.env"))).mode & 0o777).toBe(0o600);
    expect(tracker.mints).toEqual([
      { app: "flight_deck", workspace: "campdotdev", session: null, ok: true },
      { app: "reader", workspace: "campdotdev", session: null, ok: true },
    ]);
    expect(tracker.checkTokens.map((each) => [each.app, each.revoked])).toEqual([
      ["flight_deck", true],
      ["reader", true],
    ]);
    expect(tracker.runnerTokens).toEqual([]);
    expect(await config()).toEqual({ linear: { campdotdev: { maintainer_id: "user-maintainer", maintainer_name: "Hunter", app_user_id: "user-app" } } });
    expect(command.out.at(-1)).toBe(
      "Signed in to Linear workspace campdotdev. Flight Deck flags Hunter there, and the Flight Deck app acts as Flight Deck. The runner reads the new secrets at its next poll.",
    );
    expect(command.err).toEqual([]);
    expectNoSecret(command);
  });

  test("merges into both files, keeping every other key and workspace", async () => {
    await mkdir(folders.config, { recursive: true });
    await writeFile(join(folders.config, "config.toml"), 'auth = "subscription"\nconcurrency_cap = 2\n\n[linear.other]\nmaintainer_id = "o"\nmaintainer_name = "O"\napp_user_id = "oa"\n');
    await writeFile(join(folders.config, "credentials.env"), "ANTHROPIC_API_KEY=sk-ant\nLINEAR_APP_ID_CAMPDOTDEV=old\n", { mode: 0o600 });
    const command = inMemory();
    command.answers.push(...SECRETS);
    expect(await command.run("login", "linear", "campdotdev")).toBe(0);
    expect(await config()).toEqual({
      auth: "subscription",
      concurrency_cap: 2,
      linear: { other: { maintainer_id: "o", maintainer_name: "O", app_user_id: "oa" }, campdotdev: { maintainer_id: "user-maintainer", maintainer_name: "Hunter", app_user_id: "user-app" } },
    });
    const values = (await readCredentials(folders))!.values;
    expect(values.ANTHROPIC_API_KEY).toBe("sk-ant");
    expect(values.LINEAR_APP_ID_CAMPDOTDEV).toBe("fd-client");
  });

  test("the workspace's keys follow the <WS> naming", async () => {
    const command = inMemory();
    command.answers.push(...SECRETS);
    expect(await command.run("login", "linear", "camp-dev")).toBe(0);
    expect(Object.keys((await readCredentials(folders))!.values)).toEqual([
      "LINEAR_APP_ID_CAMP_DEV",
      "LINEAR_APP_SECRET_CAMP_DEV",
      "LINEAR_READER_ID_CAMP_DEV",
      "LINEAR_READER_SECRET_CAMP_DEV",
      "LINEAR_SETUP_KEY_CAMP_DEV",
    ]);
    expect(Object.keys((await config()).linear as object)).toEqual(["camp-dev"]);
  });

  test("a mint Linear refuses fails at once, names the app, and writes no Linear login", async () => {
    tracker.failMints("flight_deck", "campdotdev");
    const command = inMemory();
    command.answers.push(...SECRETS);
    expect(await command.run("login", "linear", "campdotdev")).toBe(1);
    expect(command.err).toEqual([
      "Linear refused to mint a Flight Deck token for campdotdev. Check the Flight Deck app's client ID and secret on its page in Linear's settings, then run flight-deck login linear campdotdev again.",
    ]);
    expect(tracker.mints.map((each) => each.app)).toEqual(["flight_deck"]);
    expect(await config()).toEqual({});
    expectNoSecret(command);
  });

  test("an empty answer writes nothing", async () => {
    const command = inMemory();
    command.answers.push("fd-client", "  ", "reader-client", "reader-secret", "lin_api_setup");
    expect(await command.run("login", "linear", "campdotdev")).toBe(1);
    expect(command.err).toEqual(["The Flight Deck app's client secret is empty, so Flight Deck wrote nothing. Run flight-deck login linear campdotdev again."]);
    expect(await readCredentials(folders)).toBeNull();
    expect(tracker.mints).toEqual([]);
  });

  test("a canceled prompt writes nothing", async () => {
    const command = inMemory();
    command.answers.push("fd-client");
    expect(await command.run("login", "linear", "campdotdev")).toBe(1);
    expect(command.err).toEqual(["Canceled, so Flight Deck wrote nothing."]);
    expect(await readCredentials(folders)).toBeNull();
  });

  test("needs a workspace URL key", async () => {
    const command = inMemory();
    expect(await command.run("login", "linear")).toBe(64);
    expect(await command.run("login", "linear", "Camp Dev")).toBe(64);
    expect(command.err).toEqual([
      "Usage: flight-deck login linear <workspace>, where <workspace> is the URL key in linear.app/<workspace>",
      "Usage: flight-deck login linear <workspace>, where <workspace> is the URL key in linear.app/<workspace>",
    ]);
    expect(command.asked).toEqual([]);
  });
});

describe("with the Linear adapter over the fake Linear", () => {
  let linear: FakeLinear;

  beforeEach(() => {
    linear = FakeLinear.start();
    linear.apps.set("fd-client", "fd-secret");
    linear.apps.set("reader-client", "reader-secret");
    linear.accepted.add("lin_api_setup");
  });

  afterEach(() => linear.stop());

  /** The production adapter, with Linear's origin pointed at the fake. */
  function overFake(viewers: Record<string, { id: string; name: string; urlKey?: string }>): Cli {
    linear.on("FlightDeckIdentity", (_variables: Record<string, unknown>, request: Received) => {
      const auth = request.authorization ?? "";
      const who = viewers[auth.startsWith("Bearer lin_oauth_fd-client") ? "app" : auth.startsWith("Bearer lin_oauth_reader-client") ? "reader" : "key"]!;
      return { data: { viewer: { id: who.id, name: who.name, organization: { urlKey: who.urlKey ?? "campdotdev" } } } };
    });
    const apps = async (workspace: string) => linearApps(await readCredentials(folders), workspace);
    return cliAt({
      folders,
      clock: () => NOW,
      adapters: {
        maintainerTracker: ({ setupKey }) => new LinearTracker({ identity: { kind: "setup_key", key: setupKey }, apps, api: linear.url }),
        appTracker: () => new LinearTracker({ identity: { kind: "flight_deck" }, apps, api: linear.url }),
      },
    });
  }

  const PEOPLE = { app: { id: "user-app", name: "Flight Deck" }, reader: { id: "user-reader", name: "Flight Deck Reader" }, key: { id: "user-maintainer", name: "Hunter" } };

  test("mints and revokes one token from each app with the secrets it just wrote", async () => {
    const command = overFake(PEOPLE);
    command.answers.push(...SECRETS);
    expect(await command.run("login", "linear", "campdotdev")).toBe(0);
    expect(linear.mints.map((form) => [form.client_id, form.scope])).toEqual([
      ["fd-client", "read,write"],
      ["reader-client", "read"],
    ]);
    expect(linear.revokes).toEqual(["lin_oauth_fd-client_1", "lin_oauth_reader-client_2"]);
    expect(linear.sent("FlightDeckIdentity").map((each) => each.authorization)).toEqual(["Bearer lin_oauth_fd-client_1", "Bearer lin_oauth_reader-client_2", "lin_api_setup"]);
    expect(await config()).toEqual({ linear: { campdotdev: { maintainer_id: "user-maintainer", maintainer_name: "Hunter", app_user_id: "user-app" } } });
    expectNoSecret(command);
  });

  test("a wrong Reader secret fails at once with the app named, after the Flight Deck token is revoked", async () => {
    const command = overFake(PEOPLE);
    command.answers.push("fd-client", "fd-secret", "reader-client", "wrong-secret", "lin_api_setup");
    expect(await command.run("login", "linear", "campdotdev")).toBe(1);
    expect(command.err).toEqual([
      "Linear refused to mint a Flight Deck Reader token for campdotdev: HTTP 401 invalid_client: Client authentication failed. Check the Flight Deck Reader app's client ID and secret on its page in Linear's settings, then run flight-deck login linear campdotdev again.",
    ]);
    expect(linear.revokes).toEqual(["lin_oauth_fd-client_1"]);
    expect(linear.sent("FlightDeckIdentity")).toHaveLength(1);
    expect(await config()).toEqual({});
    for (const line of command.err) expect(line).not.toContain("wrong-secret");
  });

  test("a setup key Linear rejects fails and says how to make one", async () => {
    linear.accepted.delete("lin_api_setup");
    const command = overFake(PEOPLE);
    command.answers.push(...SECRETS);
    expect(await command.run("login", "linear", "campdotdev")).toBe(1);
    expect(command.err).toEqual([
      "Linear rejected the setup key for campdotdev. Make a personal API key in campdotdev's Linear settings, then run flight-deck login linear campdotdev again.",
    ]);
    expect(await config()).toEqual({});
    expectNoSecret(command);
  });

  test("an app made in another workspace fails and names both workspaces", async () => {
    const command = overFake({ ...PEOPLE, reader: { ...PEOPLE.reader, urlKey: "elsewhere" } });
    command.answers.push(...SECRETS);
    expect(await command.run("login", "linear", "campdotdev")).toBe(1);
    expect(command.err).toEqual([
      "The Flight Deck Reader app's token reaches workspace elsewhere, not campdotdev. Use the Flight Deck Reader app made in campdotdev, then run flight-deck login linear campdotdev again.",
    ]);
    expect(linear.revokes).toEqual(["lin_oauth_fd-client_1", "lin_oauth_reader-client_2"]);
  });
});
