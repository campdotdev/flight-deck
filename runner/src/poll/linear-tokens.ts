// The runner's Linear tokens (spec 1, "Tokens", ADR 0005). Each poll asks for the Flight Deck app's token once per
// workspace before any Linear step. The adapter mints it when it holds none: at the runner's start, after a
// revoke, and after a 401. Each session's Reader token is minted at its start.
//
// When a mint of either app fails, the workspace waits on a backoff of 1, 2, 4, and 8 minutes, then every 15, and
// each retry mints from the app that failed. While the Flight Deck app's mint fails, every Linear step of the poll
// skips that workspace. While only Reader's fails, the poll runs and only starts wait, and a retry mints a Reader
// token for no session, so it takes no issue. The cause `linear_token` holds that workspace only, because each
// workspace has its own apps. `trouble/` files its issue once a mint works, after a failure of 15 minutes or more.
import type { Config } from "../install/index.ts";
import { MintFailed, type LinearApp, type Tracker } from "../tracker/index.ts";
import type { Trouble } from "./trouble/trouble.ts";

/** The waits after the first, second, third, and fourth failed mint. Every later one waits 15 minutes. */
const BACKOFF_MS = [1, 2, 4, 8].map((minutes) => minutes * 60_000);
const THEN_MS = 15 * 60_000;

/** What a workspace's tokens allow this poll. */
export type TokenState = "ok" | { failing: LinearApp };

interface Failure {
  app: LinearApp;
  /** How many mints failed in a row. */
  failures: number;
  /** When the next retry is due, in epoch milliseconds. */
  next: number;
  error: string;
}

export class LinearTokens {
  /** Each workspace whose last mint failed. It lives only in memory: a new runner mints at its first poll. */
  private readonly failures = new Map<string, Failure>();
  /** This poll's answer for each workspace, so each mints at most once a poll. */
  private checked = new Map<string, Promise<TokenState>>();

  constructor(private readonly tracker: Tracker) {}

  /** Starts a new poll: each workspace is checked again at its first use. */
  newPoll(): void {
    this.checked = new Map();
  }

  /**
   * Whether the runner's own token works for the workspace this poll, and whether sessions may start there.
   * Mints when a mint is due, and opens or clears `linear_token`.
   */
  check(now: Date, config: Config, workspace: string, trouble: Trouble): Promise<TokenState> {
    let state = this.checked.get(workspace);
    if (state === undefined) {
      state = this.mint(now, workspace).then((result) => {
        this.report(now, config, workspace, trouble);
        return result;
      });
      this.checked.set(workspace, state);
    }
    return state;
  }

  /** Whether the Flight Deck app's token works for the workspace this poll. */
  async usable(now: Date, config: Config, workspace: string, trouble: Trouble): Promise<boolean> {
    const state = await this.check(now, config, workspace, trouble);
    return state === "ok" || state.failing === "reader";
  }

  /** Whether sessions may start in the workspace this poll. Only a workspace already checked can start. */
  async canStart(workspace: string): Promise<boolean> {
    return (await this.checked.get(workspace)) === "ok";
  }

  /** A session's Reader mint failed at its start: no more starts in the workspace this poll, and the backoff runs. */
  readerFailed(now: Date, config: Config, workspace: string, error: MintFailed, trouble: Trouble): void {
    this.fail(now, workspace, error);
    this.checked.set(workspace, Promise.resolve({ failing: "reader" }));
    this.report(now, config, workspace, trouble);
  }

  private async mint(now: Date, workspace: string): Promise<TokenState> {
    const failure = this.failures.get(workspace);
    const due = failure === undefined || now.getTime() >= failure.next;
    if (failure?.app === "flight_deck" && !due) return { failing: "flight_deck" };
    try {
      await this.tracker.runnerToken(workspace);
      if (failure?.app === "reader") {
        if (!due) return { failing: "reader" };
        await this.tracker.tryReaderMint(workspace);
      }
    } catch (error) {
      if (!(error instanceof MintFailed)) throw error;
      this.fail(now, workspace, error);
      return { failing: error.app };
    }
    this.failures.delete(workspace);
    return "ok";
  }

  private fail(now: Date, workspace: string, error: MintFailed): void {
    const failures = (this.failures.get(workspace)?.failures ?? 0) + 1;
    const wait = BACKOFF_MS[failures - 1] ?? THEN_MS;
    this.failures.set(workspace, { app: error.app, failures, next: now.getTime() + wait, error: error.message });
  }

  /** Opens `linear_token` for a workspace whose mint failed, and clears it once a mint works. */
  private report(now: Date, config: Config, workspace: string, trouble: Trouble): void {
    const failure = this.failures.get(workspace);
    if (failure === undefined) {
      trouble.clear("linear_token", workspace, { ended: now.toISOString() });
      return;
    }
    const repos = config.repos.filter((repo) => repo.tracker.workspace === workspace).map((repo) => repo.name);
    trouble.open("linear_token", workspace, { scope: "workspace", repos, facts: { workspace, app: failure.app, error: failure.error } });
  }
}
