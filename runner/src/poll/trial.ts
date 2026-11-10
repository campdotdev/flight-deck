// The trial run (spec 1, "Trial run"; glossary: trial run). One session with stage `trial`, in a throwaway repo,
// with the settings a plan session gets and no record, that proves the sandbox and Claude Code's login work.
// `flight-deck install` asks for one over the socket, and the runner starts one every 15 minutes while
// `claude_login` is open, because a passing trial is what clears it (ADR 0005).
//
// A trial starts in step 9, ahead of any retry or take, and counts toward the concurrency cap. It takes no issue,
// so it runs under every hold except the ones that stop Claude Code itself or the runner's spending (ADR 0021).
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { paths, sessionParts, type Folders } from "../folders/index.ts";
import { buildLaunch, type Auth, type Exit, type ExitKind, type Harness, type HarnessSession, type SessionEvents } from "../harness/index.ts";
import type { Config } from "../install/index.ts";
import type { HoldCause, SessionEntry, State, StatusHold } from "../state/index.ts";
import type { Workspace } from "../workspace/index.ts";
import type { Trouble } from "./trouble/trouble.ts";

/** How a trial ended, for `{ "op": "trial" }`, which install prints (spec 1, "The runner's socket"). */
export type TrialResult =
  | { result: "passed"; session: string; exit: ExitKind }
  /** `exit` is `null` when the trial never started, because its repo or its launch couldn't be made. */
  | { result: "failed"; session: string; exit: ExitKind | null; error?: string }
  /** A hold a trial doesn't start under. */
  | { result: "held"; cause: HoldCause };

/** What the caller hears before the trial ends. */
export interface TrialEvents {
  /** The cap is full, so the trial waits for a free place. Called once. */
  waiting?(): void;
}

/** The holds a trial doesn't start under. Every other hold, a repo's or a workspace's included, lets it run. */
export const TRIAL_STOPPED_BY: ReadonlySet<HoldCause> = new Set(["stop", "update", "credentials", "claude_code_version", "api_cap", "rate_limit"]);

/** The first hold that stops a trial, or `null` when a trial may start. */
export function trialStoppedBy(holds: readonly StatusHold[]): HoldCause | null {
  return holds.find((hold) => TRIAL_STOPPED_BY.has(hold.cause))?.cause ?? null;
}

/** A trial's deadline, from its own start. */
const DEADLINE_MS = 5 * 60_000;
/** How often the runner starts a trial while `claude_login` is open. */
const LOGIN_EVERY_MS = 15 * 60_000;
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** A trial has no registration, so its `PATH` is the folders of `[paths]` `claude`, `git`, and `gh`, then the system's. */
export function trialPath(config: Pick<Config, "paths">): string {
  const folders = [config.paths.claude, config.paths.git, config.paths.gh].map((path) => dirname(path));
  return [...new Set(folders), SYSTEM_PATH].join(":");
}

interface Waiter {
  resolve(result: TrialResult): void;
  events: TrialEvents;
  told: boolean;
}

export interface TrialsOptions {
  folders: Folders;
  state: State;
  harness: Harness;
  /** The running version. */
  version: string;
  versionFolder: string;
  /** What a running trial reports to the Poll: its exit and Claude Code's login warning. */
  events(session: string): SessionEvents;
}

export interface TrialStart {
  now: Date;
  config: Config;
  auth: Auth;
  /** Every hold this poll. */
  holds: StatusHold[];
  /** Free places under the cap. */
  free: number;
  workspace: Workspace;
  trouble: Trouble;
}

export class Trials {
  /** Callers waiting for the next trial to start. */
  private waiters: Waiter[] = [];
  /** Callers waiting for a running trial to end, by its session ID. */
  private readonly attached = new Map<string, Waiter[]>();
  /** When the next trial for `claude_login` is due, as ms, or `null` while the cause is closed. */
  private nextLogin: number | null = null;

  constructor(private readonly options: TrialsOptions) {}

  /** Asks for a trial. It starts at the next poll that allows it, and the promise resolves once it ends. */
  request(events: TrialEvents = {}): Promise<TrialResult> {
    return new Promise((resolve) => this.waiters.push({ resolve, events, told: false }));
  }

  /** Whether a trial would start this poll, given a place: one was asked for, or one is due for `claude_login`. */
  wanted(now: Date, trouble: Trouble): boolean {
    if (!trouble.isOpen("claude_login", "runner")) this.nextLogin = null;
    else this.nextLogin ??= now.getTime() + LOGIN_EVERY_MS;
    return this.waiters.length > 0 || (this.nextLogin !== null && now.getTime() >= this.nextLogin);
  }

