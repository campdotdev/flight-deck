// Trouble issues (spec 1, "Trouble issues", ADR 0011). A trouble cause stops the runner, or one repo's factory,
// from starting sessions. Each poll learns which causes are open: steps 1 and 2 and the start check call `open`
// for a cause they find and `clear` for one they checked and found fine. A cause nothing checked this poll keeps
// its state. Step 10, `settle`, then files, flags, and notifies for each cause that opened, comments on each
// issue whose cause cleared, and writes `state/trouble.json`.
import { runnerComment } from "../../outbox/runner-comments/frame.ts";
import type { State, StatusHold, TroubleCause, TroubleEntry, TroubleFacts, TroubleIssue } from "../../state/index.ts";
import { isUnavailable, IssueNotFoundError, type StatusType, type Tracker, type TrackerRepo } from "../../tracker/index.ts";
import { notify } from "./notify.ts";
import { clearedText, troubleText } from "./texts.ts";

/** What a step found when it opened a cause. */
export interface TroubleFinding {
  scope: TroubleEntry["scope"];
  /** The repos it affects. Empty for a cause scoped to the runner, which affects every repo. */
  repos: string[];
  facts: TroubleFacts;
}

export interface SettleContext {
  now: Date;
  tracker: Tracker;
  state: State;
  /** The running version, for the footer. */
  version: string;
  /** The runner's `PATH`, where it finds `osascript`. */
  path: string;
  /** Each registered repo the Tracker can reach this poll, by name. */
  repos: Map<string, TrackerRepo>;
}

/** An issue counts as open in a backlog, unstarted, started, or triage status (spec 1, "Trouble issues"). */
const OPEN_TYPES: ReadonlySet<StatusType> = new Set(["triage", "backlog", "unstarted", "started"]);

/** The causes that file a trouble issue. The others only notify. FLD-109 adds its own. */
const FILES: ReadonlySet<TroubleCause> = new Set(["missing_status", "claude_code_version", "github_token", "claude_login", "claude_login_soon"]);

/** `linear_token` files its issue only once a mint works, after a failure this long or longer (ADR 0005). */
const FILE_AFTER_MS = 15 * 60_000;

/** `claude_login_soon` stops nothing. Every other cause holds sessions. */
const HOLDS_NOTHING: ReadonlySet<TroubleCause> = new Set(["claude_login_soon"]);

function key(cause: TroubleCause, id: string): string {
  return `${cause} ${id}`;
}

/** One poll's view of the trouble causes. */
export class Trouble {
  private readonly opened = new Map<string, { cause: TroubleCause; id: string; finding: TroubleFinding }>();
  private readonly cleared = new Map<string, TroubleFacts>();
  /** The repos a trouble issue can be filed in this poll: the team reads and has its `intake` status. */
  private readonly fileable = new Set<string>();

  private constructor(private entries: TroubleEntry[]) {}

  static async load(state: State): Promise<Trouble> {
    return new Trouble(await state.trouble());
  }

  /** The cause is open this poll. */
  open(cause: TroubleCause, id: string, finding: TroubleFinding): void {
    this.opened.set(key(cause, id), { cause, id, finding });
    this.cleared.delete(key(cause, id));
  }

  /** The step checked the cause and found it fine. `facts` holds what it saw, for the cleared comment. */
  clear(cause: TroubleCause, id: string, facts: TroubleFacts = {}): void {
    if (!this.opened.has(key(cause, id))) this.cleared.set(key(cause, id), facts);
  }

  /** Every known occurrence of the cause that didn't open this poll is fine, for a check that covers them all. */
  clearOthers(cause: TroubleCause): void {
    for (const entry of this.entries) if (entry.cause === cause) this.clear(cause, entry.id);
  }

  /** A trouble issue can be filed in this repo this poll. */
  canFile(repo: string): void {
    this.fileable.add(repo);
  }

