// Poll, the runner's core (overview, spec 1's "Poll"). `tick(now)` handles every queued exit, then polls each
// registered repo, then starts sessions and publishes `status.json`. Everything it does shows through the
// Tracker and Harness ports and the state file, so scenarios test it there.
//
// This is the tracer bullet's poll: fetch, snapshot, and starts. Later tickets add the team check, moved-out
// issues, answers, flags, subscriptions, stale takes, trouble, usage, holds, retries, and the start order.
import { basename } from "node:path";
import type { Folders } from "../folders/index.ts";
import { paths, sessionParts } from "../folders/index.ts";
import { buildLaunch, type Auth, type Exit, type Harness, type HarnessSession, type Launch } from "../harness/index.ts";
import { readConfig, writeEtc, type Config, type Registration } from "../install/index.ts";
import { Lifecycle } from "../lifecycle/index.ts";
import { Outbox } from "../outbox/index.ts";
import { durationMs, readRecord, type RecordResult, type RepoRecord, type Role } from "../record/index.ts";
import { State, type OpenPause, type Reply, type SessionEntry, type Stage, type Status, type StatusRepo } from "../state/index.ts";
import { FACTORY_ROLES, QUEUE_ROLES, type Snapshot, type SnapshotIssue, type Tracker, type TrackerRepo } from "../tracker/index.ts";
import { Workspace, type FetchResult, type RefreshJob } from "../workspace/index.ts";
import { answerOf } from "./answers.ts";

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

/** The working status each stage takes its issue to. */
const WORKING: Partial<Record<Stage, Role>> = { plan: "planning" };

const RECORD_PATH = ".flight-deck/record.toml";

const HOUR = 60 * 60_000;

/** A cache refresh the runner started, and whether it has ended. */
interface RunningRefresh {
  job: RefreshJob;
  ended: boolean;
}

/** What one tick learned about one repo. */
interface RepoPoll {
  registration: Registration;
  tracker: TrackerRepo | null;
  fetch: FetchResult;
  /** The record on the default branch, or `null` when the branch holds none. */
  record: RecordResult | null;
  snapshot: Snapshot | null;
  waitingForSpecs: SnapshotIssue[];
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
  /** Each repo's cache refresh, by repo, from its start until a tick handles its end. */
  private readonly refreshes = new Map<string, RunningRefresh>();
  /** Whether this runner has polled yet, for the sweep at a start. */
  private polled = false;

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
    await this.endRefreshes(now);
    await this.sweep(now, workspace);
    await this.state.rotateLog();

    const repos: RepoPoll[] = [];
    for (const registration of config.repos) repos.push(await this.pollRepo(now, config, registration, workspace));

