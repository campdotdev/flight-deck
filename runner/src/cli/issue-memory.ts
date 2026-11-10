// A hand run's writes to issue memory (spec 1, "The runner's socket"). They go through the runner with the
// `issue_memory` op, so the runner never writes the same file at the same time. When the runner doesn't answer,
// `flight-deck apply` writes the file itself, under a lock file beside it.
import { mkdir, open, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { paths, type Folders } from "../folders/index.ts";
import type { IssueMemoryWrites } from "../outbox/index.ts";
import { ask } from "../socket/index.ts";
import { State } from "../state/index.ts";

/** How long a lock may stand before the command takes it for one a crashed `apply` left. */
const STALE_LOCK_MS = 30_000;
/** How long the command waits for another `apply` to let go of the lock. */
const LOCK_WAIT_MS = 10_000;

/**
 * Issue memory's writes for `flight-deck apply`: over the socket while the runner answers, and under the lock
 * file from the first write it doesn't answer, so a hung runner costs one wait, not one per write.
 */
export function handRunMemory(folders: Folders, answerMs: number): IssueMemoryWrites {
  let runnerAnswers = true;
  const state = new State(folders);
  return {
    write: async (repo, uuid, fields) => {
      if (runnerAnswers) {
        const reply = await ask(paths.socket(folders), { op: "issue_memory", repo, issue: uuid, write: fields }, answerMs);
        if (reply?.ok === true) return;
        if (reply !== null) throw new Error(`the runner refused the write to issue memory: ${reply.ok ? "no reason given" : reply.error}`);
        runnerAnswers = false;
      }
      const file = paths.issueMemory(folders, repo, uuid);
      await locked(`${file}.lock`, async () => state.writeIssueMemory(repo, uuid, { ...(await state.issueMemory(repo, uuid)), ...fields }));
    },
  };
}

/** Runs `work` while holding the lock file, made with `O_EXCL` so only one process holds it. */
async function locked(lock: string, work: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await (await open(lock, "wx", 0o600)).close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // The issue's first memory: its folder doesn't exist yet.
        await mkdir(dirname(lock), { recursive: true });
        continue;
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = await stat(lock).then((info) => Date.now() - info.mtimeMs, () => 0);
      if (age > STALE_LOCK_MS) {
        await rm(lock, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`another flight-deck apply holds ${lock}`);
      await Bun.sleep(50);
    }
  }
  try {
    await work();
  } finally {
    await rm(lock, { force: true });
  }
}
