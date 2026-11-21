// Outboxes Linear wouldn't take (spec 1's "Exits", "Not yet written" and "Not yet written after the move").
// An exit whose apply returned `unwritten` leaves its entry `apply_waiting`, which takes no place under the cap.
// The runner applies the outbox again at the next poll, then after 1, 2, 4, and 8 minutes, then every 15 minutes,
// with no session. Each apply skips the writes `applied.json` records.
//
// Before the status move, after 3 hours, the runner moves the outbox to the kept folder, notes it in issue
// memory, and pauses the issue with the Linear-write text. A pause Linear doesn't take either keeps the entry
// and is tried on the same backoff. The next take of a paused-then-resumed issue applies the kept outbox
// instead of starting a session, and any other move out of Paused deletes it.
//
// After the move, the stage has handed off: the rest is tried on the same backoff, and after 3 hours it's
// dropped and logged, with no pause.
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { paths, sessionParts, type Folders } from "../folders/index.ts";
import { Lifecycle } from "../lifecycle/index.ts";
import { Outbox, type ApplyResult } from "../outbox/index.ts";
import type { FailedExit } from "../outbox/runner-comments/failed-twice.ts";
import { RunnerComments, runnerComment, type RunnerFacts, type RunnerWriteResult } from "../outbox/runner-comments/index.ts";
import { linearWrite } from "../outbox/runner-comments/linear-write.ts";
import type { Role } from "../record/index.ts";
import type { ApplyWait, SessionEntry, State } from "../state/index.ts";
import { isUnavailable, type Snapshot, type SnapshotIssue, type Tracker, type TrackerRepo } from "../tracker/index.ts";
import type { SessionJson, Workspace } from "../workspace/index.ts";
import { onTeam } from "./moved-out.ts";
import { WORKING } from "./stages.ts";

/** The waits between tries: the next poll, then 1, 2, 4, and 8 minutes. Every 15 minutes after that. */
const BACKOFF_MS = [0, 1, 2, 4, 8].map((minutes) => minutes * 60_000);
const EVERY_MS = 15 * 60_000;
/** How long the runner tries an outbox before it keeps it, or drops the writes after the move. */
export const GIVE_UP_MS = 3 * 60 * 60_000;

/** The files the kept folder holds. `session.json` goes too, because `Outbox.apply` reads the session's repo, issue, and stage from it. */
const KEPT_FILES = ["session.json", "outbox", "applied.json"];

/** The entry once its apply waits: no process, no start time or deadline, and its first try. */
export function waitingEntry(entry: SessionEntry, wait: { folder: string; phase: ApplyWait["phase"]; now: Date }): SessionEntry {
  const at = wait.now.toISOString();
  return {
    ...entry,
    pid: null,
    pid_started_at: null,
    claude_uuid: null,
    started_at: null,
    deadline: null,
    state: "apply_waiting",
    apply: { folder: wait.folder, phase: wait.phase, since: at, tried_at: at, tries: 1 },
  };
}

/** The phase after an `unwritten` result: once the move has landed, it stays landed. */
export function phaseAfter(phase: ApplyWait["phase"], result: ApplyResult): ApplyWait["phase"] {
  return phase === "after_move" || result.writes.includes("move") ? "after_move" : phase;
}

function nextTry(wait: ApplyWait): number {
  return Date.parse(wait.tried_at) + (BACKOFF_MS[Math.max(0, wait.tries - 1)] ?? EVERY_MS);
}

/**
 * Whether the entry's next try has come: its backoff ran out, or the 3 hours did, for one last try. A try that
 * can't settle the entry then, because Linear didn't answer, waits for the backoff again.
 */
function due(wait: ApplyWait, now: Date): boolean {
  const at = now.getTime();
  const tried = Date.parse(wait.tried_at);
  if (at <= tried) return false;
  const deadline = Date.parse(wait.since) + GIVE_UP_MS;
  return at >= nextTry(wait) || (wait.phase !== "pause" && at >= deadline && tried < deadline);
}

