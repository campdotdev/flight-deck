// Poll, the runner's core (overview, spec 1's "Poll"). `tick(now)` handles every queued exit, then polls each
// registered repo, then starts sessions and publishes `status.json`. Everything it does shows through the
// Tracker and Harness ports and the state file, so scenarios test it there.
//
// This is the tracer bullet's poll: fetch, snapshot, and starts. Later tickets add the team check, moved-out
// issues, answers, flags, subscriptions, stale takes, trouble, usage, holds, retries, and the start order.
import { readFile } from "node:fs/promises";
import type { Folders } from "../folders/index.ts";
import { paths, sessionParts } from "../folders/index.ts";
import type { Exit, Handle, Harness, HarnessSession } from "../harness/index.ts";
import { readConfig, type Config, type Registration } from "../install/index.ts";
import { Lifecycle } from "../lifecycle/index.ts";
import { Outbox } from "../outbox/index.ts";
import { durationMs, readRecord, type RecordResult, type RepoRecord, type Role } from "../record/index.ts";
import { State, type IssueMemory, type OpenPause, type Reply, type SessionEntry, type Stage, type Status, type StatusRepo } from "../state/index.ts";
import { FACTORY_ROLES, QUEUE_ROLES, type Snapshot, type SnapshotIssue, type Tracker, type TrackerRepo } from "../tracker/index.ts";
import { Workspace, type FetchResult, type SessionJson } from "../workspace/index.ts";
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
    const workspace = new Workspace({ folders: this.folders, git: config.paths.git });
    await this.handleExits(now, config, workspace);

    const repos: RepoPoll[] = [];
    for (const registration of config.repos) repos.push(await this.pollRepo(now, config, registration, workspace));

    await this.starts(now, config, repos, workspace);
    await this.publish(now, config, repos);
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
    if (repo !== null) {
      await this.tracker.revoke({ id: entry.id, repo });
    } else {
      // Linear's revoke takes only the token, but `Tracker.revoke` takes a repo, and with no registration or no
      // `login linear` for the workspace, Poll can't build one. The token stays live until it expires, as one a
      // crashed runner leaves does (ADR 0005). FLD-109 revokes by session from the token the adapter holds.
      const why = registration === undefined ? `${entry.repo} isn't registered` : "its workspace has no Linear login";
      await this.state.log(now, `${entry.id} ${entry.issue}: Reader token not revoked, because ${why}`);
    }

    if (exit.kind === "exited" && repo !== null) {
      const issue = await this.tracker.issue({ id: entry.issue_id, repo });
      const folder = paths.sessionFolder(this.folders, entry.id);
      // An apply whose move landed before a lost response or a failed write after it runs again, so a pause's
      // answers still land. The Outbox's check refuses any other status the maintainer moved the issue to.
      if (issue.role === WORKING[entry.stage] || (await Outbox.moved(folder, issue.role))) {
        const outbox = new Outbox({ version: this.version, state: this.state, clock: () => now, repo: (name) => (name === entry.repo ? repo : null) });
        const result = await outbox.apply(folder, { identity: this.tracker });
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
    if (repo !== null && snapshot !== null) {
      try {
        // 5. Answers. FLD-104 adds step 4, moved out.
        const handled = await this.answers(now, repo, snapshot);
        // The cursor moves only once every comment it passes is in issue memory.
        const latest = snapshot.comments.at(-1)?.created_at;
        if (latest !== undefined) await this.state.writeCursor(registration.name, latest);
        // 6. Flags, and 7. Subscriptions.
        await this.flags(now, repo, snapshot, handled);
        await this.subscriptions(repo, snapshot, handled);
      } catch (error) {
        await this.state.log(now, `${registration.name}: answers, flags, or subscriptions failed: ${(error as Error).message}`);
        snapshot = null;
      }
    }
    const waitingForSpecs = (snapshot?.issues ?? []).filter((issue) => issue.role === "ready_to_plan" && hasSpec(issue));
    return { registration, tracker: repo, fetch, record, snapshot, waitingForSpecs };
  }

  // 5. Answers.

  /**
   * For each issue with an open pause, keeps each comment posted after the pause comment as the first snapshot
   * that returned it saw it. Then it moves each paused issue when the oldest reply that names an answer does,
   * and clears the flag (ADR 0019). Any other reply leaves the issue paused and flagged.
   */
  private async answers(now: Date, repo: TrackerRepo, snapshot: Snapshot): Promise<Set<string>> {
    // Every open pause's replies go into issue memory before any move, so a move that fails, on this issue or
    // another, still leaves them as first seen.
    const open: { issue: SnapshotIssue; memory: IssueMemory; pause: OpenPause }[] = [];
    for (const issue of snapshot.issues) {
      // A pause whose move to Paused hasn't landed waits in Planning. It keeps its replies, and takes no answer yet.
      if (issue.role !== "paused" && issue.role !== "planning") continue;
      const memory = await this.state.issueMemory(repo.name, issue.id);
      const pause = memory.pause;
      if (pause === null) continue;
      const known = new Set(pause.replies.map((reply) => reply.id));
      const fresh: Reply[] = snapshot.comments
        .filter((comment) => comment.issue === issue.id && comment.created_at > pause.comment_at && !known.has(comment.id))
        .map(({ id, author, created_at, body, synced }) => ({ id, author, created_at, body, synced }));
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
      if ((memory.flag === null && memory.pause === null) || inFlight.has(uuid)) continue;
      await this.state.writeIssueMemory(repo.name, uuid, { ...memory, flag: null, pause: null });
      await this.state.log(now, `${memory.flag?.issue ?? uuid}: left flight, flag and pause forgotten`);
    }

    for (const issue of ownedIssues(snapshot)) {
      if (handled.has(issue.id)) continue;
      const memory = await this.state.issueMemory(repo.name, issue.id);
      let next = memory;
      // A pause closes when its issue leaves Paused. One whose move to Paused hasn't landed waits in Planning.
      if (memory.pause !== null && issue.role !== "paused" && issue.role !== "planning") next = { ...next, pause: null };
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
    const candidates: { poll: RepoPoll; issue: SnapshotIssue }[] = [];
    for (const poll of repos) {
      if (!poll.fetch.ok || poll.record?.ok !== true || poll.snapshot === null) continue;
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
    // A throw from here until the Harness holds the session, such as a failed Linear read, ends the start: the
    // workspace and the entry go, so a `starting` entry with no session never holds a slot. FLD-98 counts it as a
    // failed session.
    let minted = false;
    let handle: Handle;
    let deadline: string;
    try {
      const taken = await this.lifecycle.move(issue, "planning", "take");
      if (!taken.ok) {
        await this.state.log(now, `${id} ${issue.identifier}: take refused: ${taken.violation}`);
        await this.dropEntry(id);
        return;
      }

      // 2. The record at the commit the session starts from: the default branch's tip at this poll.
      const commit = poll.fetch.head;
      deadline = new Date(now.getTime() + durationMs(record.time_limits.plan)).toISOString();
      const linear = config.linear[repo.workspace];
      const full = await this.tracker.issue(issue);
      const memory = await this.state.issueMemory(registration.name, issue.id);

      // 3. Prepare.
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
      };
      handle = await this.harness.start(session, {
        exit: (exit) => void this.exits.push({ session: id, exit }),
        // FLD-105 turns each event into the plan-limit hold.
        rateLimit: () => {},
      });
    } catch (error) {
      await this.state.log(now, `${id} ${issue.identifier}: start failed: ${(error as Error).message}`);
      await this.endStart(now, workspace, id, worktree, minted ? repo : null);
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

  /** Undoes a start that failed before the Harness held its session. Each step runs even when one before it fails. */
  private async endStart(now: Date, workspace: Workspace, id: string, worktree: string, minted: TrackerRepo | null): Promise<void> {
    const steps: [string, () => Promise<void>][] = [
      ["revoke", async () => (minted === null ? undefined : await this.tracker.revoke({ id, repo: minted }))],
      ["dispose", () => workspace.dispose({ session: id, worktree })],
      ["drop", () => this.dropEntry(id)],
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

/** The repo as the Tracker needs it: the record's `[tracker]` when it's valid, or else the registration's copy. */
function trackerRepo(config: Config, registration: Registration, record: RepoRecord | null): TrackerRepo | null {
  const tracker = record?.tracker ?? registration.tracker;
  const linear = config.linear[tracker.workspace];
  // FLD-98's trouble causes open `linear_login` for a workspace `login linear` hasn't signed in.
  if (linear === undefined) return null;
  return { name: registration.name, workspace: tracker.workspace, team: tracker.team, statuses: tracker.statuses, maintainer: linear.maintainer_id };
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
