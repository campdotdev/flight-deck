// Poll, the runner's core (overview, spec 1's "Poll"). `tick(now)` handles every queued exit, then polls each
// registered repo, then starts sessions and publishes `status.json`. Everything it does shows through the
// Tracker and Harness ports and the state file, so scenarios test it there.
//
// Each kind of exit has its handler in `exits/`, and each comment the runner writes on its own has its text in
// `../outbox/runner-comments/`. Later tickets add the team check, moved-out issues, stale takes, trouble,
// usage, holds, and the start order.
import { readFile } from "node:fs/promises";
import type { Folders } from "../folders/index.ts";
import { paths, sessionParts } from "../folders/index.ts";
import { buildLaunch, type Auth, type Exit, type ExitKind, type Handle, type Harness, type HarnessSession } from "../harness/index.ts";
import { readConfig, writeEtc, type Config, type Registration } from "../install/index.ts";
import { Lifecycle } from "../lifecycle/index.ts";
import { Outbox } from "../outbox/index.ts";
import { failedTwice, type FailedExit } from "../outbox/runner-comments/failed-twice.ts";
import { RunnerComments, runnerComment, type RunnerFacts, type RunnerText } from "../outbox/runner-comments/index.ts";
import { durationMs, readRecord, type RecordResult, type RepoRecord } from "../record/index.ts";
import { State, type IssueMemory, type OpenPause, type Reply, type SessionEntry, type Stage, type Status, type StatusRepo } from "../state/index.ts";
import { FACTORY_ROLES, QUEUE_ROLES, type Snapshot, type SnapshotIssue, type Tracker, type TrackerRepo } from "../tracker/index.ts";
import { Workspace, type FetchResult, type SessionJson } from "../workspace/index.ts";
import { answerOf } from "./answers.ts";
import { EXITS, type ExitContext } from "./exits/index.ts";
import { MAX_ATTEMPTS, WORKING } from "./stages.ts";

export interface PollOptions {
  folders: Folders;
  /** The running version. */
  version: string;
  /** The running version's folder, never `current` (ADR 0015). */
  versionFolder: string;
  /** The Tracker adapter, as the Flight Deck app. */
  tracker: Tracker;
  harness: Harness;
}

const RECORD_PATH = ".flight-deck/record.toml";

/** What one tick learned about one repo. */
interface RepoPoll {
  registration: Registration;
  tracker: TrackerRepo | null;
  fetch: FetchResult;
  /** The record on the default branch, or `null` when the branch holds none. */
  record: RecordResult | null;
  snapshot: Snapshot | null;
  waitingForSpecs: SnapshotIssue[];
  /**
   * The issues with a runner comment that hadn't landed at the start of this poll. Nothing else happens to them,
   * except that a runner pause keeps its replies.
   */
  blocked: Set<string>;
}

interface QueuedExit {
  session: string;
  exit: Exit;
}

export class Poll {
  private readonly folders: Folders;
  private readonly version: string;
  private readonly versionFolder: string;
  private readonly tracker: Tracker;
  private readonly harness: Harness;
  private readonly lifecycle: Lifecycle;
  private readonly state: State;
  /** Exits queue as they happen, and the next tick handles them first. */
  private readonly exits: QueuedExit[] = [];
  /** The `[machine_user]` that `etc/` was last written from, or `null` before this runner's first write. */
  private etcFor: string | null = null;

  constructor(options: PollOptions) {
    this.folders = options.folders;
    this.version = options.version;
    this.versionFolder = options.versionFolder;
    this.tracker = options.tracker;
    this.harness = options.harness;
    this.lifecycle = new Lifecycle(options.tracker);
    this.state = new State(options.folders);
  }

  /** Runs one poll for every registered repo. */
  async tick(now: Date): Promise<void> {
    const config = await readConfig(this.folders);
    await this.writeEtc(config);
    const workspace = new Workspace({ folders: this.folders, git: config.paths.git });
    await this.handleExits(now, config, workspace);

    const repos: RepoPoll[] = [];
    for (const registration of config.repos) repos.push(await this.pollRepo(now, config, registration, workspace));

    await this.starts(now, config, repos, workspace);
    await this.publish(now, config, repos);
  }