/** Whether the entry's 3 hours ran out, so its outbox is kept, or the writes after the move are dropped. */
function expired(wait: ApplyWait, now: Date): boolean {
  return now.getTime() >= Date.parse(wait.since) + GIVE_UP_MS;
}

export interface ApplyWaitingOptions {
  folders: Folders;
  /** The running version. */
  version: string;
  /** The Tracker adapter, as the Flight Deck app. */
  tracker: Tracker;
  state: State;
  /** An Outbox that maps the session's repo to `repo`, the statuses its take read. */
  outbox(now: Date, repo: TrackerRepo): Outbox;
  /** A failed session, as an exit's: the first failure waits as `retry_waiting`, and a second pauses the issue. */
  fail(now: Date, repo: TrackerRepo, entry: SessionEntry, failure: FailedExit, facts: RunnerFacts, workspace: Workspace): Promise<void>;
}

export class ApplyWaiting {
  private readonly folders: Folders;
  private readonly tracker: Tracker;
  private readonly state: State;
  private readonly lifecycle: Lifecycle;

  constructor(private readonly options: ApplyWaitingOptions) {
    this.folders = options.folders;
    this.tracker = options.tracker;
    this.state = options.state;
    this.lifecycle = new Lifecycle(options.tracker);
  }

  /**
   * Tries each `apply_waiting` entry whose next try has come, in list order. An entry whose try throws for any
   * reason but Linear's stays as it was and is tried again at the next poll, and the entries after it still go.
   */
  async retry(now: Date, repoOf: (entry: SessionEntry) => Promise<TrackerRepo | null>, workspace: Workspace): Promise<void> {
    for (const entry of await this.state.sessions()) {
      if (entry.state !== "apply_waiting" || entry.apply === undefined || !due(entry.apply, now)) continue;
      try {
        // The repo with the statuses the entry's take read, as an exit's handling reads it.
        const repo = await repoOf(entry);
        if (repo === null) continue;
        await this.tryOnce(now, this.options.outbox(now, repo), repo, entry, workspace);
      } catch (error) {
        await this.log(now, entry, `apply try failed, retrying next poll: ${(error as Error).message}`);
      }
    }
  }

  private async tryOnce(now: Date, outbox: Outbox, repo: TrackerRepo, entry: SessionEntry, workspace: Workspace): Promise<void> {
    try {
      if (entry.apply!.phase === "pause") await this.retryPause(now, repo, entry);
      else await this.apply(now, outbox, repo, entry, workspace);
    } catch (error) {
      if (!isUnavailable(error)) throw error;
      await this.log(now, entry, `Linear didn't answer: ${error.message}`);
      const tried = await this.tried(now, entry);
      const wait = tried.apply!;
      // A pause's comment waits for the entry's next try, so the poll's own comment retry doesn't try it first.
      if (wait.phase === "pause") return this.holdComment(tried);
      // A read Linear didn't answer still ends the 3 hours: the outbox is kept, or the writes after the move go.
      if (!expired(wait, now)) return;
      if (wait.phase === "after_move") return this.dropAfterMove(now, outbox, tried, workspace);
      return this.keep(now, repo, tried, workspace);
    }
  }

