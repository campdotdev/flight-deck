// The production adapters build the Linear adapter for each identity without reaching Linear: the runner's
// acts as the Flight Deck app from `credentials.env`, and `flight-deck apply`'s as the maintainer's setup key.
// A stand-in `fetch` records each request, so no test here reaches the network.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PRODUCTION_ADAPTERS, PRODUCTION_RUNNER } from "../../src/cli/production.ts";
import type { Folders } from "../../src/folders/index.ts";
import type { Config } from "../../src/install/index.ts";
import { IssueNotFoundError, LinearTracker, MintFailed, type TrackerRepo } from "../../src/tracker/index.ts";

const realFetch = globalThis.fetch;
let root: string;
let folders: Folders;
let requests: { url: string; init: RequestInit | undefined }[];
/** The runner's tracker ignores `config.toml`; only the Harness reads it. */
const config = {} as Config;
const repo = { name: "campdotdev/shaders", workspace: "camp-dev", team: "SHA", maintainer: "user-maintainer" } as TrackerRepo;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "flight-deck-production-"));
  folders = { data: join(root, "data"), config: join(root, "config"), sessionRoot: join(root, "sessions"), home: root };
  await mkdir(folders.config, { recursive: true });
  requests = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    return url.toString().endsWith("/oauth/token") ? Response.json({ access_token: "minted" }) : Response.json({ data: { issue: null } });
  }) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await rm(root, { recursive: true, force: true });
});

test("building the Linear adapter for each identity makes no request", () => {
  expect(PRODUCTION_RUNNER.runnerTracker({ folders, config })).toBeInstanceOf(LinearTracker);
  expect(PRODUCTION_ADAPTERS.maintainerTracker({ folders, workspace: "camp-dev", setupKey: "lin_api_setup" })).toBeInstanceOf(LinearTracker);
  expect(requests).toEqual([]);
});

test("the runner's adapter mints as the Flight Deck app from credentials.env, read at the mint", async () => {
  const tracker = PRODUCTION_RUNNER.runnerTracker({ folders, config });
  await expect(tracker.runnerToken("camp-dev")).rejects.toBeInstanceOf(MintFailed);
  expect(requests).toEqual([]);
  await writeFile(join(folders.config, "credentials.env"), "LINEAR_APP_ID_CAMP_DEV=fd-id\nLINEAR_APP_SECRET_CAMP_DEV=fd-secret\n", { mode: 0o600 });
  await tracker.runnerToken("camp-dev");
  expect(requests.map((each) => each.url)).toEqual(["https://api.linear.app/oauth/token"]);
  const form = new URLSearchParams(String(requests[0]!.init?.body));
  expect([form.get("client_id"), form.get("client_secret")]).toEqual(["fd-id", "fd-secret"]);
});

test("apply's adapter sends the maintainer's setup key as it is, and mints nothing", async () => {
  const tracker = PRODUCTION_ADAPTERS.maintainerTracker({ folders, workspace: "camp-dev", setupKey: "lin_api_setup" });
  await tracker.runnerToken("camp-dev");
  expect(requests).toEqual([]);
  await expect(tracker.issue({ id: "SHA-1", repo })).rejects.toBeInstanceOf(IssueNotFoundError);
  expect(requests.map((each) => each.url)).toEqual(["https://api.linear.app/graphql"]);
  expect(new Headers(requests[0]!.init?.headers).get("Authorization")).toBe("lin_api_setup");
});