  /** `etc/` at each start, and again whenever `[machine_user]` changes (spec 1, "Folders and files"). */
  private async writeEtc(config: Config): Promise<void> {
    const machineUser = JSON.stringify(config.machine_user ?? null);
    if (machineUser === this.etcFor) return;
    await writeEtc(this.folders, config.machine_user);
    this.etcFor = machineUser;
  }

  // Exits.

  /**
   * An exit leaves the queue only once it's handled. One that throws, such as on a failed Linear read, stays queued
   * for the next tick, and the exits after it are still handled. Handling it again is safe: the Outbox skips the
   * writes `applied.json` records, and an issue the move already left Planning has its outbox discarded.
   */
  private async handleExits(now: Date, config: Config, workspace: Workspace): Promise<void> {
    for (const queued of [...this.exits]) {
      try {
        await this.handleExit(now, config, workspace, queued);
        this.exits.splice(this.exits.indexOf(queued), 1);
      } catch (error) {
        await this.state.log(now, `${queued.session}: exit ${queued.exit.kind} not handled, retrying next poll: ${(error as Error).message}`);
      }
    }
  }

  private async handleExit(now: Date, config: Config, workspace: Workspace, { session, exit }: QueuedExit): Promise<void> {
    const sessions = await this.state.sessions();
    const entry = sessions.find((each) => each.id === session);
    if (entry === undefined) return;
    const registration = config.repos.find((repo) => repo.name === entry.repo);
    const repo = registration === undefined ? null : await this.sessionRepo(config, registration, entry.id, workspace);
    if (repo === null) {
      // Linear's revoke takes only the token, but `Tracker.revoke` takes a repo, and with no registration or no
      // `login linear` for the workspace, Poll can't build one. The token stays live until it expires, as one a
      // crashed runner leaves does (ADR 0005). FLD-109 revokes by session from the token the adapter holds.
      const why = registration === undefined ? `${entry.repo} isn't registered` : "its workspace has no Linear login";
      await this.state.log(now, `${entry.id} ${entry.issue}: Reader token not revoked, because ${why}`);
      await this.state.log(now, `${entry.id} ${entry.issue}: exit ${exit.kind}`);
      await this.finish(entry, workspace);
      return;
    }
    await this.tracker.revoke({ id: entry.id, repo });

    const sessionFolder = paths.sessionFolder(this.folders, entry.id);
    const outbox = new Outbox({ version: this.version, state: this.state, clock: () => now, repo: (name) => (name === entry.repo ? repo : null) });
    const { transcript, claudeCodeVersion: _, error, ...kind } = exit;
    const facts: RunnerFacts = { exit: kind as ExitKind, session: entry.id, attempt: entry.attempt, transcript };
    if (error !== undefined) facts.error = error;
    const context: ExitContext = {
      now,
      entry,
      exit,
      repo,
      tracker: this.tracker,
      state: this.state,
      workspace,
      sessionFolder,
      facts,
      apply: () => outbox.apply(sessionFolder, { identity: this.tracker }),
      finish: () => this.finish(entry, workspace),
      fail: (failure) => this.fail(now, repo, entry, failure, facts, workspace),
      pause: (text) => this.runnerPause(now, repo, entry, text, facts, workspace),
      log: (message) => this.state.log(now, `${entry.id} ${entry.issue}: ${message}`),
    };
    await EXITS[exit.kind](context);
  }

  /**
   * The repo as the take saw it: the record at the commit `session.json` names, which the take read and found
   * valid. The default branch's record or the registration's copy may name other statuses by now, and reading
   * the issue's status with those would discard a finished outbox or move the issue to the wrong status.
   * A session folder or commit that can't be read falls back to the registration's copy.
   */
  private async sessionRepo(config: Config, registration: Registration, session: string, workspace: Workspace): Promise<TrackerRepo | null> {
    let record: RepoRecord | null = null;
    try {
      const json = JSON.parse(await readFile(sessionParts(paths.sessionFolder(this.folders, session)).sessionJson, "utf8")) as SessionJson;
      const text = await workspace.show(registration, json.commit, RECORD_PATH);
      const read = text === null ? null : readRecord(text);
      if (read?.ok === true) record = read.record;
    } catch {
      // Falls back to the registration's copy below.
    }
    return trackerRepo(config, registration, record);
  }

  /** The session is over: its workspace goes, and so does its entry. */
  private async finish(entry: SessionEntry, workspace: Workspace): Promise<void> {
    await workspace.dispose({ session: entry.id, worktree: entry.worktree });
    await this.dropEntry(entry.id);
  }

