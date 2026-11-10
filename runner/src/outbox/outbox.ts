// The Outbox checks a session's outbox and makes its writes in order (spec 1, "Outbox"). The runner calls
// `apply` after each session with the Flight Deck app's identity, and `flight-deck apply` with the maintainer's.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sessionParts } from "../folders/index.ts";
import { Lifecycle } from "../lifecycle/index.ts";
import { readJson, writeJson, type State } from "../state/index.ts";
import type { IssueRef, Tracker, TrackerRepo } from "../tracker/index.ts";
import type { SessionJson } from "../workspace/index.ts";
import { handoffComment, sessionFooter, statusPhrase } from "./comment.ts";
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
  /** The repo a session ran for, as the Tracker needs it, or `null` when this Mac hasn't registered it. */
  repo(name: string): TrackerRepo | null;
}

/** The name `applied.json` records for each write, in the order `ready_to_build` makes them. */
type WriteName = "writeBrief" | "post" | "move";

export class Outbox {
  constructor(private readonly options: OutboxOptions) {}

  async apply(sessionFolder: string, options: ApplyOptions): Promise<ApplyResult> {
    const session = JSON.parse(await readFile(sessionParts(sessionFolder).sessionJson, "utf8")) as SessionJson;
    const repo = this.options.repo(session.repo);
    if (repo === null) return { result: "failed", rule: `${session.repo} isn't registered on this Mac`, writes: [] };
    const tracker = options.identity;
    const lifecycle = new Lifecycle(tracker);
    const issue = await tracker.issue({ id: session.issue, repo });

    const checked = await readEnvelope(sessionParts(sessionFolder).outbox, {
      version: this.options.version,
      stage: session.stage,
      role: issue.role,
      lifecycle,
    });
    if (!checked.ok) return { result: "failed", rule: checked.rule, writes: [] };
    const { envelope } = checked;

    const ref: IssueRef = { id: issue.id, repo };
    const memory = await this.options.state.issueMemory(session.repo, issue.id);
    const comment = handoffComment({
      phrase: statusPhrase(envelope.outcome.move),
      summary: envelope.summary,
      handoff: envelope.handoff.text,
      footer: sessionFooter(this.options.version, session.stage, session.session),
    });

    // The handoff before the move, so a stage never starts on an issue whose handoff is missing.
    const steps: [WriteName, () => Promise<string | null>][] = [
      [
        "writeBrief",
        async () => {
          await tracker.writeBrief(ref, envelope.handoff.text, { runnerWroteBrief: memory.brief !== null });
          await this.options.state.writeIssueMemory(session.repo, issue.id, { ...memory, brief: envelope.handoff.text });
          return null;
        },
      ],
      ["post", async () => (await tracker.post(ref, comment, { flag: false }), null)],
      [
        "move",
        async () => {
          const moved = await lifecycle.move({ ...ref, role: issue.role }, envelope.outcome.move, "handoff");
          return moved.ok ? null : moved.violation;
        },
      ],
    ];

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
    return { result: "applied", writes };
  }
}
