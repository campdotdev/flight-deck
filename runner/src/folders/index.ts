// The folders and files the runner keeps (spec 1, "Folders and files"). Every module finds its paths here, so
// a test can put the data folder, the config folder, the session root, and the home folder in a temporary root.
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

export interface Folders {
  /** `~/.local/share/flight-deck/`. */
  data: string;
  /** `~/.config/flight-deck/`. */
  config: string;
  /** `/Users/Shared/flight-deck/<user>/`. */
  sessionRoot: string;
  /** The maintainer's home folder, for `~/.claude/projects/`. */
  home: string;
}

/** The folders on the maintainer's Mac. */
export function macFolders(): Folders {
  const home = homedir();
  return {
    data: join(home, ".local/share/flight-deck"),
    config: join(home, ".config/flight-deck"),
    sessionRoot: join("/Users/Shared/flight-deck", userInfo().username),
    home,
  };
}

/** `owner/repo` as its two path parts. */
function repoPath(repo: string): string {
  const [owner, name] = repo.split("/");
  return join(owner ?? "", name ?? "");
}

export const paths = {
  configToml: (f: Folders) => join(f.config, "config.toml"),
  runnerGitconfig: (f: Folders) => join(f.config, "gitconfig-runner"),

  state: (f: Folders) => join(f.data, "state"),
  sessionList: (f: Folders) => join(f.data, "state", "sessions.json"),
  status: (f: Folders) => join(f.data, "state", "status.json"),
  heartbeat: (f: Folders) => join(f.data, "state", "heartbeat"),
  log: (f: Folders) => join(f.data, "state", "runner.log"),
  /** The log before the current one, which a new log replaces. */
  oldLog: (f: Folders) => join(f.data, "state", "runner.log.1"),
  /** When the daily sweep last ran. */
  sweep: (f: Folders) => join(f.data, "state", "sweep.json"),
  handRuns: (f: Folders) => join(f.data, "hand-runs"),

  repo: (f: Folders, repo: string) => join(f.data, "repos", repoPath(repo)),
  clone: (f: Folders, repo: string) => join(f.data, "repos", repoPath(repo), "clone"),
  transcripts: (f: Folders, repo: string) => join(f.data, "repos", repoPath(repo), "transcripts"),
  transcript: (f: Folders, repo: string, session: string) => join(f.data, "repos", repoPath(repo), "transcripts", `${session}.jsonl`),
  cursor: (f: Folders, repo: string) => join(f.data, "repos", repoPath(repo), "cursor.json"),
  /** The copies of the record's `copy_files` that `register` makes (ADR 0007). */
  files: (f: Folders, repo: string) => join(f.data, "repos", repoPath(repo), "files"),
  /** The repo's last cache refresh: its commit, when it started, and whether it passed. */
  refresh: (f: Folders, repo: string) => join(f.data, "repos", repoPath(repo), "refresh.json"),
  issues: (f: Folders, repo: string) => join(f.data, "repos", repoPath(repo), "issues"),
  issueMemory: (f: Folders, repo: string, uuid: string) => join(f.data, "repos", repoPath(repo), "issues", `${uuid}.json`),

  worktrees: (f: Folders) => join(f.sessionRoot, "worktrees"),
  worktree: (f: Folders, session: string) => join(f.sessionRoot, "worktrees", session),
  sessions: (f: Folders) => join(f.sessionRoot, "sessions"),
  sessionFolder: (f: Folders, session: string) => join(f.sessionRoot, "sessions", session),
  /** A cache refresh's scratch worktree, `worktrees/cache-<owner>-<repo>`. */
  cacheWorktree: (f: Folders, repo: string) => join(f.sessionRoot, "worktrees", `cache-${repo.replace("/", "-")}`),
  /** The dependency cache, `cache/<owner>/<repo>/`. */
  cache: (f: Folders, repo: string) => join(f.sessionRoot, "cache", repoPath(repo)),
  /** The files every session's sandbox reads, outside `~` (spec 1, "Folders and files"). */
  etc: (f: Folders) => join(f.sessionRoot, "etc"),
  etcGitconfig: (f: Folders) => join(f.sessionRoot, "etc", "gitconfig"),
  etcNpmrc: (f: Folders) => join(f.sessionRoot, "etc", "npmrc"),
  etcRetryReset: (f: Folders) => join(f.sessionRoot, "etc", "retry-reset.cjs"),

  /** The binary in a version folder, which a session's helpers run. */
  bin: (versionFolder: string) => join(versionFolder, "bin", "flight-deck"),

  /** The folder Claude Code makes for a worktree: its path with every character but a letter or digit as `-`. */
  claudeProject: (f: Folders, worktree: string) => join(f.home, ".claude", "projects", worktree.replace(/[^A-Za-z0-9]/g, "-")),
};

/** A session folder's parts (overview, "The session folder"). */
export function sessionParts(folder: string) {
  return {
    sessionJson: join(folder, "session.json"),
    settingsJson: join(folder, "settings.json"),
    mcpJson: join(folder, "mcp.json"),
    inbox: join(folder, "inbox"),
    outbox: join(folder, "outbox"),
    tmp: join(folder, "tmp"),
    deps: join(folder, "deps"),
    /** The package manager's folders, and the empty config folders turbo and Vercel get. */
    home: join(folder, "home"),
  };
}
