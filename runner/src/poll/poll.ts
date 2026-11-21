// Poll, the runner's core (overview, spec 1's "Poll"). `tick(now)` handles every queued exit, then polls each
// registered repo, then starts sessions and publishes `status.json`. Everything it does shows through the
// Tracker and Harness ports and the state file, so scenarios test it there.
//
// Each kind of exit has its handler in `exits/`, and each comment the runner writes on its own has its text in
// `../outbox/runner-comments/`. Step 4, moved out, is in `moved-out.ts`, trouble causes in `trouble/`, step 8 in
// `stale-takes.ts`, and every hold, the trouble ones too, comes through `holds.ts`. Later tickets add usage and
// the start order.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Folders } from "../folders/index.ts";
import { paths, sessionParts } from "../folders/index.ts";
import { buildLaunch, type Auth, type Exit, type ExitKind, type Handle, type Harness, type HarnessSession } from "../harness/index.ts";
import { hasWorkspace, othersCanRead, readConfig, readCredentials, writeEtc, type Config, type Credentials, type Registration } from "../install/index.ts";
import { Lifecycle } from "../lifecycle/index.ts";
import { Outbox } from "../outbox/index.ts";
import { blockerPause } from "../outbox/runner-comments/blocker.ts";
import { failedTwice, type FailedExit } from "../outbox/runner-comments/failed-twice.ts";
import { stopPause } from "../outbox/runner-comments/stop.ts";
import { RunnerComments, runnerComment, type RunnerFacts, type RunnerText } from "../outbox/runner-comments/index.ts";
import { invalidRecord, newerRecord, noRecord } from "../outbox/runner-comments/record.ts";
import { durationMs, readRecord, resolveSlots, RUNNER_SCHEMA, type RecordResult, type RepoRecord } from "../record/index.ts";
import { State, type IssueMemory, type OpenPause, type Reply, type SessionEntry, type Stage, type Status, type StatusRepo, type StopCause } from "../state/index.ts";
import { FACTORY_ROLES, QUEUE_ROLES, type BlockerIssue, type Snapshot, type SnapshotIssue, type Tracker, type TrackerRepo } from "../tracker/index.ts";
import { Workspace, type FetchResult, type SessionJson } from "../workspace/index.ts";
import { answerOf } from "./answers.ts";
import { ApplyWaiting } from "./apply-waiting.ts";
import { blockerTest } from "./blockers.ts";
import { EXITS, type ExitContext } from "./exits/index.ts";
import { movedOut, stillWorking } from "./moved-out.ts";
import { currentHolds, holdsRepo, runnerState, type HoldContext } from "./holds.ts";
import { MAX_ATTEMPTS, WORKING } from "./stages.ts";
import { staleTakes } from "./stale-takes.ts";
import { Trouble } from "./trouble/trouble.ts";
import { MIN_VERSION, tooOld } from "./trouble/version.ts";
import { launchAuth, Usage } from "./usage.ts";

export interface PollOptions {
  folders: Folders;
  /** The running version. */
  version: string;
  /** The running version's folder, never `current` (ADR 0015). */
  versionFolder: string;
  /** The Tracker adapter, as the Flight Deck app. */
  tracker: Tracker;
  harness: Harness;
  /** The runner's `PATH`, for the commands it runs itself, such as `osascript`. The process's own by default. */
  path?: string;
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
  /** The sent issues the blocker test left waiting at this poll, each with its blockers that aren't done. */
  waitingForBlockers: { issue: SnapshotIssue; open: BlockerIssue[] }[];
  /**
   * The issues with a runner comment that hadn't landed at the start of this poll. Nothing else happens to them,
   * except that a runner pause keeps its replies.
   */
  blocked: Set<string>;
  /** Step 8's stale takes, for `status.json`. */
  staleTakes: Status["stale_takes"];
}

/** A repo's step 1: its fetch, and the record on its default branch. */
interface Fetched {
  registration: Registration;
  fetch: FetchResult;
  /** The record on the default branch, or `null` when the branch holds none. */
  record: RecordResult | null;
}

interface QueuedExit {
  session: string;
  exit: Exit;
  /** Set once the exit's cost counted, so a handler that threw and runs again doesn't count it twice. */
  counted?: true;
}

export class Poll {
  private readonly folders: Folders;
  private readonly version: string;
  private readonly versionFolder: string;
  private readonly tracker: Tracker;
  private readonly harness: Harness;
  private readonly path: string;
  private readonly lifecycle: Lifecycle;
  private readonly state: State;
  private readonly applyWaiting: ApplyWaiting;
  private readonly usage: Usage;
  /** Exits queue as they happen, and the next tick handles them first. */
  private readonly exits: QueuedExit[] = [];
  /** The `[machine_user]` that `etc/` was last written from, or `null` before this runner's first write. */
  private etcFor: string | null = null;
  /** Whether what the runner does at its start finished, at its first tick or a later one. */
  private started = false;
  /** Each running session's repo with the statuses its take read, by session ID, read once per runner. */
  private readonly takeRepos = new Map<string, TrackerRepo>();
  /**
   * The repo each kept outbox's take read, by entry. The default branch's record can change while the replay
   * waits, and its retries and step 4 keep the statuses the take moved the issue with. A restart falls back to the
   * last valid record.
   */
  private readonly keptTakes = new Map<string, TrackerRepo>();
  /** The sessions whose stop this runner asked the Harness for, by session ID. A failed request isn't here. */
  private readonly stopsSent = new Set<string>();
  /** `tick`, `hold`, `start`, and `stop` run one at a time, in the order they're called. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: PollOptions) {
    this.folders = options.folders;
    this.version = options.version;
    this.versionFolder = options.versionFolder;
    this.tracker = options.tracker;
    this.harness = options.harness;
    this.path = options.path ?? process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin";
    this.lifecycle = new Lifecycle(options.tracker);
    this.state = new State(options.folders);
    this.usage = new Usage(this.state);
    this.applyWaiting = new ApplyWaiting({
      folders: options.folders,
      version: options.version,
      tracker: options.tracker,
      state: this.state,
      outbox: (now, repo) => new Outbox({ version: this.version, state: this.state, clock: () => now, repo: (name) => (name === repo.name ? repo : null) }),
      fail: (now, repo, entry, failure, facts, workspace) => this.fail(now, repo, entry, failure, facts, workspace),
    });
  }

  /** Runs one poll for every registered repo. */
  tick(now: Date): Promise<void> {
    return this.serial(() => this.poll(now));
  }

