// The Outbox checks a session's outbox and makes its writes in order (spec 1, "Outbox"). The runner calls
// `apply` after each session with the Flight Deck app's identity, and `flight-deck apply` with the maintainer's.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sessionParts } from "../folders/index.ts";
import { Lifecycle } from "../lifecycle/index.ts";
import type { Role } from "../record/index.ts";
import { readJson, writeJson, type OpenPause, type State } from "../state/index.ts";
import { IssueNotFoundError, isUnavailable, type IssueRef, type Tracker, type TrackerIssue, type TrackerRepo } from "../tracker/index.ts";
import type { SessionJson } from "../workspace/index.ts";
import { duplicateLine, followUpFooter, handoffComment, opening, sessionFooter, statusPhrase } from "./comment.ts";
import { readEnvelope } from "./envelope.ts";
import { contentType, embedImages, nameImages } from "./media.ts";
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
  /**
   * A kept outbox's replay, after a `retry` cleared the issue's flag. A pause whose comment landed before the
   * outbox was kept gets its flag back, with no second comment.
   */
  replay?: boolean;
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

/**
 * `applied.json` in the session folder: the name of each write that landed, in order, such as `post` or
 * `file follow-ups/1.md`, and what a later write needs from an earlier one, so a second apply skips the
 * writes that landed and still finishes the rest.
 */
interface Applied {
  writes: string[];
  /** Each follow-up's issue UUID, by its path in the outbox, saved before the create that uses it. */
  filed: Record<string, string>;
  /** Each image's upload URL, by its file name in `media/`, so each image is uploaded once. */
  uploads: Record<string, string>;
}

const nothingApplied = (): Applied => ({ writes: [], filed: {}, uploads: {} });

/** One write: its name in `applied.json`, and the write, which returns a broken rule or `null`. */
type Step = [string, (applied: Applied) => Promise<string | null>];

/** The status types of an open issue: factory statuses included, done, canceled, and duplicate not. */
const OPEN_TYPES = new Set(["backlog", "unstarted", "started", "triage"]);

/**
 * Whether the move to `to` landed: `applied.json` records it, or records the writes before it while the issue
 * already sits in `to`. A move can land without reaching `applied.json`, when its response or the journal write
 * is lost.
 */