  /**
   * A failed session (spec 1, "Exits"): the session exited without a handoff, the Outbox refused its handoff,
   * `prepare` failed, or it timed out. The first failure restarts the stage once, in place: the issue stays in
   * its working status and the entry waits as `retry_waiting` for a free place. A second failure pauses the
   * issue with the second failure's text (ADRs 0002 and 0019).
   */
  private async fail(now: Date, repo: TrackerRepo, entry: SessionEntry, failure: FailedExit, facts: RunnerFacts, workspace: Workspace): Promise<void> {
    if (entry.attempt < MAX_ATTEMPTS) {
      await workspace.dispose({ session: entry.id, worktree: entry.worktree });
      const waiting: SessionEntry = {
        ...entry,
        attempt: entry.attempt + 1,
        pid: null,
        pid_started_at: null,
        claude_uuid: null,
        started_at: null,
        deadline: null,
        state: "retry_waiting",
      };
      await this.state.writeSessions((await this.state.sessions()).map((each) => (each.id === entry.id ? waiting : each)));
      await this.state.log(now, `${entry.id} ${entry.issue}: failed (${failure.kind}), attempt ${waiting.attempt} waits for a place`);
      return;
    }
    await this.state.log(now, `${entry.id} ${entry.issue}: failed (${failure.kind}) on attempt ${entry.attempt}`);
    await this.runnerPause(now, repo, entry, failedTwice(failure), facts, workspace);
  }

  /**
   * Ends the session and pauses its issue with a runner comment. When the issue no longer sits in the stage's
   * working status, the maintainer moved it, and nothing is posted.
   */
  private async runnerPause(now: Date, repo: TrackerRepo, entry: SessionEntry, text: RunnerText, facts: RunnerFacts, workspace: Workspace): Promise<void> {
    // Linear first: a read that fails leaves the entry, so the exit runs again at the next poll.
    const issue = await this.tracker.issue({ id: entry.issue_id, repo });
    await this.finish(entry, workspace);
    const working = WORKING[entry.stage];
    if (working === undefined || issue.role !== working) {
      await this.state.log(now, `${entry.id} ${entry.issue}: left ${working}, no pause posted`);
      return;
    }
    const comment = runnerComment(text, facts, { version: this.version, statuses: repo.statuses });
    const result = await this.comments(now).post({ ...issue, role: working }, comment);
    await this.state.log(now, `${entry.id} ${entry.issue}: runner pause ${result}: ${comment.statusLine}`);
  }

  private comments(now: Date): RunnerComments {
    return new RunnerComments({ tracker: this.tracker, state: this.state, clock: () => now });
  }

  // Each repo.

  private async pollRepo(now: Date, config: Config, registration: Registration, workspace: Workspace): Promise<RepoPoll> {
    // 1. Fetch.
    const fetch = await workspace.fetch(registration);
    if (!fetch.ok) await this.state.log(now, `${registration.name}: fetch failed: ${fetch.error}`);

    // 2. Check the team. The record on the default branch names it, or else the registration's copy does.
    let record: RecordResult | null = null;
    if (fetch.ok) {
      const text = await workspace.show(registration, fetch.head, RECORD_PATH);
      record = text === null ? null : readRecord(text);
    }
    const repo = trackerRepo(config, registration, record?.ok === true ? record.record : null);

    // 3. Snapshot, with the comments since the repo's cursor. A failed Linear call, such as a network error or a
    // 5xx, in the snapshot or in steps 5 to 7 skips this repo's starts for this poll only. The other repos still
    // poll, and the tick still publishes the heartbeat and `status.json`.
    let snapshot: Snapshot | null = null;
    if (repo !== null) {
      try {
        snapshot = await this.tracker.snapshot(repo, { since: await this.state.cursor(registration.name) });
      } catch (error) {
        await this.state.log(now, `${registration.name}: snapshot failed: ${(error as Error).message}`);
      }
    }
    const blocked = new Set<string>();
    if (repo !== null && snapshot !== null) {
      try {
        // A runner comment Linear didn't take yet goes first, and nothing else happens to its issue this poll.
        for (const issue of await this.pendingComments(now, repo, snapshot)) blocked.add(issue);
        // 5. Answers. FLD-104 adds step 4, moved out.
        const handled = await this.answers(now, repo, snapshot, blocked);
        for (const issue of blocked) handled.add(issue);
        // The cursor moves only once every comment it passes is in issue memory.
        const latest = snapshot.comments.at(-1)?.created_at;
        if (latest !== undefined) await this.state.writeCursor(registration.name, latest);
        // 6. Flags, and 7. Subscriptions.
        await this.flags(now, repo, snapshot, handled);
        await this.subscriptions(repo, snapshot, handled);
      } catch (error) {
        await this.state.log(now, `${registration.name}: runner comments, answers, flags, or subscriptions failed: ${(error as Error).message}`);
        snapshot = null;
      }
    }
    const waitingForSpecs = (snapshot?.issues ?? []).filter((issue) => issue.role === "ready_to_plan" && hasSpec(issue));
    return { registration, tracker: repo, fetch, record, snapshot, waitingForSpecs, blocked };
  }

