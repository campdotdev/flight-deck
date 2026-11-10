// The Outbox checks a session's outbox and makes its writes in order (spec 1, "Outbox"). The runner calls
// `apply` after each session with the Flight Deck app's identity, and `flight-deck apply` with the maintainer's.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sessionParts } from "../folders/index.ts";
import { Lifecycle } from "../lifecycle/index.ts";
import { readJson, writeJson, type State } from "../state/index.ts";
import { IssueNotFoundError, type IssueRef, type Tracker, type TrackerIssue, type TrackerRepo } from "../tracker/index.ts";
import type { SessionJson } from "../workspace/index.ts";
import { duplicateLine, handoffComment, opening, sessionFooter, statusPhrase } from "./comment.ts";
import { readEnvelope } from "./envelope.ts";

export type ApplyResult =
  /** Every write landed. */
  | { result: "applied"; writes: string[] }
  /** A rule broke, so nothing more was written. A failed apply is a failed session. */
  | { result: "failed"; rule: string; writes: string[] }
  /** The issue paused: the outbox's pause, or the runner's own. */
  | { result: "paused"; reason: string; writes: string[] }
  /** A Linear write failed for a network error, a 5xx, or `RATELIMITED`. It lists the writes that landed. */
  | { result: "unwritten"; writes: string[] };

export interface ApplyOptions {
  /** The Tracker adapter, acting as the identity the writes go out as. */
  identity: Tracker;
  /** Make no write. The result lists each one. */
  dryRun?: boolean;
}

export interface OutboxOptions {
  /** The running version. */
  version: string;
  state: State;
  /** The time a flag starts. */
  clock: () => Date;
  /** The repo a session ran for, as the Tracker needs it, or `null` when this Mac hasn't registered it. */
  repo(name: string): TrackerRepo | null;
}

/** The name `applied.json` records for each write. */
type WriteName = "detach" | "writeBrief" | "post" | "move" | "pause";
type Step = [WriteName, () => Promise<string | null>];

/** The status types of an open issue: factory statuses included, done, canceled, and duplicate not. */
const OPEN_TYPES = new Set(["backlog", "unstarted", "started", "triage"]);

export class Outbox {
  constructor(private readonly options: OutboxOptions) {}