  /**
   * At a take: when issue memory holds a kept outbox, takes the issue and applies the kept outbox instead of
   * starting a session. Returns whether it did, so the caller starts nothing for the issue.
   */
  async applyKept(now: Date, repo: TrackerRepo, issue: SnapshotIssue, workspace: Workspace): Promise<boolean> {
    const memory = await this.state.issueMemory(repo.name, issue.id);
    if (memory.kept === null) return false;
    const folder = paths.kept(this.folders, repo.name, issue.id);
    // An earlier take of it still tries the writes after its move, so this take starts a fresh session.
    if ((await this.state.sessions()).some((each) => each.apply?.folder === folder)) return false;
    if (!existsSync(sessionParts(folder).sessionJson)) {
      await this.forgetKept(now, repo.name, issue.id, `${issue.identifier}: the kept outbox is gone, the take starts a session`);
      return false;
    }
    const session = JSON.parse(await readFile(sessionParts(folder).sessionJson, "utf8")) as SessionJson;
    const waiting = waitingEntry(
      {
        id: session.session,
        repo: repo.name,
        issue: issue.identifier,
        issue_id: issue.id,
        title: issue.title,
        stage: session.stage,
        mode: session.mode,
        attempt: 1,
        pid: null,
        pid_started_at: null,
        claude_uuid: null,
        worktree: paths.worktree(this.folders, session.session),
        started_at: null,
        deadline: null,
        state: "apply_waiting",
      },
      { folder, phase: "apply", now },
    );
    const entry: SessionEntry = { ...waiting, apply: { ...waiting.apply!, tries: 0 } };
    // The entry first, then the take, so the issue never sits in the working status unseen (ADR 0002).
    await this.state.writeSessions([...(await this.state.sessions()), entry]);
    const working = WORKING[entry.stage] ?? "planning";
    try {
      const taken = await this.lifecycle.move(issue, working, "take");
      if (!taken.ok) {
        await this.log(now, entry, `take refused: ${taken.violation}`);
        await this.dropEntry(entry.id);
        return true;
      }
    } catch (error) {
      // A take whose response was lost may have landed, so the entry stays. Its next try reads the issue: in Ready
      // to plan, the take didn't land, and the entry goes with the kept outbox left for the next take.
      if (!isUnavailable(error)) throw error;
      await this.log(now, entry, `take of the kept outbox waits: ${error.message}`);
      return true;
    }
    await this.log(now, entry, "took the issue to apply its kept outbox");
    await this.apply(now, this.options.outbox(now, repo), repo, entry, workspace);
    return true;
  }

  /**
   * Deletes each kept outbox whose issue moved out of Paused anywhere but Ready to plan, because only a resume
   * applies it (ADR 0007). An issue with an entry in the session list is being applied or paused, so it stays.
   */
  async forget(now: Date, repo: TrackerRepo, snapshot: Snapshot): Promise<void> {
    const listed = new Set((await this.state.sessions()).map((entry) => entry.issue_id));
    for (const { uuid, memory } of await this.state.issueMemories(repo.name)) {
      if (memory.kept === null || listed.has(uuid)) continue;
      const issue = snapshot.issues.find((each) => each.id === uuid);
      if (issue?.role === "paused" || issue?.role === "ready_to_plan") continue;
      await this.forgetKept(now, repo.name, uuid, `${issue?.identifier ?? uuid}: left Paused, kept outbox deleted`);
    }
  }

  /**
   * Step 4, moved out: the maintainer moved the issue before the status move landed, so the outbox is
   * discarded at this poll, not at its next try (ADR 0007). Only an `apply`-phase entry gets here.
   */
  async movedOut(now: Date, entry: SessionEntry, role: Role | null, workspace: Workspace): Promise<void> {
    if (this.untaken(entry, role)) return this.leaveKept(now, entry);
    await this.log(now, entry, `left ${WORKING[entry.stage]}, outbox discarded`);
    await this.discard(entry, workspace);
  }

  // One try.