  /**
   * Tries each runner comment Linear didn't take at an earlier poll again (spec 1, "The runner's own comments"),
   * once a pause has kept this snapshot's replies. Returns every issue that had one, landed or not, so nothing
   * else happens to it this poll.
   */
  private async pendingComments(now: Date, repo: TrackerRepo, snapshot: Snapshot): Promise<string[]> {
    const pending: string[] = [];
    const comments = this.comments(now);
    for (const { uuid, memory } of await this.state.issueMemories(repo.name)) {
      if (memory.pending === null) continue;
      pending.push(uuid);
      // The snapshot's replies go in first, so the read that lands the pause can't replace a body this poll saw.
      await this.keepPendingReplies(repo, snapshot, uuid);
      const result = await comments.retry(repo, uuid, snapshot.issues.find((issue) => issue.id === uuid) ?? null);
      await this.state.log(now, `${memory.pending.issue}: runner comment ${result}`);
    }
    return pending;
  }

  // 5. Answers.

  /**
   * For each issue with an open pause, keeps each comment posted after the pause comment as the first snapshot
   * that returned it saw it. Then it moves each paused issue when the oldest reply that names an answer does,
   * and clears the flag (ADR 0019). Any other reply leaves the issue paused and flagged.
   */
  private async answers(now: Date, repo: TrackerRepo, snapshot: Snapshot, blocked: Set<string>): Promise<Set<string>> {
    // Every open pause's replies go into issue memory before any move, so a move that fails, on this issue or
    // another, still leaves them as first seen.
    const open: { issue: SnapshotIssue; memory: IssueMemory; pause: OpenPause }[] = [];
    for (const issue of snapshot.issues) {
      if ((issue.role !== "paused" && issue.role !== "planning") || blocked.has(issue.id)) continue;
      const memory = await this.state.issueMemory(repo.name, issue.id);
      const pause = memory.pause;
      // A pause in Planning keeps its replies, and takes no answer yet, only while its move to Paused is pending.
      if (pause === null || (issue.role === "planning" && !pause.pending)) continue;
      const fresh = freshReplies(snapshot, issue.id, pause.comment_at, pause.replies);
      const seen: OpenPause = { ...pause, replies: [...pause.replies, ...fresh] };
      if (fresh.length > 0) await this.state.writeIssueMemory(repo.name, issue.id, { ...memory, pause: seen });
      if (issue.role === "paused") open.push({ issue, memory, pause: seen });
    }

    const handled = new Set<string>();
    for (const { issue, memory, pause } of open) {
      const answer = answerOf(pause, repo.maintainer);
      if (answer === null) continue;
      const moved = await this.lifecycle.move(issue, answer.move, "answer");
      if (!moved.ok) {
        await this.state.log(now, `${issue.identifier}: answer ${answer.word} refused: ${moved.violation}`);
        continue;
      }
      await this.tracker.clearFlag(issue);
      await this.state.writeIssueMemory(repo.name, issue.id, { ...memory, flag: null, pause: null });
      await this.state.log(now, `${issue.identifier}: answered ${answer.word}`);
      handled.add(issue.id);
    }
    return handled;
  }

