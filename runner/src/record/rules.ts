// The schema-1 rules that JSON Schema can't hold: hosts that reach GitHub, read paths outside the
// folders a session may read, duplicate categories and names, and roles that share a status name.

import type { Path } from "./lines.ts";
import { ROLES } from "./types.ts";

export interface Problem {
  path: Path;
  message: string;
  /** Set for a missing key: the error sorts by its table's line, not its own. */
  missing?: true;
}

const GITHUB_HOSTS = ["github.com", "api.github.com", "uploads.github.com"];

// Spec 1: the only folders a session may read, with the paths inside them. A folder this list doesn't
// name could hold a credential, such as ~/.netrc, and no list of forbidden folders can name them all.
const READABLE_FOLDERS = [
  // Toolchains, for the package manager and Node on a session's PATH.
  "~/.nvm",
  "~/.volta",
  "~/.bun/bin",
  "~/.bun/install/cache",
  "~/Library/pnpm",
  "~/.fnm",
  "~/.local/share/fnm",
  "~/Library/Application Support/fnm",
  "~/.local/state/fnm_multishells",
  "~/Library/Caches/fnm_multishells",
  "~/.local/share/mise/installs",
  "~/.local/share/mise/shims",
  "~/.asdf/installs",
  "~/.asdf/shims",
  // Tool downloads and caches.
  "~/.npm/_cacache",
  "~/Library/Caches/ms-playwright",
  "~/Library/Caches/Cypress",
  "~/Library/Caches/pnpm",
  "~/Library/Caches/Yarn",
  "~/Library/Caches/node-gyp",
  "~/.cache/puppeteer",
].map((folder) => folder.toLowerCase());

const READ_PATH_MESSAGE = 'must be a folder a session may read, such as "~/.nvm", or a path inside one';

/** The only two roles that may share a status name. */
const SHARED_ROLES = new Set(["intake", "backlog"]);

/** Checks the rules on whatever parts of `data` have the right shape. The schema reports the rest. */
export function checkRules(data: unknown): Problem[] {
  const record = asTable(data);
  if (!record) return [];
  return [...checkHosts(record), ...checkReadPaths(record), ...checkCommands(record), ...checkStatuses(record)];
}

function checkHosts(record: Table): Problem[] {
  const problems: Problem[] = [];
  asList(asTable(record.sandbox)?.hosts)?.forEach((value, i) => {
    if (typeof value !== "string") return;
    const host = value.toLowerCase();
    const path = ["sandbox", "hosts", i];
    if (GITHUB_HOSTS.includes(host)) {
      problems.push({ path, message: "is GitHub, and no session may reach GitHub" });
    } else if (host.startsWith("*.")) {
      const matched = GITHUB_HOSTS.find((github) => github.endsWith(host.slice(1)));
      if (matched) problems.push({ path, message: `matches ${matched}, and no session may reach GitHub` });
    }
  });
  return problems;
}

function checkReadPaths(record: Table): Problem[] {
  const problems: Problem[] = [];
  asList(asTable(record.sandbox)?.read_paths)?.forEach((value, i) => {
    if (typeof value !== "string" || !value.startsWith("~/")) return;
    // APFS ignores case by default, so ~/.NVM opens ~/.nvm.
    const path = value.replace(/\/$/, "").toLowerCase();
    if (!READABLE_FOLDERS.some((folder) => path === folder || path.startsWith(`${folder}/`))) {
      problems.push({ path: ["sandbox", "read_paths", i], message: READ_PATH_MESSAGE });
    }
  });
  return problems;
}

function checkCommands(record: Table): Problem[] {
  const problems: Problem[] = [];
  const categories = new Map<string, number>();
  const names = new Map<string, string>();
  const entries = [
    ...(asList(record.commands) ?? []).map((entry, i) => ({ list: "commands", i, entry: asTable(entry) })),
    ...(asList(record.extras) ?? []).map((entry, i) => ({ list: "extras", i, entry: asTable(entry) })),
  ];
  for (const { list, i, entry } of entries) {
    const label = `${list}[${i + 1}]`;
    const category = entry?.category;
    if (list === "commands" && typeof category === "string") {
      const first = categories.get(category);
      if (first === undefined) categories.set(category, i);
      else
        problems.push({
          path: [list, i, "category"],
          message: `"${category}" is also commands[${first + 1}]'s category, and each category takes one command`,
        });
    }
    const name = entry?.name;
    if (typeof name === "string") {
      const first = names.get(name);
      if (first === undefined) names.set(name, label);
      else problems.push({ path: [list, i, "name"], message: `"${name}" is also the name of ${first}` });
    }
  }
  return problems;
}

function checkStatuses(record: Table): Problem[] {
  const statuses = asTable(asTable(record.tracker)?.statuses);
  if (!statuses) return [];
  const problems: Problem[] = [];
  const holders = new Map<string, string[]>();
  for (const role of ROLES) {
    const name = statuses[role];
    if (typeof name !== "string") continue;
    const earlier = holders.get(name) ?? [];
    const clash = earlier.find((other) => !(SHARED_ROLES.has(other) && SHARED_ROLES.has(role)));
    if (clash) {
      problems.push({
        path: ["tracker", "statuses", role],
        message: `"${name}" is also ${clash}'s status, and only intake and backlog may share one`,
      });
    }
    holders.set(name, [...earlier, role]);
  }
  return problems;
}

type Table = Record<string, unknown>;

function asTable(value: unknown): Table | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Table) : undefined;
}

function asList(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}