  private async apply(now: Date, outbox: Outbox, repo: TrackerRepo, start: SessionEntry, workspace: Workspace): Promise<void> {
    let entry = start;
    let wait = entry.apply!;
    // A deleted, archived, or moved issue takes no more writes, in either phase.
    const issue = await onTeam(this.tracker, repo, entry);
    if (issue === null && wait.phase === "after_move") {
      await this.log(now, entry, "the issue is gone, writes after the move dropped");
      return this.discard(entry, workspace);
    }
    // An entry kept past its 3 hours, because Linear didn't answer the listing then, lists and drops its writes.
    if (wait.phase === "after_move" && wait.dropping === true) {
      return this.dropAfterMove(now, outbox, await this.tried(now, entry), workspace);
    }
    if (wait.phase === "apply") {
      if (issue !== null && this.untaken(entry, issue.role)) return this.leaveKept(now, entry);
      // An issue the maintainer moved before the move landed: the outbox is discarded (ADR 0007). As at an exit,
      // an outbox whose move landed before a lost response is applied again, so the writes after the move land.
      if (issue === null || (issue.role !== WORKING[entry.stage] && !(await Outbox.moved(wait.folder, issue.role)))) {
        await this.log(now, entry, `left ${WORKING[entry.stage]}, outbox discarded`);
        return this.discard(entry, workspace);
      }
      // The move landed, so the stage handed off, whatever this try writes.
      if (issue.role !== WORKING[entry.stage]) {
        entry = await this.handedOff(now, entry);
        wait = entry.apply!;
      }
    }
    const replay = wait.folder === paths.kept(this.folders, entry.repo, entry.issue_id);
    const result = await outbox.apply(wait.folder, { identity: this.tracker, replay });
    await this.log(now, entry, `outbox ${JSON.stringify(result)}`);
    switch (result.result) {
      case "applied":
      case "paused":
        return this.discard(entry, workspace);
      case "failed":
        if (wait.phase === "after_move") {
          await this.log(now, entry, `writes after the move dropped: ${result.rule}`);
          return this.discard(entry, workspace);
        }
        await this.discardKept(entry);
        return this.options.fail(now, repo, entry, { kind: "refused", rule: result.rule }, this.facts(entry), workspace);
      case "unwritten": {
        const next: ApplyWait = { ...wait, phase: phaseAfter(wait.phase, result), tried_at: now.toISOString(), tries: wait.tries + 1 };
        const updated: SessionEntry = { ...entry, apply: next };
        if (now.getTime() < Date.parse(next.since) + GIVE_UP_MS) return this.writeEntry(updated);
        if (next.phase === "after_move") return this.dropAfterMove(now, outbox, updated, workspace);
        return this.keep(now, repo, updated, workspace);
      }
    }
  }

  /** After 3 hours past the move: logs each write still to land and drops them, with no pause. */
  private async dropAfterMove(now: Date, outbox: Outbox, entry: SessionEntry, workspace: Workspace): Promise<void> {
    const rest = await outbox.apply(entry.apply!.folder, { identity: this.tracker, dryRun: true });
    if (rest.result === "unwritten") {
      // The writes still to land need a Linear read to list, so the entry waits for a try Linear answers, and
      // that try only lists them.
      await this.writeEntry({ ...entry, apply: { ...entry.apply!, dropping: true } });
      await this.log(now, entry, "Linear didn't answer, so the writes after the move wait to be listed and dropped");
      return;
    }
    for (const write of rest.writes) await this.log(now, entry, `${write} dropped: Linear didn't take it for 3 hours`);
    await this.discard(entry, workspace);
  }

  /** After 3 hours before the move: moves the outbox to the kept folder, notes it, and pauses the issue. */
  private async keep(now: Date, repo: TrackerRepo, entry: SessionEntry, workspace: Workspace): Promise<void> {
    const wait = entry.apply!;
    const kept = paths.kept(this.folders, repo.name, entry.issue_id);
    if (wait.folder !== kept) {
      // An earlier take of the kept folder whose writes after its move still wait is past its own 3 hours, and
      // this handoff replaces the folder, so that entry's writes go first.
      for (const other of await this.state.sessions()) {
        if (other.id === entry.id || other.apply?.folder !== kept) continue;
        await this.log(now, other, "writes after the move dropped: a newer handoff takes the kept folder");
        await this.dropEntry(other.id);
      }
      await rm(kept, { recursive: true, force: true });
      await mkdir(kept, { recursive: true });
      for (const name of KEPT_FILES) {
        const from = join(wait.folder, name);
        if (existsSync(from)) await cp(from, join(kept, name), { recursive: true });
      }
    }
    // Issue memory and the entry name the kept copy before the session folder goes, so a failed write leaves a
    // folder a later try can still read.
    const memory = await this.state.issueMemory(repo.name, entry.issue_id);
    await this.state.writeIssueMemory(repo.name, entry.issue_id, { ...memory, kept: { session: entry.id, at: now.toISOString() } });
    const pausing: SessionEntry = { ...entry, apply: { folder: kept, phase: "pause", since: wait.since, tried_at: now.toISOString(), tries: 1 } };
    await this.writeEntry(pausing);
    if (wait.folder !== kept) await workspace.dispose({ session: entry.id, worktree: entry.worktree });
    await this.log(now, entry, `Linear didn't take the outbox for 3 hours, kept in ${kept}`);
    await this.postPause(now, repo, pausing);
  }