  /** Whether the cause is open: it opened this poll, or it was open before and nothing checked it since. */
  isOpen(cause: TroubleCause, id: string): boolean {
    const k = key(cause, id);
    if (this.opened.has(k)) return true;
    if (this.cleared.has(k)) return false;
    return this.entries.some((entry) => entry.cause === cause && entry.id === id && entry.open);
  }

  /** When the open cause opened: its stored time, or `now` for one this poll opened. `null` when it isn't open. */
  since(cause: TroubleCause, id: string, now: Date): string | null {
    if (!this.isOpen(cause, id)) return null;
    const entry = this.entries.find((each) => each.cause === cause && each.id === id);
    return entry?.open === true ? entry.since : now.toISOString();
  }

  /**
   * Each open cause that stops sessions, as holds: one per repo for a repo's cause. It reads this poll's view, so
   * a cause a step opened holds the starts that follow it, from `now`, before step 10 writes it down.
   */
  holds(now: Date): StatusHold[] {
    const at = now.toISOString();
    const open = new Map<string, { cause: TroubleCause; id: string; scope: TroubleEntry["scope"]; repos: string[]; since: string }>();
    for (const entry of this.entries) {
      if (!this.isOpen(entry.cause, entry.id)) continue;
      const finding = this.opened.get(key(entry.cause, entry.id))?.finding;
      open.set(key(entry.cause, entry.id), { cause: entry.cause, id: entry.id, scope: entry.scope, repos: finding?.repos ?? entry.repos, since: entry.open ? entry.since : at });
    }
    for (const [k, { cause, id, finding }] of this.opened) {
      if (!open.has(k)) open.set(k, { cause, id, scope: finding.scope, repos: finding.repos, since: at });
    }
    return [...open.values()]
      .filter((each) => !HOLDS_NOTHING.has(each.cause))
      .flatMap((each): StatusHold[] => {
        const cause = each.cause as StatusHold["cause"];
        if (each.scope === "runner") return [{ cause, scope: "runner", name: null, since: each.since, until: null }];
        // A workspace's cause, such as `linear_token`, holds every repo in it, and names the workspace.
        if (each.scope === "workspace") return [{ cause, scope: "workspace", name: each.id, since: each.since, until: null }];
        return each.repos.map((repo) => ({ cause, scope: each.scope, name: repo, since: each.since, until: null }));
      });
  }

  /** `status.json`'s `trouble`: each open cause. */
  status(): { cause: TroubleCause; repos: string[]; issue_url: string | null; since: string }[] {
    return this.entries
      .filter((entry) => entry.open)
      .map((entry) => ({ cause: entry.cause, repos: entry.repos, issue_url: entry.issues[0]?.url ?? null, since: entry.since }));
  }

