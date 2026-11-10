// `credentials.env`: each Linear workspace's app secrets and setup key, and any Claude API key (spec 1,
// "`config.toml` and `credentials.env`", ADR 0005). The runner reads it at every poll, and `login linear` and
// `install` write it.
import { readFile, stat } from "node:fs/promises";
import { paths, type Folders } from "../folders/index.ts";
import { writeAtomic } from "../state/files.ts";

export interface Credentials {
  /** The file's permission bits, such as `0o600`. */
  mode: number;
  values: Record<string, string>;
}

/** Reads `credentials.env`, or returns `null` when there is none. */
export async function readCredentials(folders: Folders): Promise<Credentials | null> {
  const path = paths.credentials(folders);
  try {
    const { mode } = await stat(path);
    return { mode: mode & 0o777, values: parseEnv(await readFile(path, "utf8")) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Whether anyone but the maintainer can read the file: the group or other read bit is set, so `0640` fails. */
export function othersCanRead(credentials: Credentials): boolean {
  return (credentials.mode & 0o044) !== 0;
}

/** The workspace's URL key as `credentials.env` spells it: upper case, with `-` written as `_`. */
export function workspaceKey(workspace: string): string {
  return workspace.toUpperCase().replaceAll("-", "_");
}

/** Whether the file holds the Flight Deck app's client ID and secret for the workspace, which every poll needs. */
export function hasWorkspace(credentials: Credentials | null, workspace: string): boolean {
  const key = workspaceKey(workspace);
  return Boolean(credentials?.values[`LINEAR_APP_ID_${key}`]) && Boolean(credentials?.values[`LINEAR_APP_SECRET_${key}`]);
}

/**
 * The workspace's two Linear apps, in the shape the Linear adapter reads at each mint. An app whose ID or
 * secret is missing or empty is `null`, so its mint fails with `MintFailed`.
 */
export function linearApps(
  credentials: Credentials | null,
  workspace: string,
): { flight_deck: { id: string; secret: string } | null; reader: { id: string; secret: string } | null } | null {
  if (credentials === null) return null;
  const key = workspaceKey(workspace);
  const app = (id: string | undefined, secret: string | undefined) => (id && secret ? { id, secret } : null);
  return {
    flight_deck: app(credentials.values[`LINEAR_APP_ID_${key}`], credentials.values[`LINEAR_APP_SECRET_${key}`]),
    reader: app(credentials.values[`LINEAR_READER_ID_${key}`], credentials.values[`LINEAR_READER_SECRET_${key}`]),
  };
}

/**
 * Merges keys into `credentials.env`: each key's line is replaced, a new key is appended, and every other line
 * stays. The file is written beside itself and renamed into place with mode `0600`, so the runner never reads
 * half of it and nobody else can read it (ADR 0005).
 */
export async function writeCredentials(folders: Folders, values: Record<string, string>): Promise<void> {
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`${key} isn't a credentials.env key`);
    if (/[\r\n]/.test(value)) throw new Error(`${key}'s value holds a line break`);
  }
  const path = paths.credentials(folders);
  const old = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const left = new Map(Object.entries(values));
  const lines = old === "" ? [] : old.replace(/\n$/, "").split("\n");
  const merged = lines.map((line) => {
    const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
    if (key === undefined || !left.has(key)) return line;
    const value = left.get(key)!;
    left.delete(key);
    return `${key}=${value}`;
  });
  for (const [key, value] of left) merged.push(`${key}=${value}`);
  await writeAtomic(path, `${merged.join("\n")}\n`, 0o600);
}

/** `KEY=value` lines. Blank lines and `#` lines are skipped, and one pair of surrounding quotes comes off a value. */
function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (match === null) continue;
    const raw = match[2]!.trim();
    values[match[1]!] = /^(["']).*\1$/.test(raw) ? raw.slice(1, -1) : raw;
  }
  return values;
}
