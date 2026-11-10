// Real Linear for the contract suites: the Linear adapter as the Flight Deck app and as the maintainer, from the
// maintainer's own `credentials.env`, and the maintainer's setup key for GraphQL the port doesn't send.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { macFolders, type Folders } from "../../../src/folders/index.ts";
import { linearApps, readCredentials, workspaceKey } from "../../../src/install/index.ts";
import { readRecord } from "../../../src/record/index.ts";
import { LinearTracker, type TrackerRepo } from "../../../src/tracker/index.ts";
import { VIEWER } from "../tracker/linear-queries.ts";

const API = "https://api.linear.app/graphql";

/** The workspace and team the suites use: campdotdev's Shaders team, unless the environment names others. */
export const WORKSPACE = process.env.FLIGHT_DECK_CONTRACT_WORKSPACE ?? "campdotdev";
export const TEAM = process.env.FLIGHT_DECK_CONTRACT_TEAM ?? "SHA";
/** The GitHub repo whose issues Linear's GitHub Issues Sync brings into the team. */
export const GITHUB_REPO = process.env.FLIGHT_DECK_CONTRACT_GITHUB_REPO ?? "campdotdev/shaders";

/** The keys `flight-deck login linear <workspace>` writes. */
function keys(workspace: string): string[] {
  const key = workspaceKey(workspace);
  return [`LINEAR_APP_ID_${key}`, `LINEAR_APP_SECRET_${key}`, `LINEAR_READER_ID_${key}`, `LINEAR_READER_SECRET_${key}`, `LINEAR_SETUP_KEY_${key}`];
}

export interface GraphqlAnswer {
  data?: Record<string, any> | null;
  errors?: { message: string; extensions?: { code?: string } & Record<string, unknown> }[];
}

/** One GraphQL request with an `Authorization` value: the setup key as it is, or `Bearer <token>`. */
export async function graphql(authorization: string, query: string, variables: Record<string, unknown> = {}): Promise<GraphqlAnswer & { status: number }> {
  const response = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authorization },
    body: JSON.stringify({ query, variables }),
  });
  const text = await response.text();
  try {
    return { status: response.status, ...(JSON.parse(text) as GraphqlAnswer) };
  } catch {
    return { status: response.status, errors: [{ message: text }] };
  }
}

export interface RealLinear {
  folders: Folders;
  /** The Linear adapter as the Flight Deck app, as the runner holds it. */
  runner: LinearTracker;
  /** The Linear adapter with the maintainer's setup key, as `flight-deck apply` holds it. */
  maintainer: LinearTracker;
  /** GraphQL as the maintainer. Throws on any error. */
  query(query: string, variables?: Record<string, unknown>): Promise<Record<string, any>>;
  /** GraphQL as the maintainer, with Linear's errors returned rather than thrown. */
  answer(query: string, variables?: Record<string, unknown>): Promise<GraphqlAnswer & { status: number }>;
  repo: TrackerRepo;
  maintainerName: string;
}

/**
 * Opens real Linear from the maintainer's `credentials.env`. Throws, naming what's missing, when it lacks a key.
 * The adapters log to stderr, so a failed revoke shows in the run's output.
 */
export async function openLinear(): Promise<RealLinear> {
  const folders = macFolders();
  const credentials = await readCredentials(folders);
  const missing = keys(WORKSPACE).filter((key) => !credentials?.values[key]);
  if (missing.length > 0) {
    throw new Error(`${join(folders.config, "credentials.env")} lacks ${missing.join(", ")}. Run flight-deck login linear ${WORKSPACE} first (see test/contract/README.md).`);
  }
  const setupKey = credentials!.values[`LINEAR_SETUP_KEY_${workspaceKey(WORKSPACE)}`]!;
  const apps = async (workspace: string) => linearApps(await readCredentials(folders), workspace);
  const log = (message: string) => console.warn(`[linear] ${message}`);
  const answer = (query: string, variables: Record<string, unknown> = {}) => graphql(setupKey, query, variables);
  const query = async (text: string, variables: Record<string, unknown> = {}) => {
    const result = await answer(text, variables);
    if (result.errors !== undefined && result.errors.length > 0) throw new Error(`Linear answered ${result.status}: ${result.errors.map((each) => each.message).join("; ")}`);
    return result.data ?? {};
  };
  const viewer = (await query(VIEWER)).viewer as { id: string; name: string };
  return {
    folders,
    runner: new LinearTracker({ identity: { kind: "flight_deck" }, apps, log }),
    maintainer: new LinearTracker({ identity: { kind: "setup_key", key: setupKey }, apps, log }),
    query,
    answer,
    repo: { name: GITHUB_REPO, workspace: WORKSPACE, team: TEAM, statuses: shadersStatuses(), maintainer: viewer.id },
    maintainerName: viewer.name,
  };
}

/** Shaders' `[tracker.statuses]`, from the record fixture Record's table test parses. */
export function shadersStatuses(): TrackerRepo["statuses"] {
  const parsed = readRecord(readFileSync(join(import.meta.dir, "../../record/fixtures/shaders.toml"), "utf8"));
  if (!parsed.ok) throw new Error("the Shaders record fixture doesn't parse");
  return parsed.record.tracker.statuses;
}

/** Polls `read` every `everyMs` until it returns something, or throws after `withinMs`. */
export async function eventually<T>(what: string, read: () => Promise<T | null | undefined>, withinMs: number, everyMs = 5_000): Promise<T> {
  const until = Date.now() + withinMs;
  for (;;) {
    const value = await read();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > until) throw new Error(`${what} didn't happen within ${Math.round(withinMs / 1000)} s`);
    await Bun.sleep(everyMs);
  }
}