  /**
   * A runner pause whose writes wait keeps each reply as the first snapshot that returned it saw it, though it
   * takes no answer until it lands. Until its post's creation time is known, as after a lost response, every
   * comment since the runner recorded it is kept, and the landing keeps only those after the comment.
   */
  private async keepPendingReplies(repo: TrackerRepo, snapshot: Snapshot, uuid: string): Promise<void> {
    const memory = await this.state.issueMemory(repo.name, uuid);
    const pending = memory.pending;
    if (pending === null || pending.pause === null) return;
    const fresh = freshReplies(snapshot, uuid, pending.comment_at ?? pending.since, pending.replies);
    if (fresh.length > 0) await this.state.writeIssueMemory(repo.name, uuid, { ...memory, pending: { ...pending, replies: [...pending.replies, ...fresh] } });
  }

  // 6. Flags.

  /**
   * The runner owns an in-flight issue's assignee (ADR 0011). A flagged issue back in a factory queue loses
   * its flag. An assignee the runner didn't set goes. An assignee the maintainer cleared by hand, or set to
   * someone else, clears the flag, and the runner doesn't assign again. A flagged or paused issue that leaves flight loses its flag and
   * open pause, and keeps its assignee, because it's the maintainer's again. Adds each issue it clears to `handled`.
   */
  private async flags(now: Date, repo: TrackerRepo, snapshot: Snapshot, handled: Set<string>): Promise<void> {
    const inFlight = new Set(snapshot.issues.filter((issue) => FACTORY_ROLES.includes(issue.role)).map((issue) => issue.id));
    for (const { uuid, memory } of await this.state.issueMemories(repo.name)) {
      if ((memory.flag === null && memory.pause === null) || inFlight.has(uuid) || handled.has(uuid)) continue;
      await this.state.writeIssueMemory(repo.name, uuid, { ...memory, flag: null, pause: null });
      await this.state.log(now, `${memory.flag?.issue ?? uuid}: left flight, flag and pause forgotten`);
    }

    for (const issue of ownedIssues(snapshot)) {
      if (handled.has(issue.id)) continue;
      const memory = await this.state.issueMemory(repo.name, issue.id);
      let next = memory;
      // A pause closes when its issue leaves Paused, unless it waits in Planning for its pending move to Paused.
      const waits = issue.role === "planning" && memory.pause?.pending === true;
      if (memory.pause !== null && issue.role !== "paused" && !waits) next = { ...next, pause: null };
      if (memory.flag === null ? issue.assignee !== null : QUEUE_ROLES.includes(issue.role)) {
        await this.tracker.clearFlag(issue);
        next = { ...next, flag: null };
        handled.add(issue.id);
      } else if (memory.flag !== null && issue.assignee !== repo.maintainer) {
        // An assignee cleared by hand, or set to someone else, clears the flag, and the runner doesn't assign again.
        // It clears an assignee it didn't set, which unsubscribes the maintainer too.
        if (issue.assignee !== null) {
          await this.tracker.clearFlag(issue);
          handled.add(issue.id);
        }
        next = { ...next, flag: null };
      }
      if (next !== memory) await this.state.writeIssueMemory(repo.name, issue.id, next);
    }
  }

  // 7. Subscriptions.

  /** Unsubscribes the maintainer from every unflagged issue in a factory status they're subscribed to (ADR 0011). */
  private async subscriptions(repo: TrackerRepo, snapshot: Snapshot, handled: Set<string>): Promise<void> {
    for (const issue of ownedIssues(snapshot)) {
      if (handled.has(issue.id) || !issue.subscribers.includes(repo.maintainer)) continue;
      if ((await this.state.issueMemory(repo.name, issue.id)).flag !== null) continue;
      await this.tracker.unsubscribe(issue);
    }
  }

  // Starts.