  /** Step 10: file, flag, and notify for each cause that opened, and comment on each issue whose cause cleared. */
  async settle(context: SettleContext): Promise<void> {
    const at = context.now.toISOString();
    const log = (message: string) => context.state.log(context.now, message);
    const save = () => context.state.writeTrouble(this.entries);

    for (const { cause, id, finding } of this.opened.values()) {
      if (!this.entries.some((entry) => entry.cause === cause && entry.id === id)) {
        this.entries.push({ cause, id, scope: finding.scope, repos: finding.repos, open: false, since: at, facts: finding.facts, issues: [] });
      }
    }

    for (const entry of this.entries) {
      const k = key(entry.cause, entry.id);
      const assigned = await this.sync(context, entry);
      // A cleared or reopened comment an earlier poll couldn't post goes first.
      for (const issue of entry.issues) if (issue.unposted !== undefined) await this.comment(context, issue, issue.unposted, save);
      const opening = this.opened.get(k);
      if (opening !== undefined) {
        const reopened = !entry.open;
        if (reopened) {
          entry.open = true;
          entry.since = at;
          entry.facts = opening.finding.facts;
        }
        entry.repos = opening.finding.repos;
        const text = troubleText(entry, context.version);
        if (reopened) {
          await log(`trouble ${entry.cause} opened${entry.repos.length > 0 ? ` for ${entry.repos.join(", ")}` : ""}: ${text.title}${entry.facts.mode === undefined ? "" : ` (mode ${entry.facts.mode})`}`);
          const posted = await notify(text.notification, { path: context.path });
          if (!posted.ok) await log(`notification failed: ${posted.error}`);
        }
        if (text.body !== null) await this.file(context, entry, text.title, text.body, reopened ? assigned : null, save);
      } else if (this.cleared.has(k) && entry.open) {
        entry.open = false;
        await log(`trouble ${entry.cause} cleared${entry.repos.length > 0 ? ` for ${entry.repos.join(", ")}` : ""}`);
        if (entry.cause === "linear_token") {
          // `linear_token` files only now, once a mint works, and only after a failure of 15 minutes or more.
          entry.facts = { ...entry.facts, ended: this.cleared.get(k)?.ended ?? at };
          if (Date.parse(entry.facts.ended!) - Date.parse(entry.since) >= FILE_AFTER_MS) entry.unfiled = [...entry.repos];
        }
        const cleared = clearedText(entry, this.cleared.get(k) ?? {});
        for (const issue of cleared === null ? [] : entry.issues) {
          const comment = await runnerComment({ statusLine: cleared!.statusLine, sentences: cleared!.sentence, flag: null, answers: null }, {}, { version: context.version });
          await this.comment(context, issue, { body: comment.body, flag: false }, save);
        }
      }
      if (!entry.open && entry.unfiled !== undefined && entry.unfiled.length > 0) await this.fileLate(context, entry, assigned, save);
      await save();
    }
    this.entries = this.entries.filter((entry) => entry.open || entry.issues.length > 0 || (entry.unfiled?.length ?? 0) > 0);
    await save();
  }

  /**
   * Reads each of the entry's trouble issues. A closed or deleted one is forgotten, with its flag. An issue whose
   * assignee the maintainer cleared loses its flag. Returns whether each issue still open is assigned.
   */
  private async sync(context: SettleContext, entry: TroubleEntry): Promise<Map<string, boolean>> {
    const assigned = new Map<string, boolean>();
    const kept: TroubleIssue[] = [];
    for (const issue of entry.issues) {
      const repo = context.repos.get(issue.repo);
      if (repo === undefined) {
        kept.push(issue);
        continue;
      }
      let read;
      try {
        read = await context.tracker.issue({ id: issue.id, repo });
      } catch (error) {
        if (!(error instanceof IssueNotFoundError)) {
          if (!isUnavailable(error)) throw error;
          kept.push(issue);
          continue;
        }
      }
      if (read === undefined || !OPEN_TYPES.has(read.status_type)) {
        await this.forgetFlag(context.state, issue);
        continue;
      }
      if (read.assignee === null && issue.flagged) await this.forgetFlag(context.state, issue);
      assigned.set(issue.id, read.assignee !== null);
      kept.push(issue);
    }
    entry.issues = kept;
    return assigned;
  }