function moveLanded(applied: readonly string[], role: Role | null, to: Role): boolean {
  const before = to === "ready_to_build" ? ["writeBrief", "post"] : ["post"];
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
      const applied = await readJson<Applied>(join(sessionFolder, "applied.json"), nothingApplied());
      if (applied.writes.length === 0) return false;
      const outcome = await readJson<{ move?: unknown }>(join(sessionParts(sessionFolder).outbox, "outcome.json"), {});
      return typeof outcome.move === "string" && moveLanded(applied.writes, role, outcome.move as Role);
    } catch {
      return false;
    }
  }

  /**
   * Checks the outbox, then makes each write that `applied.json` doesn't record yet. A read or write Linear
   * doesn't take (`TrackerUnavailable`) stops it with `unwritten` and the writes that landed, so a later apply
   * on the same folder finishes the rest.
   */
  async apply(sessionFolder: string, options: ApplyOptions): Promise<ApplyResult> {
    const writes: string[] = [];
    try {
      return await this.applyWrites(sessionFolder, options, writes);
    } catch (error) {
      if (isUnavailable(error)) return { result: "unwritten", writes };
      throw error;
    }
  }

  /** `apply`, pushing each write's name onto `writes` as it lands. */
  private async applyWrites(sessionFolder: string, options: ApplyOptions, writes: string[]): Promise<ApplyResult> {
    const session = JSON.parse(await readFile(sessionParts(sessionFolder).sessionJson, "utf8")) as SessionJson;
    const repo = this.options.repo(session.repo);
    if (repo === null) return { result: "failed", rule: `${session.repo} isn't registered on this Mac`, writes: [] };
    const tracker = options.identity;
    const lifecycle = new Lifecycle(tracker);
    const issue = await tracker.issue({ id: session.issue, repo });

    // A second apply skips the writes already recorded, so once the move has landed, the issue's status no longer
    // has to allow it.
    const appliedFile = join(sessionFolder, "applied.json");
    const applied = await readJson<Applied>(appliedFile, nothingApplied());
    const landed = (to: Role): boolean => moveLanded(applied.writes, issue.role, to);
    const checked = await readEnvelope(sessionParts(sessionFolder).outbox, {
      version: this.options.version,
      stage: session.stage,
      role: issue.role,
      lifecycle,
      moved: landed,
    });
    if (!checked.ok) return { result: "failed", rule: checked.rule, writes: [] };
    const { envelope } = checked;
    const { move, answers = [], needs } = envelope.outcome;

    let original: TrackerIssue | null = null;
    if (move === "duplicate" && !landed("duplicate")) {
      // Once the mark landed, the writes after it don't need the original, which may since have closed, moved to
      // another team, or been deleted, so the writes after the mark still land.
      const of = await originalOf(tracker, repo, issue, envelope.outcome.of ?? "");
      if (typeof of === "string") return { result: "failed", rule: of, writes: [] };
      original = of;
    }

    const ref: IssueRef = { id: issue.id, repo };
    const state = this.options.state;
    const phrase = statusPhrase(move, needs);
    const footer = sessionFooter(this.options.version, session.stage, session.session);
    // Each image is embedded once: in the description for a brief, whose fold then names it, and in the fold otherwise (ADR 0019).
    const handoff = envelope.handoff;
    const comment = (uploads: Applied["uploads"]) =>
      handoffComment({
        phrase,
        summary: envelope.summary === null ? null : embedImages(envelope.summary, uploads),
        ...(original === null ? {} : { line: duplicateLine(original) }),
        answers: answers.map((answer) => ({ word: answer.word, does: answer.does, status: repo.statuses[answer.move] })),
        handoff: handoff === null ? null : handoff.name === "brief.md" ? nameImages(handoff.text) : embedImages(handoff.text, uploads),
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
    const cause = move === "paused" ? "pause" : move === "duplicate" ? "duplicate" : "handoff";
    const moveStep: Step = [
      "move",
      async () => {
        if (landed(move)) return null;
        // The check refuses an issue with no role before any write, unless the move already landed.
        if (issue.role === null) return `${issue.identifier}'s status ${issue.status} maps to no role`;
        const of = original === null ? {} : { of: { id: original.id, repo } };
        const moved = await lifecycle.move({ ...ref, role: issue.role }, move, cause, of);
        return moved.ok ? null : moved.violation;
      },
    ];
    // A synced issue is detached before its brief and before a duplicate mark, so neither reaches GitHub (ADR 0008).
    const attachment = issue.sync_attachment;
    const detachSteps: Step[] = issue.synced && attachment !== null ? [["detach", async () => (await tracker.detach({ ...ref, sync_attachment: attachment }), null)]] : [];
    const postStep = (flag: boolean): Step => [
      "post",
      async (applied) => {
        if (posted === undefined) await tracker.post(ref, comment(applied.uploads), { flag });
        return null;
      },
    ];
    // Every image goes up first, so each write that names one can embed its URL.
    // The bytes are the ones the check read, so the upload never opens the session's path again.
    const uploadSteps: Step[] = envelope.images.map(({ name, data }): Step => [
      `upload ${name}`,
      async (applied) => {
        applied.uploads[name] = await tracker.upload({ name, contentType: contentType(name), data });
        return null;
      },
    ]);

    // Follow-up issues come last for every outcome, filed in the intake role and related, with no flag (ADRs 0007, 0011, and 0013).
    const followUpSteps: Step[] = envelope.followUps.flatMap((followUp): Step[] => [
      [
        `file ${followUp.name}`,
        async (applied) => {
          const footer = followUpFooter(this.options.version, session.stage);
          const text = embedImages(followUp.description, applied.uploads);
          const description = text === "" ? footer : `${text}\n\n${footer}`;
          // A create can land without reaching `applied.json`, when its response or the journal write is lost. The
          // issue's UUID is chosen and saved first, so a retry finds the issue it filed and doesn't file it twice.
          const id = applied.filed[followUp.name] ?? randomUUID();
          if (applied.filed[followUp.name] === undefined) {
            applied.filed[followUp.name] = id;
            await writeJson(appliedFile, applied);
          }
          const filed = await tracker.issue({ id, repo }).catch((error: unknown) => {
            if (error instanceof IssueNotFoundError) return null;
            throw error;
          });
          if (filed === null) await tracker.file({ id, repo, title: followUp.title, description }, "intake");
          return null;
        },
      ],
      [
        `relate ${followUp.name}`,
        async (applied) => {
          const filed = applied.filed[followUp.name];
          if (filed === undefined) return `applied.json lost the issue filed for ${followUp.name}`;
          try {
            await tracker.relate({ id: filed, repo }, ref, "related");
          } catch (error) {
            // A follow-up deleted since it was filed can't be related, and every other write still lands.
            if (!(error instanceof IssueNotFoundError)) throw error;
            await state.log(this.options.clock(), `${issue.identifier}: the issue filed for ${followUp.name} is gone, so it isn't related`);
          }
          return null;
        },
      ],
    ]);

    // The handoff before the move, so a stage never starts on an issue whose handoff is missing.
    let steps: Step[];
    if (move === "paused") {
      // A pause an earlier handoff opened, such as before a hand run took the paused issue back into Planning,
      // offered other answers, so this handoff starts a fresh one.
      const ownPause = (pause: OpenPause | null): OpenPause | null => (pause?.session === session.session ? pause : null);
      steps = [
        [
          "post",
          async (applied) => {
            // The flag and the pause go into issue memory before the comment. The flag keeps the next poll from
            // taking the assignee for one the runner didn't set. The open pause lets each snapshot keep a reply as
            // it first saw it, even while the move to Paused keeps failing. A retry keeps the replies saved so far.
            const since = this.options.clock().toISOString();
            const flag = { cause: "pause" as const, status_line: opening(phrase, envelope.summary).statusLine, since };
            const opened = await state.issueMemory(session.repo, issue.id);
            const pause = ownPause(opened.pause) ?? { answers, session: session.session, pending: true, comment_at: since, replies: [] };
            const flagged = { ...opened, flag: { ...flag, issue: issue.identifier, title: issue.title, url: issue.url } };
            await state.writeIssueMemory(session.repo, issue.id, { ...flagged, pause });
            const at = posted?.created_at ?? (await tracker.post(ref, comment(applied.uploads), { flag: true })).created_at;
            // A poll can save a reply while the post's response is on its way, as during a hand run, so this write
            // reads issue memory again. Only a comment after the pause comment is a reply.
            const memory = await state.issueMemory(session.repo, issue.id);
            const current = ownPause(memory.pause) ?? pause;
            const replies = current.replies.filter((reply) => reply.created_at > at);
            await state.writeIssueMemory(session.repo, issue.id, { ...memory, pause: { ...current, comment_at: at, replies } });
            return null;
          },
        ],
        moveStep,
        [
          "pause",
          async () => {
            // The issue first, so issue memory is read just before the write, with any reply a poll saved meanwhile.
            const read = await tracker.issue(ref);
            const reflag = options.replay === true && (await state.issueMemory(session.repo, issue.id)).flag === null;
            if (reflag) await tracker.flag(ref);
            const opened = await state.issueMemory(session.repo, issue.id);
            const memory = reflag
              ? {
                  ...opened,
                  flag: {
                    cause: "pause" as const,
                    status_line: opening(phrase, envelope.summary).statusLine,
                    since: this.options.clock().toISOString(),
                    issue: issue.identifier,
                    title: issue.title,
                    url: issue.url,
                  },
                }
              : opened;
            const pause = ownPause(memory.pause) ?? {
              answers,
              session: session.session,
              pending: true,
              comment_at: memory.flag?.since ?? this.options.clock().toISOString(),
              replies: [],
            };
            // A reply no snapshot has returned yet counts too. A reply a snapshot saw keeps the body it saw then.
            const known = new Set(pause.replies.map((reply) => reply.id));
            const unseen = repliesAfter(read, pause.comment_at).filter((reply) => !known.has(reply.id));
            const replies = [...pause.replies, ...unseen].sort((a, b) => a.created_at.localeCompare(b.created_at));
            await state.writeIssueMemory(session.repo, issue.id, { ...memory, pause: { ...pause, pending: false, replies } });
            return null;
          },
        ],
        ...followUpSteps,
      ];
    } else if (move === "duplicate") {
      steps = [...detachSteps, postStep(false), moveStep, ...followUpSteps];
    } else {
      const brief = handoff?.text ?? "";
      steps = [
        ...detachSteps,
        [
          "writeBrief",
          async (applied) => {
            // Issue memory keeps the brief as the description holds it, upload URLs and all, so a re-plan's
            // `previous-brief.md` differs from the description only where the maintainer edited it.
            const memory = await state.issueMemory(session.repo, issue.id);
            const embedded = embedImages(brief, applied.uploads);
            await tracker.writeBrief(ref, embedded, { runnerWroteBrief: memory.brief !== null });
            await state.writeIssueMemory(session.repo, issue.id, { ...memory, brief: embedded });
            return null;
          },
        ],
        postStep(false),
        moveStep,
        ...followUpSteps,
      ];
    }

    for (const [name, write] of [...uploadSteps, ...steps]) {
      if (applied.writes.includes(name)) continue;
      if (options.dryRun !== true) {
        const violation = await write(applied);
        if (violation !== null) return { result: "failed", rule: violation, writes };
        applied.writes.push(name);
        await writeJson(appliedFile, applied);
      }
      writes.push(name);
    }
    if (move === "paused") return { result: "paused", reason: opening(phrase, envelope.summary).statusLine, writes };
    return { result: "applied", writes };
  }
}

/**
 * The issue a duplicate's `of` names, or the broken rule: it must exist, sit on the same team, not be the issue
 * itself, and be open: its status type is backlog, unstarted, started, or triage.
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
