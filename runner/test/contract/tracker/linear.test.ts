// The Tracker contract suite's Linear half: the same assertions as `memory.test.ts`, against real Linear, on scratch
// issues on the Shaders team that the maintainer's identity cancels afterwards (spec 1, "Suites"). Its detach test
// opens one GitHub issue on Shaders through the maintainer's own `gh` and closes it afterwards.
//
// It needs the maintainer's credentials, so it runs only with `FLIGHT_DECK_CONTRACT=tracker` (or `1`): see
// `test/contract/README.md`. It also records, in `test/tracker/fixtures/linear-contract.json`, what real Linear
// returned for each fact FLD-111's adapter assumed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IssueRef, TrackerRepo } from "../../../src/tracker/index.ts";
import { runs } from "../support/gate.ts";
import { eventually, GITHUB_REPO, graphql, openLinear, TEAM, WORKSPACE, type RealLinear } from "../support/linear.ts";
import { trackerContract } from "./contract.ts";
import * as Q from "./linear-queries.ts";

const RUNS = runs("tracker");
const FINDINGS = join(import.meta.dir, "../../tracker/fixtures/linear-contract.json");
/** How long Linear's GitHub Issues Sync may take to bring an issue or a comment over. */
const SYNC_MS = 5 * 60_000;

/** What real Linear returned, by fact. Written once the file's tests end. */
const findings: Record<string, unknown> = {};
let linear: RealLinear | null = null;

async function real(): Promise<RealLinear> {
  linear ??= await openLinear();
  return linear;
}

/** The maintainer's own `gh`, never the machine user's config folder. */
function gh(...args: string[]): string {
  const env = { ...process.env };
  delete env.GH_CONFIG_DIR;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  const result = Bun.spawnSync(["gh", ...args], { env, stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error(`gh ${args[0]} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
}

afterAll(async () => {
  if (!RUNS || Object.keys(findings).length === 0) return;
  await writeFile(FINDINGS, `${JSON.stringify({ recorded_at: new Date().toISOString(), workspace: WORKSPACE, team: TEAM, ...findings }, null, 2)}\n`);
  console.log(`\nWrote what real Linear returned to ${FINDINGS}. Commit it, and see test/contract/README.md for what each fact means.`);
});

trackerContract(
  "the Linear adapter",
  async () => {
    const l = await real();
    let github: string | null = null;
    let synced: IssueRef | null = null;
    return {
      runner: l.runner,
      maintainer: l.maintainer,
      repo: l.repo,
      wait: (ms) => Bun.sleep(ms),
      now: () => new Date(),
      async syncedIssue() {
        const title = `Flight Deck contract suite: a synced scratch issue (${new Date().toISOString().slice(0, 16)})`;
        console.log(`Opening a GitHub issue on ${GITHUB_REPO} as ${gh("api", "user", "--jq", ".login")}, the maintainer's own gh login.`);
        github = gh("issue", "create", "--repo", GITHUB_REPO, "--title", title, "--body", "The Flight Deck Tracker contract suite opened this issue to test the GitHub sync. It closes it when the suite ends.");
        const node = await eventually(
          "Linear's GitHub sync bringing the issue over",
          async () => ((await l.query(Q.ISSUE_BY_TITLE, { team: TEAM, title })).issues.nodes as { id: string; identifier: string }[])[0],
          SYNC_MS,
        );
        synced = { id: node.id, repo: l.repo };
        const body = `A comment on GitHub (${Date.now()}).`;
        gh("issue", "comment", github, "--body", body);
        const facts = await eventually(
          "Linear's GitHub sync bringing the comment over",
          async () => {
            const issue = (await l.query(Q.SYNC_FACTS, { id: node.id })).issue as SyncFacts;
            return issue.comments.nodes.some((each) => each.body.includes(body)) ? issue : null;
          },
          SYNC_MS,
        );
        const comment = facts.comments.nodes.find((each) => each.body.includes(body))!;
        findings.synced_issue = {
          identifier: node.identifier,
          github,
          syncedWith: facts.syncedWith,
          attachments: facts.attachments.nodes,
          attachment_id_is_syncedWith_id: facts.attachments.nodes.some((each) => (facts.syncedWith ?? []).some((info) => info.id === each.id)),
        };
        findings.synced_comment = {
          note: "The adapter reads a comment as synced when externalUser is set or syncedWith is non-empty. This is which one Linear set.",
          externalUser: comment.externalUser,
          syncedWith: comment.syncedWith,
          user: comment.user,
        };
        return { ref: synced, comment: comment.id };
      },
      async tokenWorks(token) {
        const answer = await graphql(`Bearer ${token}`, Q.VIEWER);
        return answer.status === 200 && answer.data?.viewer?.id !== undefined;
      },
      async close() {
        if (synced !== null) {
          // ADR 0008: the attachment stays as the link to the GitHub issue.
          const facts = (await l.query(Q.SYNC_FACTS, { id: synced.id })).issue as SyncFacts;
          findings.after_detach = { syncedWith: facts.syncedWith, attachments: facts.attachments.nodes };
        }
        if (github !== null) gh("issue", "close", github, "--comment", "The Flight Deck Tracker contract suite is done with this issue.");
        await l.runner.revokeRunnerToken(WORKSPACE);
      },
    };
  },
  { skip: !RUNS, timeout: 60_000 },
);