  /**
   * `flight-deck hold`: running sessions finish, and no new one starts until `start` (ADR 0021). It writes the
   * hold marker, and leaves a `stop`'s marker as it is.
   */
  hold(now: Date): Promise<void> {
    return this.serial(async () => {
      const marker = await this.state.holdMarker();
      if (marker !== null) return;
      await this.state.writeHoldMarker({ by: "hold", since: now.toISOString() });
      await this.state.log(now, "held by flight-deck hold");
    });
  }

  /**
   * `flight-deck start`: ends the `maintainer` and `stop` holds, by removing the hold marker (ADR 0021). A runner
   * that started under a `stop` marker first finishes what it does at its start, so no entry the stop left
   * outlives the marker without its pause. Until that finishes, `start` throws and the marker stays.
   */
  start(now: Date): Promise<void> {
    return this.serial(async () => {
      if ((await this.state.holdMarker()) === null) return;
      const config = await readConfig(this.folders);
      const workspace = new Workspace({ folders: this.folders, git: config.paths.git });
      await this.ensureStarted(now, config, workspace);
      const stopped = (await this.state.holdMarker())?.by === "stop";
      if (!this.started || (stopped && !(await this.stopEach(now, config, workspace)))) {
        throw new Error("a stopped session's issue isn't paused yet, so the stop stays: try again after the next poll");
      }
      await this.state.writeHoldMarker(null);
      await this.state.log(now, "hold ended by flight-deck start");
    });
  }

  /**
   * `flight-deck stop` (spec 1's "Holds", ADRs 0005, 0007, and 0021). It writes the hold marker naming `stop`,
   * replacing a hold's, and asks the Harness to stop every running session, whose `stopped` exit pauses its
   * issue at the next tick. It pauses the issue of each `retry_waiting` entry now, with the same ⚪ text. An
   * `apply_waiting` entry keeps retrying, because a held runner still applies outboxes. Last, it revokes the
   * runner's Linear token in each workspace it serves. Each tick under the marker retries an entry this missed.
   */
  stop(now: Date): Promise<void> {
    return this.serial(async () => {
      await this.state.writeHoldMarker({ by: "stop", since: now.toISOString() });
      await this.state.log(now, "stopped by flight-deck stop");
      const config = await readConfig(this.folders);
      const workspace = new Workspace({ folders: this.folders, git: config.paths.git });
      // Before the runner's start finishes, its start pauses every entry under the marker.
      if (this.started) await this.stopEach(now, config, workspace);
      await this.revokeRunnerTokens(now, config);
    });
  }

  /**
   * Revokes the runner's own token in every workspace `login linear` signed in to. Any of them may hold one,
   * because a session's take, a registration's copy of `[tracker]`, or any record since can name it. Each revoke
   * runs even when one before it fails, and then the first failure throws.
   */
  private async revokeRunnerTokens(now: Date, config: Config): Promise<void> {
    let failed: unknown = null;
    for (const name of Object.keys(config.linear)) {
      try {
        await this.tracker.revokeRunnerToken(name);
      } catch (error) {
        await this.state.log(now, `runner token for ${name} not revoked: ${(error as Error).message}`);
        failed ??= error;
      }
    }
    if (failed !== null) throw failed;
  }

  /**
   * Under a `stop` marker, asks the Harness to stop each running session and pauses each `retry_waiting` issue.
   * Each entry goes on its own: one that throws, such as on a failed Linear read, stays as it was, and the next
   * tick under the marker tries it again.
   */
  private async stopEach(now: Date, config: Config, workspace: Workspace): Promise<boolean> {
    let finished = true;
    for (const entry of await this.state.sessions()) {
      try {
        if (entry.state === "running") await this.stopSession(now, entry, "stop");
        if (entry.state === "retry_waiting") await this.pauseStopped(now, config, entry, { session: entry.id, attempt: entry.attempt }, workspace);
      } catch (error) {
        await this.state.log(now, `${entry.id} ${entry.issue}: stop failed, retrying next poll: ${(error as Error).message}`);
        finished = false;
      }
    }
    return finished;
  }