  /** Posts the Linear-write pause, unless the maintainer moved the issue out of its working status. */
  private async postPause(now: Date, repo: TrackerRepo, entry: SessionEntry): Promise<void> {
    const issue = await onTeam(this.tracker, repo, entry);
    const working = WORKING[entry.stage];
    if (issue !== null && issue.role !== working && (await Outbox.moved(entry.apply!.folder, issue.role))) {
      await this.handedOff(now, entry);
      return;
    }
    if (issue === null || working === undefined || issue.role !== working) return this.moved(now, repo, entry, issue?.role ?? null);
    const comment = runnerComment(linearWrite(entry.apply!.folder), this.facts(entry), { version: this.options.version, statuses: repo.statuses });
    const posting: SessionEntry = { ...entry, apply: { ...entry.apply!, posted: true } };
    await this.writeEntry(posting);
    const result = await this.comments(now).post({ ...issue, role: working }, comment);
    await this.paused(now, repo, posting, result, working);
  }

  /** Tries the Linear-write pause again: the comment's pending writes, or the whole pause if none was made. */
  private async retryPause(now: Date, repo: TrackerRepo, entry: SessionEntry): Promise<void> {
    const tried = await this.tried(now, entry);
    // A deleted, archived, or moved issue reads as `null`, which drops the pending comment as a moved issue does.
    const issue = await onTeam(this.tracker, repo, entry);
    const memory = await this.state.issueMemory(repo.name, entry.issue_id);
    if (memory.pending === null) {
      if (issue?.role === WORKING[entry.stage]) return this.postPause(now, repo, tried);
      // A posted pause that left issue memory landed, as through the poll's own comment retry.
      if (tried.apply!.posted === true && issue?.role === "paused") return this.dropEntry(entry.id);
      // With no pause posted, an issue in the outbox's move status, Paused included, got there through the move.
      if (tried.apply!.posted !== true && issue !== null && (await Outbox.moved(entry.apply!.folder, issue.role))) {
        await this.handedOff(now, tried);
        return;
      }
      if (issue?.role === "paused") return this.dropEntry(entry.id);
      return this.moved(now, repo, entry, issue?.role ?? null);
    }
    await this.paused(now, repo, tried, (await this.comments(now).retry(repo, entry.issue_id, issue)) ?? "landed", issue?.role ?? null);
  }

  /** After a try of the pause: a landed pause ends the entry, and a pending one waits for the backoff's next try. */
  private async paused(now: Date, repo: TrackerRepo, entry: SessionEntry, result: RunnerWriteResult, role: Role | null): Promise<void> {
    await this.log(now, entry, `Linear-write pause ${result}`);
    if (result === "landed") return this.dropEntry(entry.id);
    if (result === "dropped") return this.moved(now, repo, entry, role);
    // The poll's own retry of pending comments holds off until then.
    await this.holdComment(entry);
  }

  /**
   * The issue left its working status while the pause waited: the entry goes. In Ready to plan, after a `retry`
   * or a hand move, the kept outbox stays for the next take. Anywhere else, it goes too.
   */
  private async moved(now: Date, repo: TrackerRepo, entry: SessionEntry, role: Role | null): Promise<void> {
    if (role === "ready_to_plan") return this.leaveKept(now, entry);
    await this.forgetKept(now, repo.name, entry.issue_id, `${entry.id} ${entry.issue}: moved before the Linear-write pause landed, kept outbox deleted`);
    await this.dropEntry(entry.id);
  }

  // Shared steps.

  /** Records a try at `now` in the entry, once per poll, and returns the entry as written. */
  private async tried(now: Date, entry: SessionEntry): Promise<SessionEntry> {
    const current = (await this.state.sessions()).find((each) => each.id === entry.id) ?? entry;
    const wait = current.apply!;
    if (wait.tried_at === now.toISOString()) return current;
    const updated = { ...current, apply: { ...wait, tried_at: now.toISOString(), tries: wait.tries + 1 } };
    await this.writeEntry(updated);
    return updated;
  }