interface SyncFacts {
  id: string;
  syncedWith: { service: string; id: string }[] | null;
  attachments: { nodes: { id: string; url: string; sourceType: string | null }[] };
  comments: { nodes: { id: string; body: string; user: { id: string } | null; externalUser: { id: string } | null; syncedWith: { service: string; id: string }[] | null }[] };
}

describe.skipIf(!RUNS)("what real Linear does that the Linear adapter assumes", () => {
  let l: RealLinear;
  let repo: TrackerRepo;
  const scratch: IssueRef[] = [];
  const stamp = new Date().toISOString().slice(0, 16);

  beforeAll(async () => {
    l = await real();
    repo = l.repo;
  });

  afterAll(async () => {
    for (const ref of scratch) await l.maintainer.move(ref, "canceled").catch((error: unknown) => console.warn(`Cancel ${ref.id} by hand: ${String(error)}`));
    await l.runner.revokeRunnerToken(WORKSPACE);
  }, 60_000);

  async function file(what: string): Promise<IssueRef & { identifier: string }> {
    const filed = await l.runner.file({ repo, title: `Flight Deck contract suite: ${what} (${stamp})`, description: "The Tracker contract suite filed this scratch issue, and cancels it." }, "intake");
    scratch.push(filed);
    return filed;
  }

  test(
    "a duplicate relation alone: whether it moves the issue to Duplicate, and what markDuplicate does after it",
    async () => {
      const original = await file("relation-only duplicate's original");
      const duplicate = await file("relation-only duplicate");
      await l.query(Q.RELATE, { input: { issueId: duplicate.id, relatedIssueId: original.id, type: "duplicate" } });
      await Bun.sleep(3_000);
      const state = ((await l.query(Q.STATE, { id: duplicate.id })).issue as { state: { name: string; type: string } }).state;
      let markDuplicate: string;
      try {
        await l.runner.markDuplicate(duplicate, original);
        markDuplicate = "landed";
      } catch (error) {
        markDuplicate = `threw: ${error instanceof Error ? error.message : String(error)}`;
      }
      const after = ((await l.query(Q.STATE, { id: duplicate.id })).issue as { state: { name: string; type: string } }).state;
      findings.duplicate_relation_alone = { state_after_relation: state, mark_duplicate_after_relation: markDuplicate, state_after_mark_duplicate: after };
      expect(after).toEqual({ name: repo.statuses.duplicate, type: "duplicate" });
    },
    60_000,
  );

  test(
    "{ issue: A, relatedIssue: B, type: blocks } puts A in B's inverseRelations, so A blocks B",
    async () => {
      const blocker = await file("blocker");
      const blocked = await file("blocked");
      await l.query(Q.RELATE, { input: { issueId: blocker.id, relatedIssueId: blocked.id, type: "blocks" } });
      const nodes = ((await l.query(Q.INVERSE_RELATIONS, { id: blocked.id })).issue as { inverseRelations: { nodes: { type: string; issue: { id: string }; relatedIssue: { id: string } }[] } })
        .inverseRelations.nodes;
      findings.blocks_direction = { inverseRelations_of_blocked: nodes };
      expect(nodes).toContainEqual({ type: "blocks", issue: { id: blocker.id }, relatedIssue: { id: blocked.id } });
    },
    60_000,
  );

  test(
    "an issue that doesn't exist: Linear's message and code, which IssueNotFoundError's rule reads",
    async () => {
      const answer = await l.answer(Q.NOT_FOUND, { id: `${TEAM}-999999` });
      const error = answer.errors?.[0];
      findings.not_found = { status: answer.status, message: error?.message ?? null, code: error?.extensions?.code ?? null, data: answer.data ?? null };
      expect(error?.message).toMatch(/Entity not found|Could not find referenced/);
    },
    60_000,
  );

  test(
    "a Reader token can't write",
    async () => {
      const issue = await file("Reader write");
      const before = ((await l.query(Q.UPDATED_AT, { id: issue.id })).issue as { updatedAt: string }).updatedAt;
      const session = { id: `contract${Date.now().toString(36).slice(-6)}`, repo };
      const token = await l.runner.sessionToken(session);
      try {
        const answer = await graphql(`Bearer ${token}`, Q.COMMENT, { input: { issueId: issue.id, body: "A Reader token must not post this." } });
        findings.reader_write = { status: answer.status, errors: answer.errors ?? null };
        expect(answer.errors?.length ?? 0).toBeGreaterThan(0);
      } finally {
        await l.runner.revoke(session);
      }
      expect(((await l.query(Q.UPDATED_AT, { id: issue.id })).issue as { updatedAt: string }).updatedAt).toBe(before);
    },
    60_000,
  );
});
