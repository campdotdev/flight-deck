// Trouble issues (spec 1, "Trouble issues", ADR 0011). A trouble cause stops the runner, or one repo's factory,
// from starting sessions. Each poll learns which causes are open: steps 1 and 2 and the start check call `open`
// for a cause they find and `clear` for one they checked and found fine. A cause nothing checked this poll keeps
// its state. Step 10, `settle`, then files, flags, and notifies for each cause that opened, comments on each
// issue whose cause cleared, and writes `state/trouble.json`.
import { randomUUID } from "node:crypto";
import { runnerComment } from "../../outbox/runner-comments/frame.ts";
import { postedComment } from "../../outbox/runner-comments/writes.ts";
import type { State, StatusHold, TroubleCause, TroubleEntry, TroubleFacts, TroubleIssue } from "../../state/index.ts";
import { isUnavailable, IssueNotFoundError, type StatusType, type Tracker, type TrackerIssue, type TrackerRepo } from "../../tracker/index.ts";
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
    const open = new Map<string, { cause: TroubleCause; scope: TroubleEntry["scope"]; repos: string[]; since: string }>();
    for (const entry of this.entries) {
      if (!this.isOpen(entry.cause, entry.id)) continue;
      const finding = this.opened.get(key(entry.cause, entry.id))?.finding;
      open.set(key(entry.cause, entry.id), { cause: entry.cause, scope: entry.scope, repos: finding?.repos ?? entry.repos, since: entry.open ? entry.since : at });
    }
    for (const [k, { cause, finding }] of this.opened) {
      if (!open.has(k)) open.set(k, { cause, scope: finding.scope, repos: finding.repos, since: at });
    }
    return [...open.values()]
      .filter((each) => !HOLDS_NOTHING.has(each.cause))
      .flatMap((each): StatusHold[] => {
        const cause = each.cause as StatusHold["cause"];
        if (each.scope === "runner") return [{ cause, scope: "runner", name: null, since: each.since, until: null }];
        return each.repos.map((repo) => ({ cause, scope: each.scope, name: repo, since: each.since, until: null }));
      });
  }

  /** `status.json`'s `trouble`: each open cause. */
  status(): { cause: string; repos: string[]; issue_url: string | null; since: string }[] {
    return this.entries
      .filter((entry) => entry.open)
      .map((entry) => ({ cause: entry.cause, repos: entry.repos, issue_url: entry.issues[0]?.url ?? null, since: entry.since }));
  }

  /**
   * Step 10: file, flag, and notify for each cause that opened, file and flag what's still owed for each cause that
   * stays open, and comment on each issue whose cause cleared.
   */
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
      const reads = await this.sync(context, entry);
      const opening = this.opened.get(k);
      if (opening !== undefined) {
        const reopened = !entry.open;
        if (reopened) {
          entry.open = true;
          entry.since = at;
        }
        // What the runner sees now, so a missing status restored while the cause stays open stops naming it.
        entry.facts = opening.finding.facts;
        entry.repos = opening.finding.repos;
        const text = troubleText(entry, context.version);
        if (reopened) {
          // Each issue the maintainer hasn't closed gets the reopened comment, which names what broke this time and
          // replaces a cleared comment still owed.
          for (const issue of entry.issues) issue.pending = { kind: "reopened", statusLine: `🟡 Needs your help: ${text.title}`, since: at, tried: false };
          await log(`trouble ${entry.cause} opened${entry.repos.length > 0 ? ` for ${entry.repos.join(", ")}` : ""}: ${text.title}${entry.facts.mode === undefined ? "" : ` (mode ${entry.facts.mode})`}`);
          const posted = await notify(text.notification, { path: context.path });
          if (!posted.ok) await log(`notification failed: ${posted.error}`);
        }
        if (text.body !== null) await this.file(context, entry, text.title, text.body, save);
      } else if (this.cleared.has(k) && entry.open) {
        entry.open = false;
        await log(`trouble ${entry.cause} cleared${entry.repos.length > 0 ? ` for ${entry.repos.join(", ")}` : ""}`);
        const cleared = clearedText(entry, this.cleared.get(k) ?? {});
        if (cleared !== null) for (const issue of entry.issues) issue.pending = { kind: "cleared", ...cleared, since: at, tried: false };
      } else if (entry.open) {
        // A cause an event opens, such as Claude Code's login warning, doesn't open again each poll, so a filing or
        // a flag Linear didn't take is tried again here until it lands.
        const text = troubleText(entry, context.version);
        if (text.body !== null) await this.file(context, entry, text.title, text.body, save);
      }
      await this.comment(context, entry, reads, save);
      await save();
    }
    this.entries = this.entries.filter((entry) => entry.open || entry.issues.length > 0 || Object.keys(entry.filing ?? {}).length > 0);
    await save();
  }

  /**
   * Posts each comment the entry's issues are owed. One Linear doesn't take stays owed for the next poll. `reads`
   * holds each issue as `sync` read it this poll, and an issue it couldn't read waits.
   */
  private async comment(context: SettleContext, entry: TroubleEntry, reads: Map<string, TrackerIssue>, save: () => Promise<void>): Promise<void> {
    const log = (message: string) => context.state.log(context.now, message);
    for (const issue of entry.issues) {
      const pending = issue.pending;
      const repo = context.repos.get(issue.repo);
      const read = reads.get(issue.id);
      if (pending === undefined || repo === undefined || read === undefined) continue;
      const { statusLine } = pending;
      const sentences = pending.kind === "cleared" ? pending.sentence : null;
      const body = runnerComment({ statusLine, sentences, flag: null, answers: null }, {}, { version: context.version, statuses: repo.statuses }).body;
      // A post can land without its response. A later try finds the comment an earlier try posted, and posts nothing.
      if (pending.tried && postedComment(read, { body, status_line: statusLine, since: pending.since }) !== undefined) {
        delete issue.pending;
        await save();
        continue;
      }
      // The reopened comment flags the issue again when it's no longer assigned.
      const flag = pending.kind === "reopened" && read.assignee === null;
      // The flag goes into issue memory before the write, at every try, because `sync` forgets it while unassigned.
      if (flag) await this.rememberFlag(context, issue);
      pending.tried = true;
      await save();
      const posted = await this.attempt(log, `${issue.identifier}: ${pending.kind} comment`, () => context.tracker.post({ id: issue.id, repo }, body, { flag }));
      if (posted === null) continue;
      if (flag) issue.flagged = true;
      delete issue.pending;
      await save();
    }
  }

  /**
   * Reads each of the entry's trouble issues. A closed or deleted one is forgotten, with its flag. An issue the
   * maintainer isn't assigned loses its flag. Returns each issue still open, as read.
   */
  private async sync(context: SettleContext, entry: TroubleEntry): Promise<Map<string, TrackerIssue>> {
    await this.adopt(context, entry);
    const reads = new Map<string, TrackerIssue>();
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
      // So does a flag whose assignment never landed, so `status.json` lists only issues waiting on the maintainer.
      // An assignee someone else set stays.
      if (read.assignee !== repo.maintainer) await this.forgetFlag(context.state, issue);
      reads.set(issue.id, read);
      kept.push(issue);
    }
    entry.issues = kept;
    return reads;
  }

  /**
   * Looks up each UUID saved before a create that never reported back. An issue Linear has joins the entry's
   * issues, and a UUID it doesn't have is dropped, because that create never landed. A lookup Linear doesn't take
   * keeps the UUID, and `file` files nothing in that repo until a lookup answers.
   */
  private async adopt(context: SettleContext, entry: TroubleEntry): Promise<void> {
    for (const [name, id] of Object.entries(entry.filing ?? {})) {
      const repo = context.repos.get(name);
      if (repo === undefined) continue;
      let read;
      try {
        read = await context.tracker.issue({ id, repo });
      } catch (error) {
        if (isUnavailable(error)) continue;
        if (!(error instanceof IssueNotFoundError)) throw error;
      }
      if (read !== undefined) entry.issues.push({ repo: name, id, identifier: read.identifier, url: read.url, title: read.title, flagged: false });
      delete entry.filing![name];
    }
  }

  /**
   * Makes sure each repo the entry affects has an open, flagged trouble issue. An issue owed the reopened comment
   * is left to `comment`, and no second issue is filed.
   */
  private async file(
    context: SettleContext,
    entry: TroubleEntry,
    title: string,
    body: string,
    save: () => Promise<void>,
  ): Promise<void> {
    const log = (message: string) => context.state.log(context.now, message);
    const targets = entry.scope === "runner" ? [...this.fileable] : entry.repos.filter((repo) => this.fileable.has(repo));
    for (const name of targets) {
      const repo = context.repos.get(name);
      if (repo === undefined) continue;
      let issue = entry.issues.find((each) => each.repo === name);
      if (issue?.pending?.kind === "reopened") continue;
      if (issue === undefined) {
        // A UUID still saved is a create whose lookup didn't answer this poll. It waits, so no UUID is created twice.
        const filing = (entry.filing ??= {});
        if (filing[name] !== undefined) continue;
        // The UUID is saved before the create, so a create whose response is lost isn't filed twice.
        const id = randomUUID();
        filing[name] = id;
        await save();
        const filed = await this.attempt(log, `${name}: trouble issue ${entry.cause}`, () => context.tracker.file({ id, repo, title, description: body }, "intake"));
        if (filed === null) continue;
        delete filing[name];
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