    await this.starts(now, config, repos, workspace);
    await this.publish(now, config, repos, workspace);
  }

  /**
   * Resolves once every cache refresh that's running has ended. The runner's shutdown waits on it after it
   * kills them, and a scenario uses it to let a refresh land before its next tick.
   */
  async refreshesEnded(): Promise<void> {
    await Promise.all([...this.refreshes.values()].map((refresh) => refresh.job.done));
  }

  /** `etc/` at each start, and again whenever `[machine_user]` changes (spec 1, "Folders and files"). */
  private async writeEtc(config: Config): Promise<void> {
    const machineUser = JSON.stringify(config.machine_user ?? null);
    if (machineUser === this.etcFor) return;
    await writeEtc(this.folders, config.machine_user);
    this.etcFor = machineUser;
  }

  // Exits.

  private async handleExits(now: Date, config: Config, workspace: Workspace): Promise<void> {
    const queued = this.exits.splice(0);
    if (queued.length === 0) return;
    const outbox = new Outbox({
      version: this.version,
      state: this.state,
      clock: () => now,
      repo: (name) => {
        const registration = config.repos.find((repo) => repo.name === name);
        return registration === undefined ? null : trackerRepo(config, registration, null);
      },
    });
    for (const { session, exit } of queued) {
      const sessions = await this.state.sessions();
      const entry = sessions.find((each) => each.id === session);
      if (entry === undefined) continue;
      const registration = config.repos.find((repo) => repo.name === entry.repo);
      const repo = registration === undefined ? null : trackerRepo(config, registration, null);
      if (repo !== null) await this.tracker.revoke({ id: entry.id, repo });

      if (exit.kind === "exited" && repo !== null) {
        const issue = await this.tracker.issue({ id: entry.issue_id, repo });
        if (issue.role === WORKING[entry.stage]) {
          const result = await outbox.apply(paths.sessionFolder(this.folders, entry.id), { identity: this.tracker });
          await this.state.log(now, `${entry.id} ${entry.issue}: outbox ${JSON.stringify(result)}`);
        } else {
          // The issue moved out while the session ran, so its outbox is discarded.
          await this.state.log(now, `${entry.id} ${entry.issue}: left ${WORKING[entry.stage]}, outbox discarded`);
        }
      } else {
        await this.state.log(now, `${entry.id} ${entry.issue}: exit ${exit.kind}`);
      }

      await workspace.dispose({ session: entry.id, worktree: entry.worktree });
      await this.state.writeSessions((await this.state.sessions()).filter((each) => each.id !== entry.id));
    }
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
    if (fetch.ok && record?.ok === true) await this.refreshIfDue(now, registration, record.record, fetch.head, workspace);
    const repo = trackerRepo(config, registration, record?.ok === true ? record.record : null);

    // 3. Snapshot, with the comments since the repo's cursor.
    const snapshot = repo === null ? null : await this.tracker.snapshot(repo, { since: await this.state.cursor(registration.name) });
    if (repo !== null && snapshot !== null) {
      // 5. Answers. FLD-104 adds step 4, moved out.
      const handled = await this.answers(now, repo, snapshot);
      // The cursor moves only once every comment it passes is in issue memory.
      const latest = snapshot.comments.at(-1)?.created_at;
      if (latest !== undefined) await this.state.writeCursor(registration.name, latest);
      // 6. Flags, and 7. Subscriptions.
      await this.flags(now, repo, snapshot, handled);
      await this.subscriptions(repo, snapshot, handled);
    }
    const waitingForSpecs = (snapshot?.issues ?? []).filter((issue) => issue.role === "ready_to_plan" && hasSpec(issue));
    return { registration, tracker: repo, fetch, record, snapshot, waitingForSpecs };
  }

  // The dependency cache.

  /**
   * Starts a cache refresh when the default branch's tip moved since the last one, before the repo's first
   * session, when the cache has gone, and an hour after a failed one (ADR 0018). The record on the default
   * branch names the install, so a repo without a valid one gets none.
   */
  private async refreshIfDue(now: Date, registration: Registration, record: RepoRecord, head: string, workspace: Workspace): Promise<void> {
    if (this.refreshes.has(registration.name)) return;
    const { current, last } = await workspace.cacheState(registration.name);
    const due = last === null || last.commit !== head || (last.ok ? !current : now.getTime() - Date.parse(last.at) >= HOUR);
    if (!due) return;
    const job = await workspace.refreshCache({ repo: registration, record, commit: head, versionFolder: this.versionFolder, now });
    const refresh: RunningRefresh = { job, ended: false };
    void job.done.then(() => {
      refresh.ended = true;
    });
    this.refreshes.set(registration.name, refresh);
    await this.state.log(now, `${registration.name}: cache refresh ${job.session} started at ${head}`);
  }

  /** Logs each refresh that ended since the last tick, and forgets it. */
  private async endRefreshes(now: Date): Promise<void> {
    for (const [repo, refresh] of this.refreshes) {
      if (!refresh.ended) continue;
      this.refreshes.delete(repo);
      const result = await refresh.job.done;
      await this.state.log(now, `${repo}: cache refresh ${refresh.job.session} ${result.ok ? "passed" : `failed, kept the last good cache: ${result.error}`}`);
    }
  }

  // The daily sweep.

  /**
   * Runs the sweep at the first poll after 03:00 in the Mac's time zone, and at a start when the last sweep
   * was more than 24 hours ago. A running refresh keeps its worktree and session folder.
   */
  private async sweep(now: Date, workspace: Workspace): Promise<void> {
    const first = !this.polled;
    this.polled = true;
    const last = await this.state.lastSweep();
    const threeAm = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 3);
    if (threeAm > now) threeAm.setDate(threeAm.getDate() - 1);
    const due = last === null || last < threeAm || (first && now.getTime() - last.getTime() > 24 * HOUR);
    if (!due) return;
    const keep = new Set((await this.state.sessions()).map((entry) => entry.id));
    for (const { job } of this.refreshes.values()) keep.add(job.session).add(basename(paths.cacheWorktree(this.folders, job.repo)));
    const swept = await workspace.sweep({ now, keep });
    await this.state.writeSweep(now);
    if (swept.length > 0) await this.state.log(now, `sweep removed ${swept.join(", ")}`);
  }

  // 5. Answers.

  /**
   * For each paused issue with an open pause, keeps each comment posted after the pause comment as the first
   * snapshot that returned it saw it, then moves the issue when the oldest reply that names an answer does,
   * and clears the flag (ADR 0019). Any other reply leaves the issue paused and flagged.
   */
  private async answers(now: Date, repo: TrackerRepo, snapshot: Snapshot): Promise<Set<string>> {
    const handled = new Set<string>();
    for (const issue of snapshot.issues) {
      if (issue.role !== "paused") continue;
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
      if ((memory.flag === null && memory.pause === null) || inFlight.has(uuid)) continue;
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

  // Starts.

  private async starts(now: Date, config: Config, repos: RepoPoll[], workspace: Workspace): Promise<void> {
    const sessions = await this.state.sessions();
    const busy = new Set(sessions.map((entry) => entry.issue_id));
    const candidates: { poll: RepoPoll; issue: SnapshotIssue }[] = [];
    for (const poll of repos) {
      if (!poll.fetch.ok || poll.record?.ok !== true || poll.snapshot === null) continue;
      // Nothing starts for a repo while its cache refresh runs.
      if (this.refreshes.has(poll.registration.name)) continue;
      for (const issue of poll.snapshot.issues) {
        if (issue.role === "ready_to_plan" && !hasSpec(issue) && !busy.has(issue.id)) candidates.push({ poll, issue });
      }
    }
    candidates.sort((a, b) => priorityRank(a.issue) - priorityRank(b.issue) || a.issue.created_at.localeCompare(b.issue.created_at));
    let free = config.concurrency_cap - sessions.filter((entry) => entry.state === "starting" || entry.state === "running").length;
    for (const { poll, issue } of candidates) {
      if (free <= 0) break;
      free--;
      await this.start(now, config, poll, issue, workspace);
    }
  }

  private async start(now: Date, config: Config, poll: RepoPoll, issue: SnapshotIssue, workspace: Workspace): Promise<void> {
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
      attempt: 1,
      pid: null,
      pid_started_at: null,
      claude_uuid: null,
      worktree,
      started_at: null,
      deadline: null,
      state: "starting",
    };

    // 1. The entry first, then the take, so the issue never sits in Planning unseen (ADR 0002).
    await this.state.writeSessions([...(await this.state.sessions()), entry]);
    const taken = await this.lifecycle.move(issue, "planning", "take");
    if (!taken.ok) {
      await this.state.log(now, `${id} ${issue.identifier}: take refused: ${taken.violation}`);
      await this.dropEntry(id);
      return;
    }

    // 2. The record at the commit the session starts from: the default branch's tip at this poll.
    const commit = poll.fetch.head;
    const deadline = new Date(now.getTime() + durationMs(record.time_limits.plan)).toISOString();
    const linear = config.linear[repo.workspace];
    const full = await this.tracker.issue(issue);
    const memory = await this.state.issueMemory(registration.name, issue.id);

    // 3. Prepare, then the launch. FLD-98 counts a failure of either as a failed session.
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
      await this.state.log(now, `${id} ${issue.identifier}: prepare failed: ${(error as Error).message}`);
      await workspace.dispose({ session: id, worktree });
      await this.dropEntry(id);
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
      // FLD-105 turns each event into the plan-limit hold.
      rateLimit: () => {},
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

  /** The repo's cache in `status.json`: a running refresh, then a failed last one, then whether a good copy exists. */
  private async cache(repo: string, workspace: Workspace): Promise<StatusRepo["cache"]> {
    if (this.refreshes.has(repo)) return "refreshing";
    const { current, last } = await workspace.cacheState(repo);
    if (last?.ok === false) return "failed";
    return current ? "ok" : "missing";
  }

  private async publish(now: Date, config: Config, repos: RepoPoll[], workspace: Workspace): Promise<void> {
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
      jobs: [...this.refreshes.values()].map(({ job }) => ({ kind: "cache_refresh" as const, repo: job.repo, started_at: job.startedAt })),
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
      repos: await Promise.all(repos.map(async (poll) => statusRepo(poll, await this.cache(poll.registration.name, workspace)))),
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

function statusRepo(poll: RepoPoll, cache: StatusRepo["cache"]): StatusRepo {
  const record = poll.record === null ? "waiting" : poll.record.ok ? "ok" : poll.record.reason === "newer" ? "newer" : "invalid";
  return {
    name: poll.registration.name,
    record,
    cache,
    waiting_for_specs: poll.waitingForSpecs.map((issue) => ({ issue: issue.identifier, title: issue.title })),
    waiting_for_blockers: [],
    waiting_for_port: null,
  };
}
