// The Outbox checks a session's outbox and makes its writes in order (spec 1, "Outbox"). The runner calls
// `apply` after each session with the Flight Deck app's identity, and `flight-deck apply` with the maintainer's.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sessionParts } from "../folders/index.ts";
import { Lifecycle } from "../lifecycle/index.ts";
import { readJson, writeJson, type IssueMemory, type State } from "../state/index.ts";
import { IssueNotFoundError, isUnavailable, type IssueRef, type Tracker, type TrackerIssue, type TrackerRepo } from "../tracker/index.ts";
import type { SessionJson } from "../workspace/index.ts";
import { duplicateLine, followUpFooter, handoffComment, opening, sessionFooter, statusPhrase } from "./comment.ts";
import { readEnvelope } from "./envelope.ts";
import { contentType, embedImages, nameImages } from "./media.ts";

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
  /** Called with each write's name as it lands, or, on a dry run, as it would. */
  onWrite?: (name: string) => void;
}

/** Where the Outbox's writes to issue memory go. The runner writes the file, and a hand run asks the runner. */
export interface IssueMemoryWrites {
  /** Merges the fields over the issue's memory. */
  write(repo: string, uuid: string, fields: Partial<IssueMemory>): Promise<void>;
}

export interface OutboxOptions {
  /** The running version. */
  version: string;
  state: State;
  /** The time a flag starts. */
  clock: () => Date;
  /** The repo a session ran for, as the Tracker needs it, or `null` when this Mac hasn't registered it. */
  repo(name: string): TrackerRepo | null;
  /** Where issue memory's writes go. `state`'s files by default. Reads always come from `state`. */
  memory?: IssueMemoryWrites;
}

/**
 * `applied.json` in the session folder: the name of each write that landed, in order, such as `post` or
 * `file follow-ups/1.md`, and what a later write needs from an earlier one, so a second apply skips the
 * writes that landed and still finishes the rest.
 */
interface Applied {
  writes: string[];
  /** Each follow-up's filed issue UUID, by its path in the outbox. */
  filed: Record<string, string>;
  /** Each image's upload URL, by its file name in `media/`, so each image is uploaded once. */
  uploads: Record<string, string>;
}

/** One write: its name in `applied.json`, and the write, which returns a broken rule or `null`. */
type Step = [string, (applied: Applied) => Promise<string | null>];

/** The status types of an open issue: factory statuses included, done, canceled, and duplicate not. */
const OPEN_TYPES = new Set(["backlog", "unstarted", "started", "triage"]);

export class Outbox {
  private readonly memory: IssueMemoryWrites;

  constructor(private readonly options: OutboxOptions) {
    const state = options.state;
    this.memory = options.memory ?? { write: async (repo, uuid, fields) => state.writeIssueMemory(repo, uuid, { ...(await state.issueMemory(repo, uuid)), ...fields }) };
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
    const read = await tracker.issue({ id: session.issue, repo });
    const role = read.role;
    if (role === null) return { result: "failed", rule: `${read.identifier}'s status ${read.status} has no role in ${repo.name}'s record`, writes: [] };
    const issue = { ...read, role };

    const appliedFile = join(sessionFolder, "applied.json");
    const applied = await readJson<Applied>(appliedFile, { writes: [], filed: {}, uploads: {} });
    const checked = await readEnvelope(sessionParts(sessionFolder).outbox, {
      version: this.options.version,
      stage: session.stage,
      role: issue.role,
      lifecycle,
      moved: applied.writes.includes("move"),
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
    // Each image is embedded once: in the description for a brief, whose fold then names it, and in the fold otherwise (ADR 0019).
    const handoff = envelope.handoff;
    const comment = (uploads: Applied["uploads"]) =>
      handoffComment({
        phrase,
        summary: envelope.summary === null ? null : embedImages(envelope.summary, uploads),
        ...(original === null ? {} : { line: duplicateLine(original) }),
        answers: answers.map((answer) => ({ word: answer.word, does: answer.does, status: repo.statuses[answer.move] })),
        handoff: handoff === null ? null : handoff.name === "brief.md" ? nameImages(handoff.text) : embedImages(handoff.text, uploads),
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
    const postStep = (flag: boolean): Step => ["post", async (applied) => (await tracker.post(ref, comment(applied.uploads), { flag }), null)];
    // Every image goes up first, so each write that names one can embed its URL.
    const uploadSteps: Step[] = envelope.images.map((name): Step => [
      `upload ${name}`,
      async (applied) => {
        const data = new Uint8Array(await readFile(join(sessionParts(sessionFolder).outbox, "media", name)));
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
          applied.filed[followUp.name] = (await tracker.file({ repo, title: followUp.title, description }, "intake")).id;
          return null;
        },
      ],
      [
        `relate ${followUp.name}`,
        async (applied) => {
          const filed = applied.filed[followUp.name];
          if (filed === undefined) return `applied.json lost the issue filed for ${followUp.name}`;
          await tracker.relate({ id: filed, repo }, ref, "related");
          return null;
        },
      ],
    ]);

    // The handoff before the move, so a stage never starts on an issue whose handoff is missing.
    let steps: Step[];
    if (move === "paused") {
      let commentAt: string | null = null;
      steps = [
        [
          "post",
          async (applied) => {
            // The flag goes into issue memory first, so the next poll never takes the assignee for one the runner didn't set.
            const flag = { cause: "pause" as const, status_line: opening(phrase, envelope.summary).statusLine, since: this.options.clock().toISOString() };
            await this.memory.write(session.repo, issue.id, { flag: { ...flag, issue: issue.identifier, title: issue.title, url: issue.url } });
            commentAt = (await tracker.post(ref, comment(applied.uploads), { flag: true })).created_at;
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
            await this.memory.write(session.repo, issue.id, { pause: { answers, comment_at: at, replies: [] } });
            return null;
          },
        ],
        ...followUpSteps,
      ];
    } else if (move === "duplicate") {
      steps = [...detachSteps, postStep(false), moveStep, ...followUpSteps];
    } else {
      const brief = envelope.handoff?.text ?? "";
      steps = [
        ...detachSteps,
        [
          "writeBrief",
          async (applied) => {
            const memory = await state.issueMemory(session.repo, issue.id);
            await tracker.writeBrief(ref, embedImages(brief, applied.uploads), { runnerWroteBrief: memory.brief !== null });
            await this.memory.write(session.repo, issue.id, { brief });
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
      options.onWrite?.(name);
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
