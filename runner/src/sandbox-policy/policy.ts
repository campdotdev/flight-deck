// Sandbox policy (spec 1, "Sandbox policy"): the sandbox settings, built from the record and the session's
// paths. The Harness puts a session's into `settings.json`, and Workspace hands a cache refresh's to the
// pinned `sandbox-runtime`. One function builds both, so the two stay the same (ADR 0018).
import { join } from "node:path";
import { paths, sessionParts, type Folders } from "../folders/index.ts";
import type { RepoRecord } from "../record/index.ts";

/** No session reaches GitHub, whatever the record allows (ADR 0007). */
export const GITHUB_HOSTS = ["github.com", "api.github.com", "uploads.github.com"] as const;

interface Common {
  folders: Folders;
  /** `owner/repo`, whose clone the worktree's repo borrows objects from. */
  repo: string;
  /** The record at the commit the worktree starts from. */
  record: Pick<RepoRecord, "sandbox">;
  /** The running version's folder, never `current` (ADR 0015). */
  versionFolder: string;
  worktree: string;
  /** The session folder: the session's own, or the refresh's (spec 1, "Session IDs"). */
  sessionFolder: string;
}

/** A Claude Code session. */
export interface SessionTarget extends Common {
  kind: "session";
}

/** A dependency cache refresh, in its scratch worktree. */
export interface RefreshTarget extends Common {
  kind: "refresh";
}

/** A session's `sandbox` block in `settings.json`. */
export interface SessionSandbox {
  enabled: true;
  allowUnsandboxedCommands: false;
  failIfUnavailable: true;
  autoAllowBashIfSandboxed: true;
  filesystem: { denyRead: string[]; allowRead: string[]; allowWrite: string[]; denyWrite: string[] };
  network: { allowedDomains: string[]; deniedDomains: string[]; allowLocalBinding: true };
}

/** A cache refresh's `sandbox-runtime` settings. */
export interface RefreshSettings {
  network: { allowedDomains: string[]; deniedDomains: string[]; allowLocalBinding: false };
  filesystem: { denyRead: string[]; allowRead: string[]; allowWrite: string[]; denyWrite: string[] };
}

export function sandboxPolicy(target: SessionTarget): SessionSandbox;
export function sandboxPolicy(target: RefreshTarget): RefreshSettings;
export function sandboxPolicy(target: SessionTarget | RefreshTarget): SessionSandbox | RefreshSettings {
  const { folders, worktree, sessionFolder, versionFolder } = target;
  const parts = sessionParts(sessionFolder);
  const network = { allowedDomains: [...target.record.sandbox.hosts], deniedDomains: [...GITHUB_HOSTS] };
  // `~/` and the session root, so no session reads another session's folder, worktree, or copied files,
  // or another repo's cache.
  const denyRead = [`${folders.home}/`, folders.sessionRoot];
  const allowRead = [
    worktree,
    sessionFolder,
    join(versionFolder, "skills"),
    join(versionFolder, "plugin"),
    paths.claudeProject(folders, worktree),
    paths.clone(folders, target.repo),
    paths.etc(folders),
    ...target.record.sandbox.read_paths.map((path) => expandHome(folders, path)),
  ];
  // No session moves a ref, writes an object, or plants a graft in the clone (ADR 0007).
  const denyWrite = [join(paths.clone(folders, target.repo), ".git")];

  if (target.kind === "session") {
    return {
      enabled: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      // The worktree's own repo sits inside the worktree, which Claude Code's sandbox lets a session write.
      filesystem: { denyRead, allowRead, allowWrite: [parts.outbox, parts.tmp, parts.deps, parts.home], denyWrite },
      // The app listens on the session's port (ADR 0009).
      network: { ...network, allowLocalBinding: true },
    };
  }

  // `sandbox-runtime` doesn't make the working folder writable on its own, and the refresh writes into
  // the cache, which is the one folder under the session root it may read beyond the session's rules.
  const cache = paths.cache(folders, target.repo);
  return {
    network: { ...network, allowLocalBinding: false },
    filesystem: { denyRead, allowRead: [...allowRead, cache], allowWrite: [worktree, parts.deps, parts.tmp, cache], denyWrite },
  };
}

/** A `read_paths` entry starts with `~/`, which means the maintainer's home folder. */
function expandHome(folders: Folders, path: string): string {
  return path.startsWith("~/") ? join(folders.home, path.slice(2)) : path;
}
