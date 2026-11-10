// `config.toml`: facts about one Mac, never about a repo (ADR 0003). The runner reads it at every poll, and
// `install`, `login`, and `register` merge their keys into it.
import { readFile } from "node:fs/promises";
import { paths, type Folders } from "../folders/index.ts";
import type { RepoRecord } from "../record/index.ts";
import { writeAtomic } from "../state/files.ts";
import { toToml } from "./toml.ts";

/** One registered repo. */
export interface Registration {
  /** `owner/repo`. */
  name: string;
  /** The URL the clone fetches from. Tests point it at a local bare repo. */
  remote: string;
  /** The maintainer's checkout. Only `register` reads it. */
  checkout: string;
  package_manager: string;
  /** The `PATH` a session's commands get. */
  path: string;
  /** A copy of the record's `[tracker]` table, used until the default branch holds a valid record. */
  tracker: RepoRecord["tracker"];
}

export interface LinearWorkspace {
  maintainer_id: string;
  maintainer_name: string;
  app_user_id: string;
}

export interface Config {
  auth: "subscription" | "api_key";
  concurrency_cap: number;
  usage: { five_hour: number; weekly: number };
  api?: { session_budget_usd: number; daily_cap_usd: number; monthly_cap_usd: number };
  models: { plan: string; build: string; check: string; debrief: string };
  paths: { claude: string; git: string; gh: string };
  machine_user?: { login: string; id: number; name: string; email: string };
  repos: Registration[];
  /** `[linear.<workspace>]`, by workspace URL key. */
  linear: Record<string, LinearWorkspace>;
}

/** Reads `config.toml`. It doesn't check the file yet. */
export async function readConfig(folders: Folders): Promise<Config> {
  const config = Bun.TOML.parse(await readFile(paths.configToml(folders), "utf8")) as unknown as Config;
  return { ...config, repos: config.repos ?? [], linear: config.linear ?? {} };
}

/**
 * Merges keys into `config.toml`: `update` changes the file's tables in place, and every key it leaves alone
 * stays. A missing file starts empty. The new file is written beside the old one and renamed into place, so
 * the runner never reads half of it. Comments don't survive the write.
 */
export async function updateConfig(folders: Folders, update: (config: Record<string, unknown>) => void): Promise<void> {
  const path = paths.configToml(folders);
  const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const config = Bun.TOML.parse(text) as Record<string, unknown>;
  update(config);
  await writeAtomic(path, toToml(config));
}