  private async starts(now: Date, config: Config, repos: RepoPoll[], workspace: Workspace): Promise<void> {
    const sessions = await this.state.sessions();
    const busy = new Set(sessions.map((entry) => entry.issue_id));
    let free = config.concurrency_cap - sessions.filter((entry) => entry.state === "starting" || entry.state === "running").length;

    // A retry waiting for a free place starts before any new take.
    for (const entry of sessions.filter((each) => each.state === "retry_waiting")) {
      if (free <= 0) break;
      const poll = repos.find((each) => each.registration.name === entry.repo);
      if (poll === undefined || !poll.fetch.ok || poll.record?.ok !== true || poll.snapshot === null || poll.blocked.has(entry.issue_id)) continue;
      const issue = poll.snapshot.issues.find((each) => each.id === entry.issue_id);
      if (issue === undefined || issue.role !== WORKING[entry.stage]) {
        // The issue left its working status while the retry waited. FLD-104's step 4 handles a move out in full.
        await this.state.log(now, `${entry.id} ${entry.issue}: left ${WORKING[entry.stage]}, retry dropped`);
        await this.dropEntry(entry.id);
        continue;
      }
      free--;
      await this.start(now, config, poll, issue, workspace, entry);
    }

    const candidates: { poll: RepoPoll; issue: SnapshotIssue }[] = [];
    for (const poll of repos) {
      if (!poll.fetch.ok || poll.record?.ok !== true || poll.snapshot === null) continue;
      for (const issue of poll.snapshot.issues) {
        if (issue.role === "ready_to_plan" && !hasSpec(issue) && !busy.has(issue.id) && !poll.blocked.has(issue.id)) candidates.push({ poll, issue });
      }
    }
    candidates.sort((a, b) => priorityRank(a.issue) - priorityRank(b.issue) || a.issue.created_at.localeCompare(b.issue.created_at));
    for (const { poll, issue } of candidates) {
      if (free <= 0) break;
      free--;
      await this.start(now, config, poll, issue, workspace);
    }
  }

  /**
   * Starts a session: a take, or, with `retry`, the fresh session that takes a `retry_waiting` entry's place.
   * A retry restarts in place, so the issue already sits in the working status and no take happens.
   */
  private async start(now: Date, config: Config, poll: RepoPoll, issue: SnapshotIssue, workspace: Workspace, retry?: SessionEntry): Promise<void> {
    if (!poll.fetch.ok || poll.record?.ok !== true || poll.tracker === null) return;
    const registration = poll.registration;
    const record: RepoRecord = poll.record.record;
    const repo = poll.tracker;
    const stage: Stage = "plan";
    const id = await workspace.newSessionId();
    const worktree = paths.worktree(this.folders, id);
    const entry: SessionEntry = {
      id,
      repo: registration.name,
      issue: issue.identifier,
      issue_id: issue.id,
      title: issue.title,
      stage,
      mode: "issue",
      attempt: retry?.attempt ?? 1,
      pid: null,
      pid_started_at: null,
      claude_uuid: null,
      worktree,
      started_at: null,
      deadline: null,
      state: "starting",
    };

    // 1. The entry first, then the take, so the issue never sits in Planning unseen (ADR 0002). A retry's fresh
    // session takes the waiting entry's place.
    if (retry === undefined) await this.state.writeSessions([...(await this.state.sessions()), entry]);
    else await this.state.writeSessions((await this.state.sessions()).map((each) => (each.id === retry.id ? entry : each)));
    // A throw from here until the Harness holds the session, such as a failed Linear read, ends the start: the
    // workspace and the entry go, so a `starting` entry with no session never holds a slot. A retry's entry
    // waits as `retry_waiting` again. A failed prepare or launch is a failed session instead.
    let preparing = false;
    let minted = false;
    let handle: Handle;
    let deadline: string;
    try {
      if (retry === undefined) {
        const taken = await this.lifecycle.move(issue, "planning", "take");
        if (!taken.ok) {
          await this.state.log(now, `${id} ${issue.identifier}: take refused: ${taken.violation}`);
          await this.dropEntry(id);
          return;
        }
      }

      // 2. The record at the commit the session starts from: the default branch's tip at this poll.
      const commit = poll.fetch.head;
      deadline = new Date(now.getTime() + durationMs(record.time_limits.plan)).toISOString();
      const linear = config.linear[repo.workspace];
      const full = await this.tracker.issue(issue);
      const memory = await this.state.issueMemory(registration.name, issue.id);

      // 3. Prepare, then the launch. A failure of either is a failed session.
      preparing = true;
      const prepared = await workspace.prepare({
        session: id,
        stage,
        mode: "issue",
        repo: registration,
        record,
        issue: issue.identifier,
        team: record.tracker.team,
        branch: poll.fetch.branch,
        base: poll.fetch.branch,
        commit,
        deadline,
        attempt: entry.attempt,
        maintainer: { id: repo.maintainer, name: linear?.maintainer_name ?? "" },
        appUser: linear?.app_user_id ?? "",
        version: this.version,
        versionFolder: this.versionFolder,
        inbox: {
          previousBrief: memory.brief,
          syncedComments: full.comments.filter((comment) => comment.synced).map((comment) => comment.id),
        },
      });
      const launch = await buildLaunch({
        folders: this.folders,
        id,
        stage,
        repo: registration.name,
        issue: issue.identifier,
        worktree: prepared.worktree,
        sessionFolder: prepared.sessionFolder,
        record,
        env: prepared.env,
        model: config.models.plan,
        auth: auth(config),
        versionFolder: this.versionFolder,
      });
      preparing = false;

      // 4. The Reader token, then the session. A mint can land without its response, so a failed start revokes
      // from the moment the mint is sent. Revoking a session with no token does nothing.
      minted = true;
      await this.tracker.sessionToken({ id, repo });
      const session: HarnessSession = {
        id,
        stage,
        mode: "issue",
        repo: registration.name,
        issue: issue.identifier,
        worktree: prepared.worktree,
        sessionFolder: prepared.sessionFolder,
        sessionJson: sessionParts(prepared.sessionFolder).sessionJson,
        transcript: paths.transcript(this.folders, registration.name, id),
        deadline,
        model: config.models.plan,
        versionFolder: this.versionFolder,
        launch,
      };
      handle = await this.harness.start(session, {
        exit: (exit) => void this.exits.push({ session: id, exit }),
        // FLD-105 turns each event into the plan-limit hold.
        rateLimit: () => {},
      });
    } catch (error) {
      const message = (error as Error).message;
      if (preparing) {
        await this.state.log(now, `${id} ${issue.identifier}: prepare failed: ${message}`);
        try {
          await this.fail(now, repo, entry, { kind: "prepare", message }, { session: id, attempt: entry.attempt, prepare: message }, workspace);
        } catch (failError) {
          // A second failure's pause reads Linear first, and no exit queues it again, so a read that throws ends
          // the start as any other throw does: the retry waits again with its attempt, and the next poll starts it.
          await this.state.log(now, `${id} ${issue.identifier}: failed start not handled: ${(failError as Error).message}`);
          await this.endStart(now, workspace, id, worktree, null, retry);
        }
      } else {
        await this.state.log(now, `${id} ${issue.identifier}: start failed: ${message}`);
        await this.endStart(now, workspace, id, worktree, minted ? repo : null, retry);
      }
      return;
    }

    // The session runs now, so its exit cleans up after it, even if this write fails.
    const running: SessionEntry = {
      ...entry,
      pid: handle.pid,
      pid_started_at: handle.pidStartedAt,
      claude_uuid: handle.uuid,
      started_at: now.toISOString(),
      deadline,
      state: "running",
    };
    await this.state.writeSessions((await this.state.sessions()).map((each) => (each.id === id ? running : each)));
  }

