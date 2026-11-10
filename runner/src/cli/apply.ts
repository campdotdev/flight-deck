// `flight-deck apply [--dry-run] <folder>` (spec 1, "Hand runs", ADRs 0007, 0015, and 0017): a hand run's outbox,
// applied by the same `Outbox.apply` the runner calls, as the maintainer through their setup key. It prints
// each write as it lands, and exits 0 for `applied` and `paused`, 1 for `failed`, 2 when it refuses before any
// write, and 75 for `unwritten`, which a rerun finishes.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { paths, sessionParts } from "../folders/index.ts";
import { readConfig, readCredentials, workspaceKey, type Registration } from "../install/index.ts";
import { Outbox } from "../outbox/index.ts";
import { trackerRepo } from "../poll/index.ts";
import { readRecord, resolveSlots, type RepoRecord } from "../record/index.ts";
import { State } from "../state/index.ts";
import { Workspace } from "../workspace/index.ts";
import { ANSWER_MS, type CommandContext } from "./context.ts";
import { handRunMemory } from "./issue-memory.ts";

const RECORD_PATH = ".flight-deck/record.toml";

/** Exit codes (spec 1, "Hand runs"). 75 is `EX_TEMPFAIL`: run it again. */
const EXIT = { applied: 0, paused: 0, failed: 1, refused: 2, unwritten: 75 } as const;

class Refusal extends Error {}

export async function applyCommand(argv: string[], context: CommandContext): Promise<number> {
  const dryRun = argv.includes("--dry-run");
  const rest = argv.filter((arg) => arg !== "--dry-run");
  if (rest.length !== 1) {
    context.err("Usage: flight-deck apply [--dry-run] <folder>");
    return 64;
  }
  const folder = resolve(rest[0]!);
  try {
    return await apply(folder, dryRun, context);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    context.err(`Refused: ${error.message}`);
    return EXIT.refused;
  }
}

async function apply(folder: string, dryRun: boolean, context: CommandContext): Promise<number> {
  const session = await readSession(folder);
  // The Outbox fails another version's outbox like any broken rule. A hand run refuses it before any write and
  // names the version that wrote it (ADR 0015).
  const outcome = await readFile(join(sessionParts(folder).outbox, "outcome.json"), "utf8").then(
    (text) => JSON.parse(text) as { version?: unknown; move?: unknown },
    () => null,
  );
  if (outcome !== null && typeof outcome.version === "string" && outcome.version !== context.version) {
    throw new Refusal(`Flight Deck ${outcome.version} wrote this outbox, and this is Flight Deck ${context.version}. Run the hand run again with Flight Deck ${context.version}.`);
  }

  const config = await readConfig(context.folders);
  // The secret scan's exact-value match needs the registration's copied files.
  const registration = config.repos.find((repo) => repo.name === session.repo);
  if (registration === undefined) throw new Refusal(`${session.repo} isn't registered on this Mac. Run flight-deck register ${session.repo} first.`);
  const record = await validRecord(context, registration, config.paths.git);
  const repo = trackerRepo(config, registration, record);
  const workspace = record.tracker.workspace;
  if (repo === null) throw new Refusal(`config.toml has no Linear login for ${workspace}. Run flight-deck login linear ${workspace} first.`);
  const setupKey = (await readCredentials(context.folders))?.values[`LINEAR_SETUP_KEY_${workspaceKey(workspace)}`];
  if (setupKey === undefined || setupKey === "") throw new Refusal(`credentials.env holds no setup key for ${workspace}. Run flight-deck login linear ${workspace} first.`);

  const outbox = new Outbox({
    version: context.version,
    state: new State(context.folders),
    clock: context.clock,
    repo: (name) => (name === registration.name ? repo : null),
    memory: handRunMemory(context.folders, context.answerMs ?? ANSWER_MS),
  });
  const result = await outbox.apply(folder, {
    identity: context.adapters.maintainerTracker({ folders: context.folders, workspace, setupKey }),
    dryRun,
    onWrite: (name) => context.out(dryRun ? `Would write ${name}.` : `Wrote ${name}.`),
  });
  switch (result.result) {
    case "applied":
    case "paused":
      if (dryRun) context.out("Dry run: no write made.");
      else if (result.result === "paused") context.out(`Paused: ${result.reason}`);
      else context.out(`Applied: ${session.issue} moved to ${typeof outcome?.move === "string" ? (repo.statuses[outcome.move as keyof typeof repo.statuses] ?? outcome.move) : "its next status"}.`);
      return EXIT[result.result];
    case "failed":
      context.err(`Refused: ${result.rule}`);
      return EXIT.failed;
    case "unwritten":
      context.err(`Linear didn't take a write. Run flight-deck apply ${folder} again: it skips the writes already made.`);
      return EXIT.unwritten;
  }
}

async function readSession(folder: string): Promise<{ repo: string; issue: string }> {
  const text = await readFile(sessionParts(folder).sessionJson, "utf8").catch(() => null);
  if (text === null) throw new Refusal(`${folder} holds no session.json.`);
  let session: unknown;
  try {
    session = JSON.parse(text);
  } catch {
    throw new Refusal(`${sessionParts(folder).sessionJson} isn't JSON.`);
  }
  const { repo, issue } = (session ?? {}) as { repo?: unknown; issue?: unknown };
  if (typeof repo !== "string" || typeof issue !== "string") throw new Refusal(`${sessionParts(folder).sessionJson} names no repo and issue.`);
  return { repo, issue };
}

/**
 * The record on the default branch, as the runner's last fetch left Flight Deck's clone, with every slot entry
 * resolved, as the runner reads it before a session. A missing or invalid record refuses the apply.
 */
async function validRecord(context: CommandContext, registration: Registration, git: string): Promise<RepoRecord> {
  if (!existsSync(join(paths.clone(context.folders, registration.name), ".git"))) {
    throw new Refusal(`Flight Deck has no clone of ${registration.name} yet, so it can't read the record. Wait for the runner's next poll.`);
  }
  const workspace = new Workspace({ folders: context.folders, git });
  const branch = await workspace.branch(registration);
  const commit = await workspace.head(registration);
  const text = await workspace.show(registration, commit, RECORD_PATH);
  if (text === null) throw new Refusal(`${branch} holds no ${RECORD_PATH}. Commit the record first.`);
  const read = readRecord(text);
  const resolved = !read.ok
    ? read
    : await resolveSlots(read.record, {
        commit,
        shipped: (name) => existsSync(join(context.versionFolder, "skills", name, "SKILL.md")),
        inRepo: async (path) => (await workspace.show(registration, commit, `${path}/SKILL.md`)) !== null,
      });
  if (!resolved.ok) throw new Refusal(`the record on ${branch} isn't valid: ${resolved.errors[0]}`);
  return resolved.record;
}
