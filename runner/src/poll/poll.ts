// Poll, the runner's core (overview, spec 1's "Poll"). `tick(now)` handles every queued exit, then polls each
// registered repo, then starts sessions and publishes `status.json`. Everything it does shows through the
// Tracker and Harness ports and the state file, so scenarios test it there.
//
// Each kind of exit has its handler in `exits/`, and each comment the runner writes on its own has its text in
// `../outbox/runner-comments/`. Step 4, moved out, is in `moved-out.ts`, trouble causes in `trouble/`, step 8 in
// `stale-takes.ts`, and every hold, the trouble ones too, comes through `holds.ts`. Later tickets add usage and
// the start order.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Folders } from "../folders/index.ts";
import { paths, sessionParts } from "../folders/index.ts";
import { buildLaunch, type Auth, type Exit, type ExitKind, type Harness, type HarnessSession, type Launch } from "../harness/index.ts";
import { hasWorkspace, othersCanRead, readConfig, readCredentials, writeEtc, type Config, type Credentials, type Registration } from "../install/index.ts";
import { Lifecycle } from "../lifecycle/index.ts";
import { Outbox } from "../outbox/index.ts";
import { blockerPause } from "../outbox/runner-comments/blocker.ts";
import { failedTwice, type FailedExit } from "../outbox/runner-comments/failed-twice.ts";
import { stopPause } from "../outbox/runner-comments/stop.ts";
import { RunnerComments, runnerComment, type RunnerFacts, type RunnerText } from "../outbox/runner-comments/index.ts";
import { invalidRecord, newerRecord, noRecord } from "../outbox/runner-comments/record.ts";
import { durationMs, readRecord, resolveSlots, RUNNER_SCHEMA, type RecordResult, type RepoRecord } from "../record/index.ts";
import { State, type OpenPause, type Reply, type SessionEntry, type Stage, type Status, type StatusRepo, type StopCause } from "../state/index.ts";
import { FACTORY_ROLES, QUEUE_ROLES, type BlockerIssue, type Snapshot, type SnapshotIssue, type Tracker, type TrackerRepo } from "../tracker/index.ts";
import { Workspace, type FetchResult } from "../workspace/index.ts";
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
import { notify } from "./trouble/notify.ts";
import { Trials, type TrialEvents, type TrialResult } from "./trial.ts";
import { LoginWatch } from "./login.ts";
import { Usage } from "./usage.ts";

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
  /** The issues with a runner comment that hadn't landed at the start of this poll. Nothing else happens to them. */
  blocked: Set<string>;
  /** Step 8's stale takes, for `status.json`. */
  staleTakes: Status["stale_takes"];
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
  private readonly path: string;
  private readonly lifecycle: Lifecycle;
  private readonly state: State;
  private readonly applyWaiting: ApplyWaiting;
  private readonly usage: Usage;
  /** Exits queue as they happen, and the next tick handles them first. */
  private readonly exits: QueuedExit[] = [];
  /** The `[machine_user]` that `etc/` was last written from, or `null` before this runner's first write. */
  private etcFor: string | null = null;
  /** Whether this runner's first tick ran, which does what the runner does at its start. */
  private started = false;
  /** `tick`, `hold`, `start`, and `stop` run one at a time, in the order they're called. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly trials: Trials;
  /** Claude Code's login: `claude_login` after an expired login, and `claude_login_soon` after its warning. */
  private readonly login = new LoginWatch();

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
      fail: (now, repo, entry, failure, facts, workspace) => this.fail(now, repo, entry, failure, facts, workspace),
    });
    this.trials = new Trials({
      folders: options.folders,
      state: this.state,
      harness: options.harness,
      version: options.version,
      versionFolder: options.versionFolder,
      events: (id) => ({
        exit: (exit) => void this.exits.push({ session: id, exit }),
        rateLimit: (event) => this.usage.report(event),
        loginExpiring: (warning) => this.login.expiring(id, warning),
      }),
    });
  }

  /**
   * Asks for a trial run (spec 1, "Trial run"), as `{ "op": "trial" }` does. It starts at the next poll that a
   * hold and the cap allow, and the promise resolves once it ends, or at once under a hold a trial doesn't run under.
   */
  trial(events: TrialEvents = {}): Promise<TrialResult> {
    return this.trials.request(events);
  }

  /** Posts a macOS notification the way trouble does, such as install's "Flight Deck can notify you." */
  notify(text: string): Promise<{ ok: true } | { ok: false; error: string }> {
    return notify(text, { path: this.path });
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

  /** `flight-deck start`: ends the `maintainer` and `stop` holds, by removing the hold marker (ADR 0021). */
  start(now: Date): Promise<void> {
    return this.serial(async () => {
      if ((await this.state.holdMarker()) === null) return;
      await this.state.writeHoldMarker(null);
      await this.state.log(now, "hold ended by flight-deck start");
    });
  }

  /**
   * `flight-deck stop` (spec 1's "Holds", ADRs 0005, 0007, and 0021). It writes the hold marker naming `stop`,
   * replacing a hold's, and asks the Harness to stop every running session, whose `stopped` exit pauses its
   * issue at the next tick. It pauses the issue of each `retry_waiting` entry now, with the same ⚪ text. An
   * `apply_waiting` entry keeps retrying, because a held runner still applies outboxes. Last, it revokes the
   * runner's Linear token in each workspace it serves.
   */
  stop(now: Date): Promise<void> {
    return this.serial(async () => {
      await this.state.writeHoldMarker({ by: "stop", since: now.toISOString() });
      await this.state.log(now, "stopped by flight-deck stop");
      const config = await readConfig(this.folders);
      const workspace = new Workspace({ folders: this.folders, git: config.paths.git });
      for (const entry of await this.state.sessions()) {
        if (entry.state === "running") await this.stopSession(now, entry, "stop");
        if (entry.state === "retry_waiting") await this.pauseStopped(now, config, entry, { session: entry.id, attempt: entry.attempt }, workspace);
      }
      for (const name of new Set(config.repos.map((registration) => repoOf(config, registration.name)?.workspace))) {
        if (name !== undefined) await this.tracker.revokeRunnerToken(name);
      }
    });
  }

  /**
   * Asks the Harness to stop a running session, once, and records why in its entry, for its `stopped` exit.
   * The exit comes later, and the next tick handles it.
   */
  private async stopSession(now: Date, entry: SessionEntry, cause: StopCause): Promise<void> {
    if (entry.stop_cause !== undefined) return;
    if (entry.pid === null || entry.pid_started_at === null) {
      await this.state.log(now, `${entry.id} ${entry.issue}: no process to stop`);
      return;
    }
    await this.state.writeSessions((await this.state.sessions()).map((each) => (each.id === entry.id ? { ...each, stop_cause: cause } : each)));
    await this.state.log(now, `${entry.id} ${entry.issue}: stopping (${cause})`);
    await this.harness.stop({ session: entry.id, uuid: entry.claude_uuid ?? "", pid: entry.pid, pidStartedAt: entry.pid_started_at });
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
    if (!this.started) {
      this.started = true;
      await this.atStart(now, config, workspace);
    }
    const trouble = await Trouble.load(this.state);
    this.login.poll(trouble);
    await this.handleExits(now, config, workspace, trouble);
    // Outboxes Linear didn't take, each on its backoff, with no session.
    await this.applyWaiting.retry(now, this.outbox(now, config), (name) => repoNamed(config, name), workspace);
    const credentials = await this.checkCredentials(trouble);
    checkSharedTeams(config, trouble);

    const repos: RepoPoll[] = [];
    for (const registration of config.repos) repos.push(await this.pollRepo(now, config, credentials, registration, workspace, trouble));
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
   * What the runner does at its start, before its first poll. Under a `stop` marker, written by a `flight-deck
   * stop` the runner didn't answer, it treats each session in its list as stopped, not failed: it pauses the
   * issue with the ⚪ stop text and uses no retry (spec 1, "The runner's socket"). An `apply_waiting` entry
   * keeps retrying, as after a `stop` the runner answered.
   */
  private async atStart(now: Date, config: Config, workspace: Workspace): Promise<void> {
    await this.trials.atStart(now, workspace);
    if ((await this.state.holdMarker())?.by !== "stop") return;
    // FLD-108 kills any live session first, with its process groups, because its output pipe died with the old runner.
    for (const entry of await this.state.sessions()) {
      if (entry.state === "apply_waiting") continue;
      const facts: RunnerFacts = { session: entry.id, attempt: entry.attempt };
      if (entry.started_at !== null) facts.transcript = paths.transcript(this.folders, entry.repo, entry.id);
      await this.pauseStopped(now, config, entry, facts, workspace);
    }
  }

  /** Ends an entry that has no session to wait for, and pauses its issue with the ⚪ stop text. */
  private async pauseStopped(now: Date, config: Config, entry: SessionEntry, facts: RunnerFacts, workspace: Workspace): Promise<void> {
    const repo = repoOf(config, entry.repo);
    if (repo === null) {
      await this.state.log(now, `${entry.id} ${entry.issue}: stopped, and ${entry.repo} has no Linear sign-in`);
      return this.finish(entry, workspace);
    }
    await this.runnerPause(now, repo, entry, stopPause(), facts, workspace);
  }

  // Exits.

  private async handleExits(now: Date, config: Config, workspace: Workspace, trouble: Trouble): Promise<void> {
    const queued = this.exits.splice(0);
    if (queued.length === 0) return;
    const outbox = this.outbox(now, config);
    for (const { session, exit } of queued) {
      const entry = (await this.state.sessions()).find((each) => each.id === session);
      if (entry === undefined) continue;
      this.login.exited(now, entry, exit, trouble);
      // A trial has no repo, no issue, and no Reader token.
      if (entry.stage === "trial") {
        // Its cost counts toward the caps, and a plan limit holds the runner as after any session.
        await this.usage.spent(now, config, exit);
        if (exit.kind === "rate_limited") await this.usage.rateLimited(now, config, exit.resetsAt);
        await this.trials.exited({ now, entry, exit, workspace, trouble });
        continue;
      }
      const registration = config.repos.find((repo) => repo.name === entry.repo);
      const repo = registration === undefined ? null : trackerRepo(config, registration, null);
      if (repo === null) {
        await this.state.log(now, `${entry.id} ${entry.issue}: exit ${exit.kind}, and ${entry.repo} has no Linear sign-in`);
        await this.finish(entry, workspace);
        continue;
      }
      await this.tracker.revoke({ id: entry.id, repo });
      await this.usage.spent(now, config, exit);

      const sessionFolder = paths.sessionFolder(this.folders, entry.id);
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
  }

  private outbox(now: Date, config: Config): Outbox {
    return new Outbox({ version: this.version, state: this.state, clock: () => now, repo: (name) => repoNamed(config, name) });
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
    await this.finish(entry, workspace);
    const issue = await stillWorking(this.tracker, repo, entry);
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

  private async pollRepo(
    now: Date,
    config: Config,
    credentials: Credentials | null,
    registration: Registration,
    workspace: Workspace,
    trouble: Trouble,
  ): Promise<RepoPoll> {
    // 1. Fetch.
    const fetch = await workspace.fetch(registration);
    if (!fetch.ok) await this.state.log(now, `${registration.name}: fetch failed: ${fetch.error}`);

    // 2. Check the team. The record on the default branch names it, or else the registration's copy does.
    // State keeps the last valid record, for the stale-take limits.
    let record: RecordResult | null = null;
    if (fetch.ok) {
      record = await this.recordAt(workspace, registration, fetch.head);
      if (record?.ok === true && (await this.state.lastRecord(registration.name))?.commit !== fetch.head) {
        await this.state.writeLastRecord(registration.name, { commit: fetch.head, read_at: now.toISOString(), record: record.record });
      }
    }
    const repo = await this.checkTeam(config, credentials, registration, record?.ok === true ? record.record : null, trouble);

    // 3. Snapshot, with the comments since the repo's cursor.
    const snapshot = repo === null || !repo.usable ? null : await this.tracker.snapshot(repo.repo, { since: await this.state.cursor(registration.name) });
    const blocked = new Set<string>();
    let stale: Status["stale_takes"] = [];
    if (repo !== null && snapshot !== null) {
      const tracker = repo.repo;
      // A runner comment Linear didn't take yet goes first, and nothing else happens to its issue this poll.
      for (const issue of await this.pendingComments(now, tracker, snapshot)) blocked.add(issue);
      // 4. Moved out, with the kept outboxes of issues that left Paused.
      await movedOut({
        now,
        repo: tracker,
        snapshot,
        state: this.state,
        stop: (entry) => this.stopSession(now, entry, "moved_out"),
        discard: (entry) => this.applyWaiting.movedOut(now, entry, workspace),
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
    const workspace = (record?.tracker ?? registration.tracker).workspace;
    const repo = trackerRepo(config, registration, record);
    if (repo === null || !hasWorkspace(credentials, workspace)) {
      trouble.open("linear_login", name, { scope: "repo", repos: [name], facts: { repo: name, workspace } });
      return null;
    }
    trouble.clear("linear_login", name);
    if (trouble.isOpen("shared_team", `${registration.tracker.workspace}/${registration.tracker.team}`)) return { repo, usable: false };

    const team = await this.tracker.checkTeam(repo);
    if (!team.ok && team.reason === "unreadable") {
      trouble.open("team_unreadable", name, { scope: "repo", repos: [name], facts: { repo: name, team: repo.team } });
      return { repo, usable: false };
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
      inRepo: async (path) => (await workspace.show(registration, commit, `${path}/SKILL.md`)) !== null,
    });
  }

  /**
   * Tries each runner comment Linear didn't take at an earlier poll again (spec 1, "The runner's own comments").
   * Returns every issue that had one, landed or not, so nothing else happens to it this poll.
   */
  private async pendingComments(now: Date, repo: TrackerRepo, snapshot: Snapshot): Promise<string[]> {
    const pending: string[] = [];
    const comments = this.comments(now);
    for (const { uuid, memory } of await this.state.issueMemories(repo.name)) {
      if (memory.pending === null) continue;
      pending.push(uuid);
      const result = await comments.retry(repo, uuid, snapshot.issues.find((issue) => issue.id === uuid) ?? null);
      await this.state.log(now, `${memory.pending.issue}: runner comment ${result}`);
    }
    return pending;
  }

  // 5. Answers.

  /**
   * For each paused issue with an open pause, keeps each comment posted after the pause comment as the first
   * snapshot that returned it saw it, then moves the issue when the oldest reply that names an answer does,
   * and clears the flag (ADR 0019). Any other reply leaves the issue paused and flagged.
   */
  private async answers(now: Date, repo: TrackerRepo, snapshot: Snapshot, blocked: Set<string>): Promise<Set<string>> {
    const handled = new Set<string>();
    for (const issue of snapshot.issues) {
      if (issue.role !== "paused" || blocked.has(issue.id)) continue;
      const memory = await this.state.issueMemory(repo.name, issue.id);
      const pause = memory.pause;
      if (pause === null) continue;
      const known = new Set(pause.replies.map((reply) => reply.id));
      const fresh: Reply[] = snapshot.comments
        .filter((comment) => comment.issue === issue.id && comment.created_at > pause.comment_at && !known.has(comment.id))
        .map(({ id, author, created_at, body, synced }) => ({ id, author, created_at, body, synced }));
      const open: OpenPause = { ...pause, replies: [...pause.replies, ...fresh] };
      const answer = answerOf(open, repo.maintainer);
      if (answer === null) {
        if (fresh.length > 0) await this.state.writeIssueMemory(repo.name, issue.id, { ...memory, pause: open });
        continue;
      }
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

  // 6. Flags.

  /**
   * The runner owns an in-flight issue's assignee (ADR 0011). A flagged issue back in a factory queue loses
   * its flag. An assignee the runner didn't set goes. An assignee the maintainer cleared by hand clears the
   * flag, and the runner doesn't assign again. A flagged or paused issue that leaves flight loses its flag and
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
      // A pause closes when its issue leaves Paused.
      if (memory.pause !== null && issue.role !== "paused") next = { ...next, pause: null };
      if (memory.flag === null ? issue.assignee !== null : QUEUE_ROLES.includes(issue.role)) {
        await this.tracker.clearFlag(issue);
        next = { ...next, flag: null };
        handled.add(issue.id);
      } else if (memory.flag !== null && issue.assignee === null) {
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
    let running = sessions.filter((entry) => entry.state === "starting" || entry.state === "running").length;
    // An entry whose apply waits after the move has handed off, so its issue can be taken again.
    const busy = new Set(sessions.filter((entry) => entry.apply?.phase !== "after_move").map((entry) => entry.issue_id));
    for (const poll of repos) await this.blockers(now, poll, busy);
    let free = config.concurrency_cap - running;
    /** Whether one more session may start: a free place under the cap, and on an API key, room under each cap. */
    const room = async () => free > 0 && (await this.usage.fits(now, config, running));
    // The cap test runs before the holds are read, so a cap that fits again ends its `api_cap` hold, and one that
    // doesn't holds the runner from this poll.
    await this.usage.fits(now, config, running);

    // Before each start, Claude Code's version (ADR 0015).
    const work = this.trials.wanted(now, trouble) || sessions.some((entry) => entry.state === "retry_waiting") || repos.some((poll) => poll.snapshot?.issues.some((issue) => issue.role === "ready_to_plan"));
    if (trouble.isOpen("claude_code_version", "runner") || (free > 0 && work)) {
      const version = await this.harness.version();
      if (tooOld(version)) trouble.open("claude_code_version", "runner", { scope: "runner", repos: [], facts: { version, minVersion: MIN_VERSION } });
      else trouble.clear("claude_code_version", "runner", { version });
    }
    // A held runner starts nothing, and a hold on a workspace or a repo stops only its own starts (ADR 0021). The
    // holds include each trouble cause open this poll, the version's too.
    const holds = await currentHolds(this.holdContext(now, config, trouble));
    const startable = repos.filter((poll) => poll.tracker !== null && !holdsRepo(holds, poll.tracker));

    // A trial takes the first free place, before any retry or take, and runs under most holds. On an API key it
    // needs room under each cap too.
    if (await this.trials.start({ now, config, auth: auth(config), holds, free: (await room()) ? free : 0, workspace, trouble })) {
      free--;
      running++;
    }

    // A retry waiting for a free place starts before any new take.
    for (const entry of sessions.filter((each) => each.state === "retry_waiting")) {
      if (!(await room())) break;
      const poll = startable.find((each) => each.registration.name === entry.repo);
      if (poll === undefined || !poll.fetch.ok || poll.snapshot === null || poll.blocked.has(entry.issue_id)) continue;
      const issue = poll.snapshot.issues.find((each) => each.id === entry.issue_id);
      // Step 4 dropped the retry of an issue that left its working status.
      if (issue === undefined || issue.role !== WORKING[entry.stage]) continue;
      free--;
      running++;
      await this.startSession(now, config, poll, issue, workspace, entry);
    }

    const candidates: { poll: RepoPoll; issue: SnapshotIssue }[] = [];
    for (const poll of startable) {
      if (!poll.fetch.ok || poll.snapshot === null) continue;
      for (const issue of poll.snapshot.issues) {
        if (issue.role !== "ready_to_plan" || hasSpec(issue) || busy.has(issue.id) || poll.blocked.has(issue.id) || blockerTest(issue).kind !== "take") continue;
        // A kept outbox is applied instead of a session, and takes no place under the cap.
        if (poll.tracker !== null && (await this.applyWaiting.applyKept(now, this.outbox(now, config), poll.tracker, issue, workspace))) continue;
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
      running++;
      await this.startSession(now, config, poll, issue, workspace);
    }
  }

  /**
   * The blocker test, on each sent issue spec 1 can take, before the order and even with no free place (ADR 0002).
   * A canceled blocker, or a duplicate of nothing, pauses the issue from Ready to plan with no session and no
   * retry used. An open blocker leaves it waiting with nothing posted, under `waiting_for_blockers`.
   */
  private async blockers(now: Date, poll: RepoPoll, busy: Set<string>): Promise<void> {
    if (poll.tracker === null || poll.snapshot === null) return;
    for (const issue of poll.snapshot.issues) {
      if (issue.role !== "ready_to_plan" || hasSpec(issue) || busy.has(issue.id) || poll.blocked.has(issue.id)) continue;
      const test = blockerTest(issue);
      if (test.kind === "wait") poll.waitingForBlockers.push({ issue, open: test.open });
      if (test.kind !== "pause") continue;
      const comment = runnerComment(blockerPause(test), {}, { version: this.version, statuses: poll.tracker.statuses });
      const result = await this.comments(now).post(issue, comment);
      await this.state.log(now, `${issue.identifier}: blocker pause ${result}: ${comment.statusLine}`);
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
    };

    if (retry === undefined) {
      // 1. The entry first, then the take, so the issue never sits in Planning unseen (ADR 0002).
      await this.state.writeSessions([...(await this.state.sessions()), entry]);
      const taken = await this.lifecycle.move(issue, "planning", "take");
      if (!taken.ok) {
        await this.state.log(now, `${id} ${issue.identifier}: take refused: ${taken.violation}`);
        await this.dropEntry(id);
        return;
      }
      if (memory.restart !== null) await this.state.writeIssueMemory(registration.name, issue.id, { ...memory, restart: null });
    } else {
      await this.state.writeSessions((await this.state.sessions()).map((each) => (each.id === retry.id ? entry : each)));
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
    const deadline = new Date(now.getTime() + durationMs(record.time_limits.plan)).toISOString();
    const linear = config.linear[repo.workspace];
    const full = await this.tracker.issue(issue);

    // 3. Prepare, then the launch. A failure of either is a failed session.
    let prepared;
    let launch: Launch;
    try {
      prepared = await workspace.prepare({
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
      launch = await buildLaunch({
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
    } catch (error) {
      const message = (error as Error).message;
      await this.state.log(now, `${id} ${issue.identifier}: prepare failed: ${message}`);
      await this.fail(now, repo, entry, { kind: "prepare", message }, { session: id, attempt: entry.attempt, prepare: message }, workspace);
      return;
    }

    // 4. The Reader token, then the session.
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
    const handle = await this.harness.start(session, {
      exit: (exit) => void this.exits.push({ session: id, exit }),
      rateLimit: (event) => this.usage.report(event),
      loginExpiring: (warning) => this.login.expiring(id, warning),
    });
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

/** A registered repo by name, with the registration's `[tracker]`, or `null`. */
function repoNamed(config: Config, name: string): TrackerRepo | null {
  const registration = config.repos.find((repo) => repo.name === name);
  return registration === undefined ? null : trackerRepo(config, registration, null);
}

/** The repo as the Tracker needs it: the record's `[tracker]` when it's valid, or else the registration's copy. */
function trackerRepo(config: Config, registration: Registration, record: RepoRecord | null): TrackerRepo | null {
  const tracker = record?.tracker ?? registration.tracker;
  const linear = config.linear[tracker.workspace];
  // Step 2 opens `linear_login` for a workspace `login linear` hasn't signed in.
  if (linear === undefined) return null;
  return { name: registration.name, workspace: tracker.workspace, team: tracker.team, statuses: tracker.statuses, maintainer: linear.maintainer_id };
}

/** Two registrations that name the same team open `shared_team` for both, and both skip their poll (ADR 0006). */
function checkSharedTeams(config: Config, trouble: Trouble): void {
  const byTeam = new Map<string, string[]>();
  for (const registration of config.repos) {
    const team = `${registration.tracker.workspace}/${registration.tracker.team}`;
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

/** The registered repo by name, as the Tracker needs it from the registration's copy of `[tracker]`. */
function repoOf(config: Config, name: string): TrackerRepo | null {
  const registration = config.repos.find((repo) => repo.name === name);
  return registration === undefined ? null : trackerRepo(config, registration, null);
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
