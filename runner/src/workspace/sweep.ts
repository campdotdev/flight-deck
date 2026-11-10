// The daily sweep (spec 1, "Workspace"): it removes what sessions leave behind. Poll decides when it runs.
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { paths, type Folders } from "../folders/index.ts";

/** Transcripts and hand-run folders older than this go (ADR 0012). */
const KEEP_MS = 30 * 24 * 60 * 60_000;

export interface SweepInput {
  folders: Folders;
  now: Date;
  /** The names under `worktrees/` and `sessions/` that stay: the session list's IDs, and a running refresh's or trial's. */
  keep: Set<string>;
}

/**
 * Removes every worktree and session folder not in `keep`, with the `~/.claude/projects/` folder Claude Code
 * made for each removed worktree, then every transcript, trial run's transcript, and hand-run folder older
 * than 30 days. Returns what
 * it removed, as paths.
 */
export async function sweep({ folders, now, keep }: SweepInput): Promise<string[]> {
  const removed: string[] = [];
  for (const name of await list(paths.worktrees(folders))) {
    if (keep.has(name)) continue;
    const worktree = join(paths.worktrees(folders), name);
    await rm(worktree, { recursive: true, force: true });
    await rm(paths.claudeProject(folders, worktree), { recursive: true, force: true });
    removed.push(worktree);
  }
  for (const name of await list(paths.sessions(folders))) {
    if (keep.has(name)) continue;
    const folder = join(paths.sessions(folders), name);
    await rm(folder, { recursive: true, force: true });
    removed.push(folder);
  }

  const old = (time: number) => now.getTime() - time > KEEP_MS;
  const transcriptFolders = [paths.trials(folders)];
  for (const owner of await list(join(folders.data, "repos"))) {
    for (const repo of await list(join(folders.data, "repos", owner))) transcriptFolders.push(paths.transcripts(folders, `${owner}/${repo}`));
  }
  for (const transcripts of transcriptFolders) {
    for (const name of await list(transcripts)) {
      const file = join(transcripts, name);
      if (!old((await stat(file)).mtimeMs)) continue;
      await rm(file, { recursive: true, force: true });
      removed.push(file);
    }
  }
  for (const name of await list(paths.handRuns(folders))) {
    const folder = join(paths.handRuns(folders), name);
    if (!old(handRunTime(name) ?? (await stat(folder)).mtimeMs)) continue;
    await rm(folder, { recursive: true, force: true });
    removed.push(folder);
  }
  return removed;
}

/** A hand-run folder is `<issue>-<time>`, with the time in UTC to the second, such as `20261103T091530Z`. */
function handRunTime(name: string): number | null {
  const match = /-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(name);
  if (match === null) return null;
  const [, y, mo, d, h, mi, s] = match.map(Number) as [number, number, number, number, number, number, number];
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

async function list(folder: string): Promise<string[]> {
  try {
    return await readdir(folder);
  } catch {
    return [];
  }
}