  /**
   * Undoes a start that failed before the Harness held its session. Each step runs even when one before it fails.
   * A retry's waiting entry takes its place back, with the attempt it had, so the next poll starts it again.
   */
  private async endStart(now: Date, workspace: Workspace, id: string, worktree: string, minted: TrackerRepo | null, retry?: SessionEntry): Promise<void> {
    const steps: [string, () => Promise<void>][] = [
      ["revoke", async () => (minted === null ? undefined : await this.tracker.revoke({ id, repo: minted }))],
      ["dispose", () => workspace.dispose({ session: id, worktree })],
      retry === undefined
        ? ["drop", () => this.dropEntry(id)]
        : ["requeue", async () => this.state.writeSessions((await this.state.sessions()).map((each) => (each.id === id ? retry : each)))],
    ];
    for (const [name, step] of steps) {
      try {
        await step();
      } catch (error) {
        await this.state.log(now, `${id}: ${name} after a failed start failed: ${(error as Error).message}`);
      }
    }
  }

  private async dropEntry(id: string): Promise<void> {
    await this.state.writeSessions((await this.state.sessions()).filter((each) => each.id !== id));
  }

  // Publish.

  /** Each issue the runner flagged, for `status.json`, with the title the snapshot read when there is one. */
  private async flagList(repos: RepoPoll[]): Promise<Status["flags"]> {
    const flags: Status["flags"] = [];
    for (const poll of repos) {
      for (const { uuid, memory } of await this.state.issueMemories(poll.registration.name)) {
        if (memory.flag === null) continue;
        const read = poll.snapshot?.issues.find((issue) => issue.id === uuid);
        const { issue, title, url, status_line, since } = memory.flag;
        flags.push({ repo: poll.registration.name, issue: read?.identifier ?? issue, title: read?.title ?? title, url: read?.url ?? url, status_line, since });
      }
    }
    return flags;
  }

