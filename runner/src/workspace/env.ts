// The `env` block: the only variables a session gets beyond the seven the Harness passes from outside
// (spec 1, "`settings.json`"). A cache refresh gets the same block, with its own session folder's `tmp/`.
// A repo's `env` block outranks the process environment, so everything a session depends on is set here (ADR 0007).
import { join } from "node:path";
import { paths, sessionParts, type Folders } from "../folders/index.ts";

export interface EnvInput {
  folders: Folders;
  /** The session folder: the session's own, or the refresh's. */
  sessionFolder: string;
  /** The registration's `path`. */
  path: string;
}

export function sessionEnv({ folders, sessionFolder, path }: EnvInput): Record<string, string> {
  const parts = sessionParts(sessionFolder);
  const home = (sub: string) => join(parts.home, sub);
  return {
    FLIGHT_DECK_SESSION: parts.sessionJson,
    PATH: path,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_SHELL: "/bin/bash",
    GIT_CONFIG_GLOBAL: paths.etcGitconfig(folders),
    GIT_CONFIG_NOSYSTEM: "1",
    // pnpm relinks a cloned node_modules without asking for a TTY.
    CI: "true",
    // turbo passes TMP to its tasks and drops TMPDIR.
    TMP: parts.tmp,
    TEMP: parts.tmp,
    TMPDIR: parts.tmp,
    TURBO_CACHE_DIR: home("cache/turbo"),
    // turbo's strict mode drops HTTPS_PROXY, so a fetching task would skip the sandbox's proxy.
    TURBO_ENV_MODE: "loose",
    // The sandbox blocks FSEvents, so fs.watch on a folder fails.
    WATCHPACK_POLLING: "true",
    NPM_CONFIG_USERCONFIG: paths.etcNpmrc(folders),
    NODE_OPTIONS: `--require ${nodeOptionWord(paths.etcRetryReset(folders))}`,
    // Empty folders, so turbo never reads the Vercel CLI's login under `~`.
    TURBO_CONFIG_DIR_PATH: home("config/turborepo"),
    VERCEL_CONFIG_DIR_PATH: home("config/vercel"),
    TURBO_TELEMETRY_DISABLED: "1",
    // The package manager's folders, as the FLD-42 prototype's depsEnv set them. pnpm 11 reads pnpm_config_*,
    // and the pnpm it switches to through packageManager reads npm_config_*.
    XDG_CACHE_HOME: home("cache"),
    XDG_DATA_HOME: home("data"),
    XDG_CONFIG_HOME: home("config"),
    XDG_STATE_HOME: home("state"),
    PNPM_HOME: home("data/pnpm"),
    pnpm_config_store_dir: home("data/pnpm/store"),
    npm_config_store_dir: home("data/pnpm/store"),
    COREPACK_HOME: home("data/corepack"),
    npm_config_cache: home("cache/npm"),
  };
}

/** The empty folders the `env` block points turbo and Vercel at. */
export function emptyConfigFolders(sessionFolder: string): string[] {
  const { home } = sessionParts(sessionFolder);
  return [join(home, "config/turborepo"), join(home, "config/vercel")];
}

/** NODE_OPTIONS splits on spaces and reads double quotes, so a path with a space goes in quotes. */
function nodeOptionWord(path: string): string {
  return /[\s"\\]/.test(path) ? `"${path.replace(/["\\]/g, "\\$&")}"` : path;
}