  /**
   * Asks the Harness to stop a running session, and records why in its entry, for its `stopped` exit. The first
   * cause stays. The request goes once, and a request that failed goes again at the next call. The exit comes
   * later, and the next tick handles it.
   */
  private async stopSession(now: Date, entry: SessionEntry, cause: StopCause): Promise<void> {
    if (this.stopsSent.has(entry.id)) return;
    if (entry.pid === null || entry.pid_started_at === null) {
      await this.state.log(now, `${entry.id} ${entry.issue}: no process to stop`);
      return;
    }
    if (entry.stop_cause === undefined) {
      await this.state.writeSessions((await this.state.sessions()).map((each) => (each.id === entry.id ? { ...each, stop_cause: cause } : each)));
    }
    await this.state.log(now, `${entry.id} ${entry.issue}: stopping (${entry.stop_cause ?? cause})`);
    await this.harness.stop({ session: entry.id, uuid: entry.claude_uuid ?? "", pid: entry.pid, pidStartedAt: entry.pid_started_at });
    this.stopsSent.add(entry.id);
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => {});
    return run;
  }

  private async poll(now: Date): Promise<void> {
    const config = await readConfig(this.folders);
    await this.writeEtc(config);
    const workspace = new Workspace({ folders: this.folders, git: config.paths.git });
    await this.ensureStarted(now, config, workspace);
    await this.handleExits(now, config, workspace);
    if (this.started && (await this.state.holdMarker())?.by === "stop") await this.stopEach(now, config, workspace);
    // Outboxes Linear didn't take, each on its backoff, with no session.
    await this.applyWaiting.retry(now, (entry) => this.entryRepo(config, entry, workspace), workspace);
    const trouble = await Trouble.load(this.state);
    const credentials = await this.checkCredentials(trouble);

    // Every repo's fetch comes first, so the shared-team check reads the team each repo's poll uses.
    const fetched: Fetched[] = [];
    for (const registration of config.repos) fetched.push(await this.fetchRepo(now, registration, workspace));
    checkSharedTeams(fetched, trouble);

    const repos: RepoPoll[] = [];
    for (const each of fetched) repos.push(await this.pollRepo(now, config, credentials, each, workspace, trouble));
    checkGithubToken(repos, trouble);

    await this.starts(now, config, repos, workspace, trouble);
    // 10. Trouble.
    const reachable = new Map(repos.flatMap((poll) => (poll.tracker === null ? [] : [[poll.registration.name, poll.tracker] as const])));
    await trouble.settle({ now, tracker: this.tracker, state: this.state, version: this.version, path: this.path, repos: reachable });
    // 11. Usage.
    await this.usage.update(now, config);
    await this.publish(now, config, repos, trouble);
  }

  /**
   * `credentials.env` that anyone but the maintainer can read holds every session, and the runner stays up, so
   * launchd doesn't restart it in a loop. A missing file isn't this cause: each repo gets `linear_login` (ADR 0005).
   */
  private async checkCredentials(trouble: Trouble): Promise<Credentials | null> {
    const credentials = await readCredentials(this.folders);
    if (credentials !== null && othersCanRead(credentials)) {
      trouble.open("credentials", "runner", { scope: "runner", repos: [], facts: { mode: `0${credentials.mode.toString(8)}` } });
    } else {
      trouble.clear("credentials", "runner");
    }
    return credentials;
  }

  /** `etc/` at each start, and again whenever `[machine_user]` changes (spec 1, "Folders and files"). */
  private async writeEtc(config: Config): Promise<void> {
    const machineUser = JSON.stringify(config.machine_user ?? null);
    if (machineUser === this.etcFor) return;
    await writeEtc(this.folders, config.machine_user);
    this.etcFor = machineUser;
  }

  // The runner's start.

  /**
   * Runs what the runner does at its start, until it finishes. An entry whose pause a Linear error cut short gets
   * its pause at a later tick, and the rest of each tick still runs.
   */
  private async ensureStarted(now: Date, config: Config, workspace: Workspace): Promise<void> {
    if (!this.started) this.started = await this.atStart(now, config, workspace);
  }

  /**
   * What the runner does at its start, before its first poll. Under a `stop` marker, written by a `flight-deck
   * stop` the runner didn't answer, it treats each session in its list as stopped, not failed: it pauses the
   * issue with the ⚪ stop text and uses no retry (spec 1, "The runner's socket"). An `apply_waiting` entry
   * keeps retrying, as after a `stop` the runner answered. Each entry goes on its own, and it returns whether
   * every entry finished.
   */
  private async atStart(now: Date, config: Config, workspace: Workspace): Promise<boolean> {
    if ((await this.state.holdMarker())?.by !== "stop") return true;
    let finished = true;
    // FLD-108 kills any live session first, with its process groups, because its output pipe died with the old runner.
    for (const entry of await this.state.sessions()) {
      if (entry.state === "apply_waiting") continue;
      const facts: RunnerFacts = { session: entry.id, attempt: entry.attempt };
      if (entry.started_at !== null) facts.transcript = paths.transcript(this.folders, entry.repo, entry.id);
      try {
        await this.pauseStopped(now, config, entry, facts, workspace);
      } catch (error) {
        await this.state.log(now, `${entry.id} ${entry.issue}: stop pause failed, retrying next poll: ${(error as Error).message}`);
        finished = false;
      }
    }
    return finished;
  }

  /** Ends an entry that has no session to wait for, and pauses its issue with the ⚪ stop text. */
  private async pauseStopped(now: Date, config: Config, entry: SessionEntry, facts: RunnerFacts, workspace: Workspace): Promise<void> {
    const repo = await this.entryRepo(config, entry, workspace);
    if (repo === null) {
      await this.state.log(now, `${entry.id} ${entry.issue}: stopped, and ${entry.repo} isn't registered or has no Linear sign-in`);
      return this.finish(entry, workspace);
    }
    await this.runnerPause(now, repo, entry, stopPause(), facts, workspace);
  }

  /**
   * The repo as the entry's issue reads it: with the record its take read, as an exit uses. A `retry_waiting`
   * entry's session folder went with its workspace, so it uses the last valid record Poll read, which its retry
   * would start from. Either falls back to the registration's copy.
   *
   * An entry in the kept folder is one of two. A kept outbox's own take read the repo `keptTakes` holds. The
   * session whose outbox was just kept, waiting on its Linear-write pause, keeps its first take's record, which
   * the kept folder's `session.json` still names.
   */
  private async entryRepo(config: Config, entry: SessionEntry, workspace: Workspace): Promise<TrackerRepo | null> {
    const registration = config.repos.find((repo) => repo.name === entry.repo);
    if (registration === undefined) return null;
    const kept = this.appliesKept(entry);
    const taken = kept ? this.keptTakes.get(entry.id) : undefined;
    if (taken !== undefined) return taken;
    // A retry's take comes later, so it reads the last valid record. So does a kept outbox's take after a restart.
    if (entry.state === "retry_waiting" || (kept && entry.apply?.phase !== "pause")) {
      return trackerRepo(config, registration, (await this.state.lastRecord(registration.name))?.record ?? null);
    }
    // Step 4 asks at each poll, and a session's take never changes, so it reads the take's record once.
    const cached = this.takeRepos.get(entry.id);
    if (cached !== undefined) return cached;
    const folder = entry.apply?.folder ?? paths.sessionFolder(this.folders, entry.id);
    const repo = await this.sessionRepo(config, registration, folder, workspace);
    if (repo !== null) this.takeRepos.set(entry.id, repo);
    return repo;
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

  private async handleExit(now: Date, config: Config, workspace: Workspace, queued: QueuedExit): Promise<void> {
    const { session, exit } = queued;
    const sessions = await this.state.sessions();
    const entry = sessions.find((each) => each.id === session);
    if (entry === undefined) return;
    // Spending and a plan limit's hold need only the exit and the launch, so they land before the repo lookup and
    // the token revoke, even when the repo is gone. The hold only extends, so a retried exit can set it again.
    if (queued.counted !== true) await this.usage.spent(now, exit, entry.budget_usd);
    queued.counted = true;
    if (exit.kind === "rate_limited") await this.usage.rateLimited(now, launchAuth(entry), exit.resetsAt);
    const registration = config.repos.find((repo) => repo.name === entry.repo);
    const repo = registration === undefined ? null : await this.sessionRepo(config, registration, paths.sessionFolder(this.folders, entry.id), workspace);
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
    const { transcript, claudeCodeVersion: _, error, costUsd: __, ...kind } = exit;
    const facts: RunnerFacts = { exit: kind as ExitKind, session: entry.id, attempt: entry.attempt, transcript };
    if (error !== undefined) facts.error = error;
    const context: ExitContext = {
      now,
      entry,
      exit,
      config,
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
   * `folder` is the session folder, or the kept folder, which holds a copy of `session.json`. A folder or commit
   * that can't be read falls back to the registration's copy.
   */
  private async sessionRepo(config: Config, registration: Registration, folder: string, workspace: Workspace): Promise<TrackerRepo | null> {
    let record: RepoRecord | null = null;
    try {
      const json = JSON.parse(await readFile(sessionParts(folder).sessionJson, "utf8")) as SessionJson;
      const text = await workspace.show(registration, json.commit, RECORD_PATH);
      const read = text === null ? null : readRecord(text);
      if (read?.ok === true) record = read.record;
    } catch {
      // Falls back to the registration's copy below.
    }
    return trackerRepo(config, registration, record);
  }

  /** Whether the entry applies a kept outbox, whose folder isn't its session folder. */
  private appliesKept(entry: SessionEntry): boolean {
    return entry.apply !== undefined && entry.apply.folder !== paths.sessionFolder(this.folders, entry.id);
  }

  /** The session is over: its workspace goes, and so does its entry. */
  private async finish(entry: SessionEntry, workspace: Workspace): Promise<void> {
    this.takeRepos.delete(entry.id);
    this.stopsSent.delete(entry.id);
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
    // A session that failed before `flight-deck stop` reached it pauses as stopped, and uses no retry.
    if (entry.stop_cause === "stop") return this.runnerPause(now, repo, entry, stopPause(), facts, workspace);
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
      // The entry moves to the end of the list, so retries start in the order they began waiting.
      await this.state.writeSessions([...(await this.state.sessions()).filter((each) => each.id !== entry.id), waiting]);
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
    // Linear first: a read that fails leaves the entry, so the exit runs again at the next poll. A deleted,
    // archived, or moved issue counts as moved out too.
    const issue = await stillWorking(this.tracker, repo, entry);
    await this.finish(entry, workspace);
    if (issue === null || issue.role === null) {
      await this.state.log(now, `${entry.id} ${entry.issue}: left ${WORKING[entry.stage]}, no pause posted`);
      return;
    }
    const comment = runnerComment(text, facts, { version: this.version, statuses: repo.statuses });
    const result = await this.comments(now).post({ ...issue, role: issue.role }, comment);
    await this.state.log(now, `${entry.id} ${entry.issue}: runner pause ${result}: ${comment.statusLine}`);
  }

  private comments(now: Date): RunnerComments {
    return new RunnerComments({ tracker: this.tracker, state: this.state, clock: () => now });
  }

  // Each repo.

  /**
   * 1. Fetch, and the record on the default branch. State keeps the last valid record and the time of its latest
   * read, for the stale-take limits.
   */
  private async fetchRepo(now: Date, registration: Registration, workspace: Workspace): Promise<Fetched> {
    const fetch = await workspace.fetch(registration);
    if (!fetch.ok) await this.state.log(now, `${registration.name}: fetch failed: ${fetch.error}`);
    let record: RecordResult | null = null;
    if (fetch.ok) {
      record = await this.recordAt(workspace, registration, fetch.head);
      if (record?.ok === true) {
        await this.state.writeLastRecord(registration.name, { commit: fetch.head, read_at: now.toISOString(), record: record.record });
      }
    }
    return { registration, fetch, record };
  }

  private async pollRepo(
    now: Date,
    config: Config,
    credentials: Credentials | null,
    { registration, fetch, record }: Fetched,
    workspace: Workspace,
    trouble: Trouble,
  ): Promise<RepoPoll> {
    // 2. Check the team. The record on the default branch names it, or else the registration's copy does.
    // A failed Linear call, such as a network error or a 5xx, in the team query, the snapshot, or steps 5 to 8
    // skips this repo's starts for this poll only. The other repos still poll, and the tick still publishes the
    // heartbeat and `status.json`.
    let repo: { repo: TrackerRepo; usable: boolean } | null = null;
    try {
      repo = await this.checkTeam(config, credentials, registration, record?.ok === true ? record.record : null, trouble);
    } catch (error) {
      await this.state.log(now, `${registration.name}: team check failed: ${(error as Error).message}`);
    }

    // 3. Snapshot, with the comments since the repo's cursor.
    let snapshot: Snapshot | null = null;
    if (repo !== null && repo.usable) {
      try {
        snapshot = await this.tracker.snapshot(repo.repo, { since: await this.state.cursor(registration.name) });
      } catch (error) {
        await this.state.log(now, `${registration.name}: snapshot failed: ${(error as Error).message}`);
      }
    }
    const blocked = new Set<string>();
    let stale: Status["stale_takes"] = [];
    if (repo !== null && snapshot !== null) {
      const tracker = repo.repo;
      try {
        // A runner comment Linear didn't take yet goes first, and nothing else happens to its issue this poll.
        for (const issue of await this.pendingComments(now, tracker, snapshot)) blocked.add(issue);
        // 4. Moved out, with the kept outboxes of issues that left Paused.
        await movedOut({
          now,
          repo: tracker,
          snapshot,
          state: this.state,
          tracker: this.tracker,
          takeRepo: async (entry) => (await this.entryRepo(config, entry, workspace)) ?? tracker,
          stop: (entry) => this.stopSession(now, entry, "moved_out"),
          discard: (entry, role) => this.applyWaiting.movedOut(now, entry, role, workspace),
        });
        await this.applyWaiting.forget(now, tracker, snapshot);
        // 5. Answers.
        const handled = await this.answers(now, tracker, snapshot, blocked);
        for (const issue of blocked) handled.add(issue);
        // The cursor moves only once every comment it passes is in issue memory.
        const latest = snapshot.comments.at(-1)?.created_at;
        if (latest !== undefined) await this.state.writeCursor(registration.name, latest);
        // 6. Flags, and 7. Subscriptions.
        await this.flags(now, tracker, snapshot, handled);
        await this.subscriptions(tracker, snapshot, handled);
        await this.forgetRestarts(tracker, snapshot);
        // 8. Stale takes.
        stale = await staleTakes({
          now,
          repo: tracker,
          snapshot,
          blocked,
          record: record?.ok === true ? record.record : ((await this.state.lastRecord(registration.name))?.record ?? null),
          sessions: await this.state.sessions(),
          state: this.state,
          comments: this.comments(now),
          version: this.version,
        });
      } catch (error) {
        await this.state.log(now, `${registration.name}: runner comments, moved out, kept outboxes, answers, flags, subscriptions, or stale takes failed: ${(error as Error).message}`);
        snapshot = null;
      }
    }
    const waitingForSpecs = (snapshot?.issues ?? []).filter((issue) => issue.role === "ready_to_plan" && hasSpec(issue));
    return { registration, tracker: repo?.repo ?? null, fetch, record, snapshot, waitingForSpecs, waitingForBlockers: [], blocked, staleTakes: stale };
  }

  /**
   * Step 2's checks, before any other Linear call for the repo: a Linear login for its workspace, a team no other
   * registration names, and the team query (ADRs 0005 and 0006). Each failure opens its trouble cause and skips
   * the rest of the repo's poll. Returns the repo for the Tracker, and whether the poll goes on.
   */
  private async checkTeam(
    config: Config,
    credentials: Credentials | null,
    registration: Registration,
    record: RepoRecord | null,
    trouble: Trouble,
  ): Promise<{ repo: TrackerRepo; usable: boolean } | null> {
    const name = registration.name;
    const tracker = record?.tracker ?? registration.tracker;
    const workspace = tracker.workspace;
    const repo = trackerRepo(config, registration, record);
    if (repo === null || !hasWorkspace(credentials, workspace)) {
      trouble.open("linear_login", name, { scope: "repo", repos: [name], facts: { repo: name, workspace } });
      return null;
    }
    trouble.clear("linear_login", name);
    if (trouble.isOpen("shared_team", `${tracker.workspace}/${tracker.team}`)) return { repo, usable: false };

    const team = await this.tracker.checkTeam(repo);
    if (!team.ok && team.reason === "unreadable") {
      trouble.open("team_unreadable", name, { scope: "repo", repos: [name], facts: { repo: name, team: repo.team } });
      // No repo for step 10 either: Linear can report an issue the app can't read as one it doesn't have, and
      // step 10 would forget a trouble issue that's still open.
      return null;
    }
    trouble.clear("team_unreadable", name);
    if (!team.ok) {
      const missing = team.roles.map((role) => ({ role, name: repo.statuses[role] }));
      trouble.open("missing_status", name, { scope: "repo", repos: [name], facts: { repo: name, team: repo.team, missing } });
      if (!team.roles.includes("intake")) trouble.canFile(name);
      return { repo, usable: false };
    }
    trouble.clear("missing_status", name);
    trouble.canFile(name);
    return { repo, usable: true };
  }

  /**
   * The record at a commit, with every slot entry resolved: a name against the running version's `skills/`,
   * and a `.claude/skills/` path against the commit (ADR 0014). `null` when the commit holds no record.
   */
  private async recordAt(workspace: Workspace, registration: Registration, commit: string): Promise<RecordResult | null> {
    const text = await workspace.show(registration, commit, RECORD_PATH);
    if (text === null) return null;
    const read = readRecord(text);
    if (!read.ok) return read;
    return resolveSlots(read.record, {
      commit,
      shipped: (name) => existsSync(join(this.versionFolder, "skills", name, "SKILL.md")),
      inRepo: (path) => workspace.isFile(registration, commit, `${path}/SKILL.md`),
    });
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
      // A trouble issue sits outside flight by design. Step 10 keeps its flag.
      if (memory.flag?.cause === "trouble") continue;
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

  /**
   * The attempt resets to 1 whenever the issue leaves the working status, except when the runner requeues it
   * (spec 1, "Exits"). So a requeued issue keeps its attempt only while it waits in its queue for the next take.
   */
  private async forgetRestarts(repo: TrackerRepo, snapshot: Snapshot): Promise<void> {
    for (const { uuid, memory } of await this.state.issueMemories(repo.name)) {
      if (memory.restart === null) continue;
      if (snapshot.issues.find((issue) => issue.id === uuid)?.role === "ready_to_plan") continue;
      await this.state.writeIssueMemory(repo.name, uuid, { ...memory, restart: null });
    }
  }

  // Starts.

  private async starts(now: Date, config: Config, repos: RepoPoll[], workspace: Workspace, trouble: Trouble): Promise<void> {
    const sessions = await this.state.sessions();
    // Each running session's budget, the one its launch carried, or 0 for one on a subscription (spec 1, "Holds").
    // A session whose exit waits for its handler to run again reserves 0 too, because its cost already counted.
    const counted = new Set(this.exits.filter((queued) => queued.counted === true).map((queued) => queued.session));
    const running = sessions
      .filter((entry) => entry.state === "starting" || entry.state === "running")
      .map((entry) => (counted.has(entry.id) ? 0 : (entry.budget_usd ?? 0)));
    // An entry whose apply waits after the move has handed off, so its issue can be taken again.
    const busy = new Set(sessions.filter((entry) => entry.apply?.phase !== "after_move").map((entry) => entry.issue_id));
    for (const poll of repos) await this.blockers(now, poll, busy);
    /** The budget each start this poll launches with. */
    const budget = config.auth === "api_key" ? (config.api?.session_budget_usd ?? 0) : 0;
    let free = config.concurrency_cap - running.length;
    /** Whether one more session may start: a free place under the cap, and on an API key, room under each cap. */
    const room = async () => free > 0 && (await this.usage.fits(now, config, running));
    // The cap test runs before the holds are read, so a cap that fits again ends its `api_cap` hold, and one that
    // doesn't holds the runner from this poll.
    await this.usage.fits(now, config, running);
    await this.keptOutboxes(now, config, repos, workspace, trouble, busy);

    // Before each start, Claude Code's version (ADR 0015).
    const work = sessions.some((entry) => entry.state === "retry_waiting") || repos.some((poll) => poll.snapshot?.issues.some((issue) => issue.role === "ready_to_plan"));
    if (trouble.isOpen("claude_code_version", "runner") || (free > 0 && work)) {
      let version: string;
      try {
        version = await this.harness.version();
      } catch (error) {
        // Nothing starts this poll, and the tick still settles trouble and publishes its status.
        await this.state.log(now, `Claude Code version check failed, no session starts this poll: ${(error as Error).message}`);
        return;
      }
      if (tooOld(version)) trouble.open("claude_code_version", "runner", { scope: "runner", repos: [], facts: { version, minVersion: MIN_VERSION } });
      else trouble.clear("claude_code_version", "runner", { version });
    }
    // A held runner starts nothing, and a hold on a workspace or a repo stops only its own starts (ADR 0021). The
    // holds include each trouble cause open this poll, the version's too.
    const holds = await currentHolds(this.holdContext(now, config, trouble));
    const startable = repos.filter((poll) => poll.tracker !== null && !holdsRepo(holds, poll.tracker));

    // A retry waiting for a free place starts before any new take.
    for (const entry of sessions.filter((each) => each.state === "retry_waiting")) {
      if (!(await room())) break;
      const poll = startable.find((each) => each.registration.name === entry.repo);
      if (poll === undefined || !poll.fetch.ok || poll.snapshot === null || poll.blocked.has(entry.issue_id)) continue;
      const issue = poll.snapshot.issues.find((each) => each.id === entry.issue_id);
      // Step 4 dropped the retry of an issue that left its working status.
      if (issue === undefined || issue.role !== WORKING[entry.stage]) continue;
      free--;
      running.push(budget);
      await this.startSession(now, config, poll, issue, workspace, entry);
    }

    const candidates: { poll: RepoPoll; issue: SnapshotIssue }[] = [];
    for (const poll of startable) {
      if (!poll.fetch.ok || poll.snapshot === null) continue;
      for (const issue of poll.snapshot.issues) {
        if (!takeable(poll, issue, busy)) continue;
        candidates.push({ poll, issue });
      }
    }
    // Priority, then how many issues each one unblocks, then age, across every repo (ADR 0002).
    candidates.sort(
      (a, b) => priorityRank(a.issue) - priorityRank(b.issue) || b.issue.unblocks - a.issue.unblocks || a.issue.created_at.localeCompare(b.issue.created_at),
    );
    for (const { poll, issue } of candidates) {
      if (!(await room())) break;
      free--;
      running.push(budget);
      await this.startSession(now, config, poll, issue, workspace);
    }
  }

  /**
   * The takes that apply a kept outbox instead of starting a session. They take no place under the cap and need
   * no Claude Code, so they come before the version check, and a hold on Claude Code's version doesn't stop them.
   * Every other hold does. Each issue it takes, or whose take throws, joins `busy`, so no session starts for it
   * this poll, and a throw skips only its own issue.
   */
  private async keptOutboxes(now: Date, config: Config, repos: RepoPoll[], workspace: Workspace, trouble: Trouble, busy: Set<string>): Promise<void> {
    const holds = (await currentHolds(this.holdContext(now, config, trouble))).filter((hold) => hold.cause !== "claude_code_version");
    for (const poll of repos) {
      if (poll.tracker === null || holdsRepo(holds, poll.tracker) || !poll.fetch.ok || poll.snapshot === null) continue;
      for (const issue of poll.snapshot.issues) {
        if (!takeable(poll, issue, busy)) continue;
        try {
          if (await this.applyWaiting.applyKept(now, poll.tracker, issue, workspace)) busy.add(issue.id);
        } catch (error) {
          busy.add(issue.id);
          await this.state.log(now, `${issue.identifier}: kept outbox not applied, retrying next poll: ${(error as Error).message}`);
        }
        // An entry that waits after the take keeps the take's statuses.
        if (!busy.has(issue.id)) continue;
        for (const entry of await this.state.sessions()) {
          if (entry.issue_id === issue.id && this.appliesKept(entry)) this.keptTakes.set(entry.id, poll.tracker);
        }
      }
    }
  }

  /**
   * The blocker test, on each sent issue spec 1 can take, before the order and even with no free place (ADR 0002).
   * A canceled blocker, or a duplicate of nothing, pauses the issue from Ready to plan with no session and no
   * retry used. An open blocker leaves it waiting with nothing posted, under `waiting_for_blockers`. A pause that
   * throws skips only its own issue, which the order leaves out anyway: the tick still starts sessions, settles
   * trouble, and publishes, and any comment the pause left pending retries at the next poll.
   */
  private async blockers(now: Date, poll: RepoPoll, busy: Set<string>): Promise<void> {
    if (poll.tracker === null || poll.snapshot === null) return;
    for (const issue of poll.snapshot.issues) {
      if (issue.role !== "ready_to_plan" || hasSpec(issue) || busy.has(issue.id) || poll.blocked.has(issue.id)) continue;
      const test = blockerTest(issue);
      if (test.kind === "wait") poll.waitingForBlockers.push({ issue, open: test.open });
      if (test.kind !== "pause") continue;
      const comment = runnerComment(blockerPause(test), {}, { version: this.version, statuses: poll.tracker.statuses });
      try {
        const result = await this.comments(now).post(issue, comment);
        await this.state.log(now, `${issue.identifier}: blocker pause ${result}: ${comment.statusLine}`);
      } catch (error) {
        await this.state.log(now, `${issue.identifier}: blocker pause failed: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Starts a session: a take, or, with `retry`, the fresh session that takes a `retry_waiting` entry's place.
   * A retry restarts in place, so the issue already sits in the working status and no take happens.
   */
  private async startSession(now: Date, config: Config, poll: RepoPoll, issue: SnapshotIssue, workspace: Workspace, retry?: SessionEntry): Promise<void> {
    if (!poll.fetch.ok || poll.tracker === null) return;
    const registration = poll.registration;
    const repo = poll.tracker;
    const stage: Stage = "plan";
    const id = await workspace.newSessionId();
    const worktree = paths.worktree(this.folders, id);
    const memory = await this.state.issueMemory(registration.name, issue.id);
    const entry: SessionEntry = {
      id,
      repo: registration.name,
      issue: issue.identifier,
      issue_id: issue.id,
      title: issue.title,
      stage,
      mode: "issue",
      // A retry has its attempt. A take after a requeue keeps the attempt the requeue recorded (ADR 0002).
      attempt: retry?.attempt ?? memory.restart?.attempt ?? 1,
      pid: null,
      pid_started_at: null,
      claude_uuid: null,
      worktree,
      started_at: null,
      deadline: null,
      state: "starting",
      // The budget `buildLaunch` passes as `--max-budget-usd`, from the same `config.toml`, so the cap test and the
      // spending count keep it after the maintainer changes `session_budget_usd` or `auth`.
      ...(config.auth === "api_key" && config.api !== undefined ? { budget_usd: config.api.session_budget_usd } : {}),
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
        if (memory.restart !== null) await this.state.writeIssueMemory(registration.name, issue.id, { ...memory, restart: null });
      }

      // 2. The record at the commit the session starts from: the default branch's tip at this poll. A retry reads
      // it again at its own commit. A missing, invalid, or too-new record pauses the issue and uses no retry.
      const commit = poll.fetch.head;
      const read = await this.recordAt(workspace, registration, commit);
      if (read?.ok !== true) {
        await this.runnerPause(now, repo, entry, recordPause(read, poll.fetch.branch, this.version), {}, workspace);
        return;
      }
      const record: RepoRecord = read.record;
      deadline = new Date(now.getTime() + durationMs(record.time_limits.plan)).toISOString();
      const linear = config.linear[repo.workspace];
      const full = await this.tracker.issue(issue);

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
        rateLimit: (event) => this.usage.report(event),
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

  private holdContext(now: Date, config: Config, trouble: Trouble): HoldContext {
    return { now, state: this.state, config, trouble };
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

  private async publish(now: Date, config: Config, repos: RepoPoll[], trouble: Trouble): Promise<void> {
    const at = now.toISOString();
    await this.state.writeHeartbeat(now);
    const sessions = await this.state.sessions();
    const holds = await currentHolds(this.holdContext(now, config, trouble));
    const status: Status = {
      version: this.version,
      heartbeat_at: at,
      polled_at: at,
      runner: { state: runnerState(holds), holds },
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
      usage: await this.usage.status(now, config),
      flags: await this.flagList(repos),
      trouble: trouble.status(),
      stale_takes: repos.flatMap((poll) => poll.staleTakes),
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

/** Whether a take may start the issue: a sent issue in Ready to plan, not busy or blocked, whose blockers allow it. */
function takeable(poll: RepoPoll, issue: SnapshotIssue, busy: Set<string>): boolean {
  return issue.role === "ready_to_plan" && !hasSpec(issue) && !busy.has(issue.id) && !poll.blocked.has(issue.id) && blockerTest(issue).kind === "take";
}

/** The repo as the Tracker needs it: the record's `[tracker]` when it's valid, or else the registration's copy. */
function trackerRepo(config: Config, registration: Registration, record: RepoRecord | null): TrackerRepo | null {
  const tracker = record?.tracker ?? registration.tracker;
  const linear = config.linear[tracker.workspace];
  // Step 2 opens `linear_login` for a workspace `login linear` hasn't signed in.
  if (linear === undefined) return null;
  return { name: registration.name, workspace: tracker.workspace, team: tracker.team, statuses: tracker.statuses, maintainer: linear.maintainer_id };
}

/**
 * Two repos that use the same team open `shared_team` for both, and both skip their poll (ADR 0006). A repo
 * uses the team its default branch's valid record names, or else its registration's copy.
 */
function checkSharedTeams(fetched: Fetched[], trouble: Trouble): void {
  const byTeam = new Map<string, string[]>();
  for (const { registration, record } of fetched) {
    const tracker = record?.ok === true ? record.record.tracker : registration.tracker;
    const team = `${tracker.workspace}/${tracker.team}`;
    byTeam.set(team, [...(byTeam.get(team) ?? []), registration.name]);
  }
  for (const [team, names] of byTeam) {
    if (names.length < 2) continue;
    trouble.open("shared_team", team, { scope: "repo", repos: names, facts: { workspace: team.split("/")[0]!, team: team.split("/")[1]! } });
  }
  trouble.clearOthers("shared_team");
}

/**
 * A fetch that fails to authenticate opens `github_token`, which holds every session, and a fetch that
 * authenticates clears it (ADR 0005). On a public repo a fetch needs no login, so spec 1 can't tell there.
 */
function checkGithubToken(repos: RepoPoll[], trouble: Trouble): void {
  const failed = repos.find((poll) => !poll.fetch.ok && poll.fetch.auth);
  if (failed !== undefined && !failed.fetch.ok) {
    trouble.open("github_token", "runner", { scope: "runner", repos: [], facts: { repo: failed.registration.name, error: failed.fetch.error } });
  } else if (repos.some((poll) => poll.fetch.ok)) {
    trouble.clear("github_token", "runner");
  }
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

/** The pause for a record a session can't start from: missing, newer than the runner, or invalid. */
function recordPause(read: Exclude<RecordResult, { ok: true }> | null, branch: string, version: string): RunnerText {
  if (read === null) return noRecord(branch);
  if (read.reason === "newer") return newerRecord(branch, read.schema, RUNNER_SCHEMA, version);
  return invalidRecord(branch, read.errors);
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
    waiting_for_blockers: poll.waitingForBlockers.map(({ issue, open }) => ({
      issue: issue.identifier,
      title: issue.title,
      blockers: open.map((blocker) =>
        blocker.readable ? { issue: blocker.identifier, title: blocker.title, status: blocker.status } : { issue: blocker.identifier, title: null, status: null },
      ),
    })),
    waiting_for_port: null,
  };
}