  /** Step 9's first start: the trial, when one is wanted. Returns whether it took a place under the cap. */
  async start(input: TrialStart): Promise<boolean> {
    const { now, workspace } = input;
    const { state, folders } = this.options;
    const sessions = await state.sessions();
    const running = sessions.find((entry) => entry.stage === "trial");
    if (running !== undefined) {
      // One trial at a time. A caller who asks while one runs gets its result.
      this.attached.set(running.id, [...(this.attached.get(running.id) ?? []), ...this.waiters.splice(0)]);
      return false;
    }
    if (!this.wanted(now, input.trouble)) return false;
    const cause = trialStoppedBy(input.holds);
    if (cause !== null) {
      for (const waiter of this.waiters.splice(0)) waiter.resolve({ result: "held", cause });
      return false;
    }
    if (input.free <= 0) {
      for (const waiter of this.waiters.filter((each) => !each.told)) {
        waiter.told = true;
        waiter.events.waiting?.();
      }
      return false;
    }

    const id = await workspace.newSessionId();
    const deadline = new Date(now.getTime() + DEADLINE_MS).toISOString();
    const entry: SessionEntry = {
      id,
      repo: "",
      issue: "",
      issue_id: "",
      title: "",
      stage: "trial",
      mode: "issue",
      attempt: 1,
      pid: null,
      pid_started_at: null,
      claude_uuid: null,
      worktree: paths.worktree(folders, id),
      started_at: null,
      deadline: null,
      state: "starting",
    };
    await state.addSession(entry);
    this.attached.set(id, this.waiters.splice(0));
    if (this.nextLogin !== null) this.nextLogin = now.getTime() + LOGIN_EVERY_MS;

    let session: HarnessSession;
    try {
      const prepared = await workspace.prepareTrial({ session: id, deadline, version: this.options.version, versionFolder: this.options.versionFolder, path: trialPath(input.config) });
      const launch = await buildLaunch({
        folders,
        id,
        stage: "trial",
        repo: "",
        issue: "",
        worktree: prepared.worktree,
        sessionFolder: prepared.sessionFolder,
        record: null,
        env: prepared.env,
        // Claude Code's default model.
        model: "",
        auth: input.auth,
        versionFolder: this.options.versionFolder,
      });
      session = {
        id,
        stage: "trial",
        mode: "issue",
        repo: "",
        issue: "",
        worktree: prepared.worktree,
        sessionFolder: prepared.sessionFolder,
        sessionJson: prepared.sessionJson,
        transcript: paths.trialTranscript(folders, id),
        deadline,
        model: "",
        versionFolder: this.options.versionFolder,
        launch,
      };
    } catch (error) {
      const message = (error as Error).message;
      await state.log(now, `${id} trial: prepare failed: ${message}`);
      await this.end(entry, workspace, { result: "failed", session: id, exit: null, error: message });
      return false;
    }

    const handle = await this.options.harness.start(session, this.options.events(id));
    const started: SessionEntry = {
      ...entry,
      pid: handle.pid,
      pid_started_at: handle.pidStartedAt,
      claude_uuid: handle.uuid,
      started_at: now.toISOString(),
      deadline,
      state: "running",
    };
    await state.updateSession(id, () => started);
    await state.log(now, `${id} trial: started`);
    return true;
  }

  /**
   * A trial ended. It passed when the session sent `init`, exited 0, and left `summary.md`, and a pass is
   * recorded in `state/trial.json` and clears `claude_login`. Its workspace goes either way, and its repo with it.
   */
  async exited(input: { now: Date; entry: SessionEntry; exit: Exit; workspace: Workspace; trouble: Trouble }): Promise<void> {
    const { now, entry, exit } = input;
    const { state, folders, version } = this.options;
    const kind = exitKind(exit);
    const summary = existsSync(join(sessionParts(paths.sessionFolder(folders, entry.id)).outbox, "summary.md"));
    // An `exited` exit means the session sent `init`, or the Harness would have reported `no_init`.
    const passed = exit.kind === "exited" && exit.code === 0 && summary;
    if (passed) {
      await state.writeTrial({ version, claude_code_version: exit.claudeCodeVersion, session: entry.id, passed_at: now.toISOString() });
      input.trouble.clear("claude_login", "runner");
    }
    await state.log(now, `${entry.id} trial: ${passed ? "passed" : `failed, exit ${exit.kind}${summary ? "" : ", no summary.md"}`}`);
    const result: TrialResult = passed
      ? { result: "passed", session: entry.id, exit: kind }
      : { result: "failed", session: entry.id, exit: kind, ...(exit.error === undefined ? {} : { error: exit.error }) };
    await this.end(entry, input.workspace, result);
  }

  /** At the runner's start: a trial an earlier runner left has no one waiting for it, so it goes. */
  async atStart(now: Date, workspace: Workspace): Promise<void> {
    for (const entry of await this.options.state.sessions()) {
      if (entry.stage !== "trial") continue;
      await this.options.state.log(now, `${entry.id} trial: left by an earlier runner, dropped`);
      await this.end(entry, workspace, null);
    }
  }

  /** Disposes the trial's workspace, which deletes its repo outright, drops its entry, and answers its callers. */
  private async end(entry: SessionEntry, workspace: Workspace, result: TrialResult | null): Promise<void> {
    await workspace.dispose({ session: entry.id, worktree: entry.worktree });
    await this.options.state.dropSession(entry.id);
    const waiters = this.attached.get(entry.id) ?? [];
    this.attached.delete(entry.id);
    if (result !== null) for (const waiter of waiters) waiter.resolve(result);
  }
}

/** The exit without the transcript and the version. */
function exitKind(exit: Exit): ExitKind {
  switch (exit.kind) {
    case "exited":
      return { kind: "exited", code: exit.code };
    case "rate_limited":
      return { kind: "rate_limited", resetsAt: exit.resetsAt };
    default:
      return { kind: exit.kind } as ExitKind;
  }
}
