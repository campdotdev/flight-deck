// The writes to `config.toml` and `credentials.env` (spec 1, "`config.toml` and `credentials.env`"): each merges
// its keys into the file, creates it when it's missing, and renames a temporary file into place, so the runner
// never reads half a file. `credentials.env` keeps mode 0600 through the rename.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Folders } from "../../src/folders/index.ts";
import { readConfig, readCredentials, updateConfig, writeCredentials } from "../../src/install/index.ts";

let root: string;
let folders: Folders;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "flight-deck-write-"));
  folders = { data: join(root, "data"), config: join(root, "config"), sessionRoot: join(root, "sessions"), home: root };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const credentialsPath = () => join(folders.config, "credentials.env");
const configPath = () => join(folders.config, "config.toml");

describe("writeCredentials", () => {
  test("creates the file with mode 0600", async () => {
    await writeCredentials(folders, { LINEAR_APP_ID_CAMPDOTDEV: "fd-id" });
    expect(await readFile(credentialsPath(), "utf8")).toBe("LINEAR_APP_ID_CAMPDOTDEV=fd-id\n");
    expect((await stat(credentialsPath())).mode & 0o777).toBe(0o600);
  });

  test("replaces each key's line and appends new keys, keeping every other line", async () => {
    await mkdir(folders.config, { recursive: true });
    await writeFile(credentialsPath(), "# Flight Deck\nANTHROPIC_API_KEY=sk-ant\nLINEAR_APP_ID_CAMPDOTDEV=old\n", { mode: 0o600 });
    await writeCredentials(folders, { LINEAR_APP_ID_CAMPDOTDEV: "new", LINEAR_SETUP_KEY_CAMPDOTDEV: "lin_api_x" });
    expect(await readFile(credentialsPath(), "utf8")).toBe("# Flight Deck\nANTHROPIC_API_KEY=sk-ant\nLINEAR_APP_ID_CAMPDOTDEV=new\nLINEAR_SETUP_KEY_CAMPDOTDEV=lin_api_x\n");
    expect((await readCredentials(folders))?.values).toEqual({ ANTHROPIC_API_KEY: "sk-ant", LINEAR_APP_ID_CAMPDOTDEV: "new", LINEAR_SETUP_KEY_CAMPDOTDEV: "lin_api_x" });
  });

  test("a file others could read comes back as 0600, and no temporary file stays", async () => {
    await mkdir(folders.config, { recursive: true });
    await writeFile(credentialsPath(), "A=1\n");
    await chmod(credentialsPath(), 0o644);
    await writeCredentials(folders, { B: "2" });
    expect((await stat(credentialsPath())).mode & 0o777).toBe(0o600);
    expect(await readdir(folders.config)).toEqual(["credentials.env"]);
  });

  test("refuses a value that would break the file", async () => {
    await expect(writeCredentials(folders, { A: "one\nB=two" })).rejects.toThrow("A's value holds a line break");
  });
});

describe("updateConfig", () => {
  test("creates config.toml when it's missing", async () => {
    await updateConfig(folders, (config) => {
      config.linear = { campdotdev: { maintainer_id: "u-1", maintainer_name: "Hunter", app_user_id: "u-app" } };
    });
    expect(Bun.TOML.parse(await readFile(configPath(), "utf8"))).toEqual({ linear: { campdotdev: { maintainer_id: "u-1", maintainer_name: "Hunter", app_user_id: "u-app" } } });
  });

  test("merges into the file and keeps every key it doesn't change", async () => {
    await mkdir(folders.config, { recursive: true });
    await writeFile(configPath(), 'auth = "subscription"\nconcurrency_cap = 2\n\n[usage]\nfive_hour = 0.8\nweekly = 0.7\n\n[linear.other]\nmaintainer_id = "o"\nmaintainer_name = "O"\napp_user_id = "oa"\n');
    await updateConfig(folders, (config) => {
      (config.linear as Record<string, unknown>).campdotdev = { maintainer_id: "u-1", maintainer_name: "Hunter", app_user_id: "u-app" };
    });
    expect(Bun.TOML.parse(await readFile(configPath(), "utf8"))).toEqual({
      auth: "subscription",
      concurrency_cap: 2,
      usage: { five_hour: 0.8, weekly: 0.7 },
      linear: { other: { maintainer_id: "o", maintainer_name: "O", app_user_id: "oa" }, campdotdev: { maintainer_id: "u-1", maintainer_name: "Hunter", app_user_id: "u-app" } },
    });
    expect(await readdir(folders.config)).toEqual(["config.toml"]);
  });

  test("writes repo entries the runner reads back, nested tables included", async () => {
    const statuses = { intake: "Triage", backlog: "Backlog", ready_to_plan: 'Ready "to" plan' };
    await updateConfig(folders, (config) => {
      config.auth = "subscription";
      config.repos = [{ name: "campdotdev/shaders", remote: "https://github.com/campdotdev/shaders.git", tracker: { kind: "linear", workspace: "campdotdev", team: "SHA", statuses } }];
    });
    const config = await readConfig(folders);
    expect(config.repos[0]!.tracker.statuses as unknown).toEqual(statuses);
    expect(config.repos[0]!.remote).toBe("https://github.com/campdotdev/shaders.git");
  });
});