  /**
   * The outbox's move landed before a lost response: the stage handed off, so the entry tries the writes after the
   * move, with no pause. Returns the entry as written.
   */
  private async handedOff(now: Date, entry: SessionEntry): Promise<SessionEntry> {
    const updated: SessionEntry = { ...entry, apply: { ...entry.apply!, phase: "after_move" } };
    await this.writeEntry(updated);
    await this.log(now, entry, "the move landed, so the writes after it keep trying");
    return updated;
  }

  /** Holds the Linear-write pause's pending comment until the entry's next try, so only the entry tries it. */
  private async holdComment(entry: SessionEntry): Promise<void> {
    const memory = await this.state.issueMemory(entry.repo, entry.issue_id);
    if (memory.pending === null) return;
    const notBefore = new Date(nextTry(entry.apply!)).toISOString();
    await this.state.writeIssueMemory(entry.repo, entry.issue_id, { ...memory, pending: { ...memory.pending, not_before: notBefore } });
  }

  /** Whether the entry is a kept outbox's take whose issue sits in Ready to plan, so the take didn't land or was undone. */
  private untaken(entry: SessionEntry, role: Role | null): boolean {
    return role === "ready_to_plan" && entry.apply?.folder === paths.kept(this.folders, entry.repo, entry.issue_id);
  }

  /** Drops the entry and leaves the kept outbox, which the issue's next take applies. */
  private async leaveKept(now: Date, entry: SessionEntry): Promise<void> {
    await this.log(now, entry, "in Ready to plan, the kept outbox waits for the next take");
    await this.dropEntry(entry.id);
  }

  /** The outbox is applied or discarded: the session folder goes, a kept outbox goes, and the entry goes. */
  private async discard(entry: SessionEntry, workspace: Workspace): Promise<void> {
    await workspace.dispose({ session: entry.id, worktree: entry.worktree });
    await this.discardKept(entry);
    await this.dropEntry(entry.id);
  }

  /** Deletes the kept folder the entry applied, unless a newer handoff took it over since. */
  private async discardKept(entry: SessionEntry): Promise<void> {
    if (entry.apply?.folder !== paths.kept(this.folders, entry.repo, entry.issue_id)) return;
    const memory = await this.state.issueMemory(entry.repo, entry.issue_id);
    if (memory.kept !== null && memory.kept.session !== entry.id) return;
    await rm(entry.apply.folder, { recursive: true, force: true });
    await this.state.writeIssueMemory(entry.repo, entry.issue_id, { ...memory, kept: null });
  }

  private async forgetKept(now: Date, repo: string, uuid: string, message: string): Promise<void> {
    await rm(paths.kept(this.folders, repo, uuid), { recursive: true, force: true });
    const memory = await this.state.issueMemory(repo, uuid);
    if (memory.kept !== null) await this.state.writeIssueMemory(repo, uuid, { ...memory, kept: null });
    await this.state.log(now, message);
  }

  /** The facts a runner comment's fold lists for the entry's session. No exit: the session ended long ago. */
  private facts(entry: SessionEntry): RunnerFacts {
    return { session: entry.id, attempt: entry.attempt, transcript: paths.transcript(this.folders, entry.repo, entry.id) };
  }

  private comments(now: Date): RunnerComments {
    return new RunnerComments({ tracker: this.tracker, state: this.state, clock: () => now });
  }

  private async writeEntry(entry: SessionEntry): Promise<void> {
    await this.state.writeSessions((await this.state.sessions()).map((each) => (each.id === entry.id ? entry : each)));
  }

  private async dropEntry(id: string): Promise<void> {
    await this.state.writeSessions((await this.state.sessions()).filter((each) => each.id !== id));
  }

  private async log(now: Date, entry: SessionEntry, message: string): Promise<void> {
    await this.state.log(now, `${entry.id} ${entry.issue}: ${message}`);
  }
}