  private async publish(now: Date, config: Config, repos: RepoPoll[]): Promise<void> {
    const at = now.toISOString();
    await this.state.writeHeartbeat(now);
    const sessions = await this.state.sessions();
    const status: Status = {
      version: this.version,
      heartbeat_at: at,
      polled_at: at,
      runner: { state: "working", holds: [] },
      sessions: sessions.map((entry) => ({
        id: entry.id,
        repo: entry.repo,
        issue: entry.issue,
        title: entry.title,
        stage: entry.stage,
        state: entry.state,
        started_at: entry.started_at,
        deadline: entry.deadline,
      })),
      jobs: [],
      usage:
        config.auth === "api_key"
          ? {
              auth: "api_key",
              day_usd: 0,
              month_usd: 0,
              daily_cap_usd: config.api?.daily_cap_usd ?? 0,
              monthly_cap_usd: config.api?.monthly_cap_usd ?? 0,
            }
          : { auth: "subscription", five_hour: null, weekly: null },
      flags: await this.flagList(repos),
      trouble: [],
      stale_takes: [],
      repos: repos.map(statusRepo),
    };
    await this.state.publish(status);
  }
}

/**
 * The in-flight issues whose assignee and subscribers the runner owns: every issue in a factory status, except
 * the sent issues spec 1 leaves in Ready to plan for spec 4, which stay the maintainer's (ADRs 0004 and 0011).
 */
function ownedIssues(snapshot: Snapshot): SnapshotIssue[] {
  return snapshot.issues.filter((issue) => FACTORY_ROLES.includes(issue.role) && !(issue.role === "ready_to_plan" && hasSpec(issue)));
}

/** The snapshot's comments on the issue after `after` that `known` doesn't hold yet, as replies. */
function freshReplies(snapshot: Snapshot, uuid: string, after: string, known: readonly Reply[]): Reply[] {
  const ids = new Set(known.map((reply) => reply.id));
  return snapshot.comments
    .filter((comment) => comment.issue === uuid && comment.created_at > after && !ids.has(comment.id))
    .map(({ id, author, created_at, body, synced }) => ({ id, author, created_at, body, synced }));
}

/** The repo as the Tracker needs it: the record's `[tracker]` when it's valid, or else the registration's copy. */
function trackerRepo(config: Config, registration: Registration, record: RepoRecord | null): TrackerRepo | null {
  const tracker = record?.tracker ?? registration.tracker;
  const linear = config.linear[tracker.workspace];
  // FLD-98's trouble causes open `linear_login` for a workspace `login linear` hasn't signed in.
  if (linear === undefined) return null;
  return { name: registration.name, workspace: tracker.workspace, team: tracker.team, statuses: tracker.statuses, maintainer: linear.maintainer_id };
}

/** How sessions pay, from `config.toml` (ADR 0005). Install always writes `[api]` on an API key. */
function auth(config: Config): Auth {
  if (config.auth === "subscription") return { kind: "subscription" };
  if (config.api === undefined) throw new Error("config.toml has auth = \"api_key\" and no [api] table");
  return { kind: "api_key", sessionBudgetUsd: config.api.session_budget_usd };
}

/** Spec 1 takes only standalone issues: one with a parent or sub-issues waits for spec 4 (ADR 0004). */
function hasSpec(issue: SnapshotIssue): boolean {
  return issue.parent !== null || issue.children > 0;
}

/** Urgent first, and no priority after Low. */
function priorityRank(issue: SnapshotIssue): number {
  return issue.priority === 0 ? 5 : issue.priority;
}

function statusRepo(poll: RepoPoll): StatusRepo {
  const record = poll.record === null ? "waiting" : poll.record.ok ? "ok" : poll.record.reason === "newer" ? "newer" : "invalid";
  return {
    name: poll.registration.name,
    record,
    // FLD-99 adds the dependency cache.
    cache: "missing",
    waiting_for_specs: poll.waitingForSpecs.map((issue) => ({ issue: issue.identifier, title: issue.title })),
    waiting_for_blockers: [],
    waiting_for_port: null,
  };
}