  /**
   * Makes sure each repo the entry affects has an open, flagged trouble issue. With `reopened`, the cause opened
   * again: an issue the maintainer hasn't closed gets "🟡 Needs your help: " and the title, flagged again when
   * it's no longer assigned, and no second issue is filed.
   */
  private async file(
    context: SettleContext,
    entry: TroubleEntry,
    title: string,
    body: string,
    reopened: Map<string, boolean> | null,
    save: () => Promise<void>,
  ): Promise<void> {
    const log = (message: string) => context.state.log(context.now, message);
    const targets = entry.scope === "runner" ? [...this.fileable] : entry.repos.filter((repo) => this.fileable.has(repo));
    for (const name of targets) {
      const repo = context.repos.get(name);
      if (repo === undefined) continue;
      let issue = entry.issues.find((each) => each.repo === name);
      if (issue !== undefined && reopened !== null) {
        const comment = await runnerComment({ statusLine: `🟡 Needs your help: ${issue.title}`, sentences: null, flag: null, answers: null }, {}, { version: context.version });
        await this.comment(context, issue, { body: comment.body, flag: reopened.get(issue.id) === false }, save);
        continue;
      }
      if (issue === undefined) {
        const filed = await this.attempt(log, `${name}: trouble issue ${entry.cause}`, () => context.tracker.file({ repo, title, description: body }, "intake"));
        if (filed === null) continue;
        issue = { repo: name, id: filed.value.id, identifier: filed.value.identifier, url: filed.value.url, title, flagged: false };
        entry.issues.push(issue);
        await save();
        await log(`${issue.identifier}: filed for trouble ${entry.cause}`);
      }
      if (!issue.flagged) {
        await this.rememberFlag(context, issue);
        const target = issue;
        const flagged = await this.attempt(log, `${issue.identifier}: flag`, () => context.tracker.flag({ id: target.id, repo }));
        if (flagged !== null) issue.flagged = true;
        await save();
      }
    }
  }

  /**
   * Files the issue a cause owes once it cleared, in each repo still owed one. A repo whose earlier issue for the
   * cause is still open gets "🟡 Needs your help: " and the title there instead of a second issue.
   */
  private async fileLate(context: SettleContext, entry: TroubleEntry, assigned: Map<string, boolean>, save: () => Promise<void>): Promise<void> {
    const text = troubleText(entry, context.version);
    if (text.body === null) return;
    const owed = entry.unfiled ?? [];
    await this.file(context, { ...entry, repos: owed }, text.title, text.body, assigned, save);
    entry.unfiled = owed.filter((repo) => !entry.issues.some((issue) => issue.repo === repo && issue.flagged));
    if (entry.unfiled.length === 0) delete entry.unfiled;
  }

  /**
   * Posts a cleared or reopened comment on a trouble issue. One Linear doesn't take, or one for a repo Linear
   * can't reach this poll, stays in `unposted`, and the next poll tries it again. A flagging comment flags the
   * issue once it lands.
   */
  private async comment(context: SettleContext, issue: TroubleIssue, comment: { body: string; flag: boolean }, save: () => Promise<void>): Promise<void> {
    issue.unposted = comment;
    await save();
    const repo = context.repos.get(issue.repo);
    if (repo === undefined) return;
    if (comment.flag) await this.rememberFlag(context, issue);
    const log = (message: string) => context.state.log(context.now, message);
    const posted = await this.attempt(log, `${issue.identifier}: trouble comment`, () => context.tracker.post({ id: issue.id, repo }, comment.body, { flag: comment.flag }));
    if (posted === null) return;
    delete issue.unposted;
    if (comment.flag) issue.flagged = true;
    await save();
  }

  /** The flag goes into issue memory before the write, as every runner flag does. Its status line is the title. */
  private async rememberFlag(context: SettleContext, issue: TroubleIssue): Promise<void> {
    const memory = await context.state.issueMemory(issue.repo, issue.id);
    const flag = { cause: "trouble" as const, status_line: issue.title, since: context.now.toISOString(), issue: issue.identifier, title: issue.title, url: issue.url };
    await context.state.writeIssueMemory(issue.repo, issue.id, { ...memory, flag });
  }

  private async forgetFlag(state: State, issue: TroubleIssue): Promise<void> {
    const memory = await state.issueMemory(issue.repo, issue.id);
    if (memory.flag !== null) await state.writeIssueMemory(issue.repo, issue.id, { ...memory, flag: null });
  }

  /** Runs one Tracker write. When Linear doesn't take it, logs that and returns `null`, and the next poll tries again. */
  private async attempt<T>(log: (message: string) => Promise<void>, what: string, write: () => Promise<T>): Promise<{ value: T } | null> {
    try {
      return { value: await write() };
    } catch (error) {
      if (!isUnavailable(error)) throw error;
      await log(`${what} not written: ${error.message}`);
      return null;
    }
  }
}
