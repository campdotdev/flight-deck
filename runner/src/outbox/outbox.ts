// The Outbox checks a session's outbox and makes its writes in order (spec 1, "Outbox"). The runner calls
// `apply` after each session with the Flight Deck app's identity, and `flight-deck apply` with the maintainer's.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sessionParts } from "../folders/index.ts";
import { Lifecycle } from "../lifecycle/index.ts";
import type { Role } from "../record/index.ts";
import { readJson, writeJson, type State } from "../state/index.ts";
import type { IssueRef, Tracker, TrackerRepo } from "../tracker/index.ts";
import type { SessionJson } from "../workspace/index.ts";
import { handoffComment, opening, sessionFooter, statusPhrase } from "./comment.ts";
import { readEnvelope } from "./envelope.ts";
import { repliesAfter } from "./replies.ts";

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
type WriteName = "writeBrief" | "post" | "move" | "pause";

/**
 * Whether the move to `to` landed: `applied.json` records it, or records the writes before it while the issue
 * already sits in `to`. A move can land without reaching `applied.json`, when its response or the journal write
 * is lost.
 */
function moveLanded(applied: readonly WriteName[], role: Role | null, to: Role): boolean {
  const before: WriteName[] = to === "paused" ? ["post"] : ["writeBrief", "post"];
  return applied.includes("move") || (before.every((name) => applied.includes(name)) && role === to);
}

export class Outbox {
  constructor(private readonly options: OutboxOptions) {}

  /**
   * Whether an earlier apply of the session's outbox moved its issue, which now has `role`. Poll applies such an
   * outbox again, though the issue left the working status, so the writes after the move still land.
   */
  static async moved(sessionFolder: string, role: Role | null): Promise<boolean> {
    try {
      const applied = await readJson<WriteName[]>(join(sessionFolder, "applied.json"), []);
      if (applied.length === 0) return false;
      const outcome = await readJson<{ move?: unknown }>(join(sessionParts(sessionFolder).outbox, "outcome.json"), {});
      return typeof outcome.move === "string" && moveLanded(applied, role, outcome.move as Role);
    } catch {
      return false;
    }
  }

  async apply(sessionFolder: string, options: ApplyOptions): Promise<ApplyResult> {
    const session = JSON.parse(await readFile(sessionParts(sessionFolder).sessionJson, "utf8")) as SessionJson;
    const repo = this.options.repo(session.repo);
    if (repo === null) return { result: "failed", rule: `${session.repo} isn't registered on this Mac`, writes: [] };
    const tracker = options.identity;
    const lifecycle = new Lifecycle(tracker);
    const issue = await tracker.issue({ id: session.issue, repo });

    // A second apply skips the writes already recorded, so once the move has landed, the issue's status no longer
    // has to allow it.
    const appliedFile = join(sessionFolder, "applied.json");
    const applied = await readJson<WriteName[]>(appliedFile, []);
    const landed = (to: Role): boolean => moveLanded(applied, issue.role, to);
    const checked = await readEnvelope(sessionParts(sessionFolder).outbox, {
      version: this.options.version,
      stage: session.stage,
      role: issue.role,
      lifecycle,
      moved: landed,
    });
    if (!checked.ok) return { result: "failed", rule: checked.rule, writes: [] };
    const { envelope } = checked;

    const ref: IssueRef = { id: issue.id, repo };
    const state = this.options.state;
    const { move, answers = [], needs } = envelope.outcome;
    const phrase = statusPhrase(move, needs);
    const footer = sessionFooter(this.options.version, session.stage, session.session);
    const comment = handoffComment({
      phrase,
      summary: envelope.summary,
      answers: answers.map((answer) => ({ word: answer.word, does: answer.does, status: repo.statuses[answer.move] })),
      handoff: envelope.handoff.text,
      footer,
    });
    // A post can land without reaching `applied.json`, when its response or the journal write is lost. The footer
    // names the session, so a retry finds the comment it already posted and doesn't post it twice. The post is
    // always a top-level Linear comment, so a reply or a comment through the GitHub sync, which anyone who can
    // comment on the GitHub issue can write, never counts. The author doesn't count either: the runner's post and
    // a hand `flight-deck apply` of the same session go out as different users.
    const posted = issue.comments.find(
      ({ body, synced, parent }) => !synced && parent === null && body.split("\n").some((line) => line.trim() === footer),
    );
    const moveStep: [WriteName, () => Promise<string | null>] = [
      "move",
      async () => {
        if (landed(move)) return null;
        // The check refuses an issue with no role before any write, unless the move already landed.
        if (issue.role === null) return `${issue.identifier}'s status ${issue.status} maps to no role`;
        const moved = await lifecycle.move({ ...ref, role: issue.role }, move, move === "paused" ? "pause" : "handoff");
        return moved.ok ? null : moved.violation;
      },
    ];

    // The handoff before the move, so a stage never starts on an issue whose handoff is missing.
    let steps: [WriteName, () => Promise<string | null>][];
    if (move === "paused") {
      steps = [
        [
          "post",
          async () => {
            // The flag and the pause go into issue memory before the comment. The flag keeps the next poll from
            // taking the assignee for one the runner didn't set. The open pause lets each snapshot keep a reply as
            // it first saw it, even while the move to Paused keeps failing. A retry keeps the replies saved so far.
            const since = this.options.clock().toISOString();
            const flag = { cause: "pause" as const, status_line: opening(phrase, envelope.summary).statusLine, since };
            const memory = await state.issueMemory(session.repo, issue.id);
            const pause = memory.pause ?? { answers, comment_at: since, replies: [] };
            const flagged = { ...memory, flag: { ...flag, issue: issue.identifier, title: issue.title, url: issue.url } };
            await state.writeIssueMemory(session.repo, issue.id, { ...flagged, pause });
            const at = posted?.created_at ?? (await tracker.post(ref, comment, { flag: true })).created_at;
            // Only a comment after the pause comment is a reply.
            const replies = pause.replies.filter((reply) => reply.created_at > at);
            await state.writeIssueMemory(session.repo, issue.id, { ...flagged, pause: { ...pause, comment_at: at, replies } });
            return null;
          },
        ],
        moveStep,
        [
          "pause",
          async () => {
            const memory = await state.issueMemory(session.repo, issue.id);
            const pause = memory.pause ?? { answers, comment_at: memory.flag?.since ?? this.options.clock().toISOString(), replies: [] };
            // A reply no snapshot has returned yet counts too. A reply a snapshot saw keeps the body it saw then.
            const known = new Set(pause.replies.map((reply) => reply.id));
            const unseen = repliesAfter(await tracker.issue(ref), pause.comment_at).filter((reply) => !known.has(reply.id));
            const replies = [...pause.replies, ...unseen].sort((a, b) => a.created_at.localeCompare(b.created_at));
            await state.writeIssueMemory(session.repo, issue.id, { ...memory, pause: { ...pause, replies } });
            return null;
          },
        ],
      ];
    } else {
      steps = [
        [
          "writeBrief",
          async () => {
            const memory = await state.issueMemory(session.repo, issue.id);
            await tracker.writeBrief(ref, envelope.handoff.text, { runnerWroteBrief: memory.brief !== null });
            await state.writeIssueMemory(session.repo, issue.id, { ...memory, brief: envelope.handoff.text });
            return null;
          },
        ],
        [
          "post",
          async () => {
            if (posted === undefined) await tracker.post(ref, comment, { flag: false });
            return null;
          },
        ],
        moveStep,
      ];
    }

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