  async apply(sessionFolder: string, options: ApplyOptions): Promise<ApplyResult> {
    const session = JSON.parse(await readFile(sessionParts(sessionFolder).sessionJson, "utf8")) as SessionJson;
    const repo = this.options.repo(session.repo);
    if (repo === null) return { result: "failed", rule: `${session.repo} isn't registered on this Mac`, writes: [] };
    const tracker = options.identity;
    const lifecycle = new Lifecycle(tracker);
    const read = await tracker.issue({ id: session.issue, repo });
    const role = read.role;
    if (role === null) return { result: "failed", rule: `${read.identifier}'s status ${read.status} has no role in ${repo.name}'s record`, writes: [] };
    const issue = { ...read, role };

    const checked = await readEnvelope(sessionParts(sessionFolder).outbox, {
      version: this.options.version,
      stage: session.stage,
      role: issue.role,
      lifecycle,
    });
    if (!checked.ok) return { result: "failed", rule: checked.rule, writes: [] };
    const { envelope } = checked;
    const { move, answers = [], needs } = envelope.outcome;

    let original: TrackerIssue | null = null;
    if (move === "duplicate") {
      const of = await originalOf(tracker, repo, issue, envelope.outcome.of ?? "");
      if (typeof of === "string") return { result: "failed", rule: of, writes: [] };
      original = of;
    }

    const ref: IssueRef = { id: issue.id, repo };
    const state = this.options.state;
    const phrase = statusPhrase(move, needs);
    const comment = handoffComment({
      phrase,
      summary: envelope.summary,
      ...(original === null ? {} : { line: duplicateLine(original) }),
      answers: answers.map((answer) => ({ word: answer.word, does: answer.does, status: repo.statuses[answer.move] })),
      handoff: envelope.handoff?.text ?? null,
      footer: sessionFooter(this.options.version, session.stage, session.session),
    });
    const cause = move === "paused" ? "pause" : move === "duplicate" ? "duplicate" : "handoff";
    const moveStep: Step = [
      "move",
      async () => {
        const of = original === null ? {} : { of: { id: original.id, repo } };
        const moved = await lifecycle.move({ ...ref, role: issue.role }, move, cause, of);
        return moved.ok ? null : moved.violation;
      },
    ];
    // A synced issue is detached before its brief and before a duplicate mark, so neither reaches GitHub (ADR 0008).
    const attachment = issue.sync_attachment;
    const detachSteps: Step[] = issue.synced && attachment !== null ? [["detach", async () => (await tracker.detach({ ...ref, sync_attachment: attachment }), null)]] : [];
    const postStep = (flag: boolean): Step => ["post", async () => (await tracker.post(ref, comment, { flag }), null)];

    // The handoff before the move, so a stage never starts on an issue whose handoff is missing.
    let steps: Step[];
    if (move === "paused") {
      let commentAt: string | null = null;
      steps = [
        [
          "post",
          async () => {
            // The flag goes into issue memory first, so the next poll never takes the assignee for one the runner didn't set.
            const flag = { cause: "pause" as const, status_line: opening(phrase, envelope.summary).statusLine, since: this.options.clock().toISOString() };
            const memory = await state.issueMemory(session.repo, issue.id);
            await state.writeIssueMemory(session.repo, issue.id, { ...memory, flag: { ...flag, issue: issue.identifier, title: issue.title, url: issue.url } });
            commentAt = (await tracker.post(ref, comment, { flag: true })).created_at;
            return null;
          },
        ],
        moveStep,
        [
          "pause",
          async () => {
            const memory = await state.issueMemory(session.repo, issue.id);
            // A resumed apply lost the comment's time, and the flag's start comes just before it.
            const at = commentAt ?? memory.flag?.since ?? this.options.clock().toISOString();
            await state.writeIssueMemory(session.repo, issue.id, { ...memory, pause: { answers, comment_at: at, replies: [] } });
            return null;
          },
        ],
      ];
    } else if (move === "duplicate") {
      steps = [...detachSteps, postStep(false), moveStep];
    } else {
      const brief = envelope.handoff?.text ?? "";
      steps = [
        ...detachSteps,
        [
          "writeBrief",
          async () => {
            const memory = await state.issueMemory(session.repo, issue.id);
            await tracker.writeBrief(ref, brief, { runnerWroteBrief: memory.brief !== null });
            await state.writeIssueMemory(session.repo, issue.id, { ...memory, brief });
            return null;
          },
        ],
        postStep(false),
        moveStep,
      ];
    }

    const appliedFile = join(sessionFolder, "applied.json");
    const applied = await readJson<WriteName[]>(appliedFile, []);
    const writes: string[] = [];
    for (const [name, write] of steps) {
      if (applied.includes(name)) continue;
      if (options.dryRun !== true) {
        const violation = await write();
        if (violation !== null) return { result: "failed", rule: violation, writes };
        applied.push(name);
        await writeJson(appliedFile, applied);
      }
      writes.push(name);
    }
    if (move === "paused") return { result: "paused", reason: opening(phrase, envelope.summary).statusLine, writes };
    return { result: "applied", writes };
  }
}

/**
 * The open issue a duplicate's `of` names, or the broken rule: it must exist, sit on the same team, be open
 * (its status type is backlog, unstarted, started, or triage), and not be the issue itself.
 */
async function originalOf(tracker: Tracker, repo: TrackerRepo, issue: TrackerIssue, of: string): Promise<TrackerIssue | string> {
  let original: TrackerIssue;
  try {
    original = await tracker.issue({ id: of, repo });
  } catch (error) {
    if (error instanceof IssueNotFoundError) return `outcome.json's of ${of} names no issue Flight Deck can read`;
    throw error;
  }
  if (original.id === issue.id) return `outcome.json's of ${of} is the issue itself`;
  if (original.team !== repo.team) return `outcome.json's of ${of} is on team ${original.team}, not ${repo.team}`;
  if (!OPEN_TYPES.has(original.status_type)) return `outcome.json's of ${of} is in ${original.status}, which isn't open`;
  return original;
}
