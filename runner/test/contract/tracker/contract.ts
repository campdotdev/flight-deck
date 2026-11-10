// The Tracker contract suite (spec 1, "Suites" and "The seam"): one set of assertions that the in-memory adapter
// and the Linear adapter both pass, through the Tracker port alone. It pins the Linear behavior the in-memory
// adapter models: assigning subscribes, a comment subscribes its author, filing subscribes the creator, a move
// records `status_since`, `markDuplicate` reaches the Duplicate status with type `duplicate`, and which field marks
// a synced comment. Every issue it files is a scratch issue in the `intake` role, which no factory queue holds, and
// the maintainer cancels each one afterwards.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { IssueNotFoundError, briefDescription, type IssueRef, type TokenSession, type Tracker, type TrackerRepo } from "../../../src/tracker/index.ts";

/** One adapter, as the contract suite drives it. */
export interface TrackerWorld {
  /** The adapter as the runner holds it: the Flight Deck app. */
  runner: Tracker;
  /** The same workspace as the maintainer, as `flight-deck apply` holds it. */
  maintainer: Tracker;
  /** The scratch issues' repo. Its `maintainer` is the maintainer's user ID. */
  repo: TrackerRepo;
  /** Lets time pass: the clock in memory, a real wait on Linear. */
  wait(ms: number): Promise<void>;
  now(): Date;
  /**
   * An issue synced with a GitHub issue, holding one comment that came through the sync. On Linear it opens a
   * GitHub issue through the maintainer's own `gh` and waits for the sync. `close` closes that GitHub issue.
   */
  syncedIssue(): Promise<{ ref: IssueRef; comment: string }>;
  /** Whether Linear still takes a Reader token. */
  tokenWorks(token: string): Promise<boolean>;
  /** Called after the scratch issues are canceled. */
  close(): Promise<void>;
}

export interface ContractOptions {
  skip?: boolean;
  /** Each test's time limit. Linear's GitHub sync takes minutes. */
  timeout?: number;
}

const BRIEF = "## Summary\n\nThe button should be red.\n\n## Acceptance criteria\n\n- [ ] The button is red.";
const REPORT = "The button is blue.\n\nIt should be red, like the mockup.";

export function trackerContract(name: string, open: () => Promise<TrackerWorld>, options: ContractOptions = {}): void {
  const timeout = options.timeout ?? 30_000;

  describe.skipIf(options.skip === true)(`the Tracker contract, against ${name}`, () => {
    let world: TrackerWorld;
    /** Every issue the suite filed or made, which the maintainer cancels afterwards. */
    const scratch: IssueRef[] = [];
    const stamp = new Date().toISOString().slice(0, 16);

    beforeAll(async () => {
      world = await open();
    }, timeout);

    afterAll(async () => {
      if (world === undefined) return;
      const failures: string[] = [];
      for (const ref of scratch) {
        try {
          await world.maintainer.move(ref, "canceled");
        } catch (error) {
          failures.push(`${ref.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await world.close();
      if (failures.length > 0) throw new Error(`Cancel these scratch issues by hand: ${failures.join("; ")}`);
    }, timeout);

    /** Files a scratch issue in the `intake` role as the runner. */
    async function file(what: string, description = REPORT): Promise<IssueRef & { identifier: string }> {
      const filed = await world.runner.file(
        { repo: world.repo, title: `Flight Deck contract suite: ${what} (${stamp})`, description: `${description}\n\nThe Tracker contract suite filed this scratch issue, and cancels it.` },
        "intake",
      );
      scratch.push(filed);
      return filed;
    }

    test(
      "checkTeam finds every status the roles name",
      async () => {
        expect(await world.runner.checkTeam(world.repo)).toEqual({ ok: true });
      },
      timeout,
    );

    test(
      "file files in the role's status, as the runner, and subscribes the creator",
      async () => {
        const filed = await file("filing");
        const read = await world.runner.issue(filed);
        expect(read.identifier).toBe(filed.identifier);
        expect(read.role).toBe("intake");
        expect(read.status).toBe(world.repo.statuses.intake);
        expect(read.team).toBe(world.repo.team);
        expect(read.creator).not.toBe("");
        expect(read.creator).not.toBe(world.repo.maintainer);
        expect(read.subscribers).toContain(read.creator);
        expect(read.subscribers).not.toContain(world.repo.maintainer);
        expect(read.assignee).toBeNull();
        expect(read.synced).toBe(false);
      },
      timeout,
    );

    test(
      "a snapshot holds a filed issue in the intake role, with the same status_since as issue",
      async () => {
        const filed = await file("snapshot");
        const read = await world.runner.issue(filed);
        const snapshot = await world.runner.snapshot(world.repo, { since: new Date(world.now().getTime() - 60_000).toISOString() });
        const found = snapshot.issues.find((each) => each.id === read.id);
        expect(found).toMatchObject({ identifier: filed.identifier, role: "intake", status_since: read.status_since, children: 0, parent: null });
      },
      timeout,
    );

    test(
      "a move records status_since, and takes an identifier",
      async () => {
        const filed = await file("move");
        const before = (await world.runner.issue(filed)).status_since;
        await world.wait(2_000);
        const at = world.now().getTime();
        await world.runner.move({ id: filed.identifier, repo: world.repo }, "backlog");
        const read = await world.runner.issue(filed);
        expect(read.role).toBe("backlog");
        expect(read.status).toBe(world.repo.statuses.backlog);
        expect(read.status_since > before).toBe(true);
        // Linear's clock and the Mac's may differ by a little.
        expect(Math.abs(Date.parse(read.status_since) - at)).toBeLessThan(60_000);
      },
      timeout,
    );

    test(
      "flag assigns the maintainer, which subscribes them, and clearFlag clears both",
      async () => {
        const filed = await file("flag");
        await world.runner.flag(filed);
        const flagged = await world.runner.issue(filed);
        expect(flagged.assignee).toBe(world.repo.maintainer);
        expect(flagged.subscribers).toContain(world.repo.maintainer);
        await world.runner.clearFlag(filed);
        const cleared = await world.runner.issue(filed);
        expect(cleared.assignee).toBeNull();
        expect(cleared.subscribers).not.toContain(world.repo.maintainer);
      },
      timeout,
    );

    test(
      "a comment subscribes its author",
      async () => {
        const filed = await file("comment");
        expect((await world.runner.issue(filed)).subscribers).not.toContain(world.repo.maintainer);
        const posted = await world.maintainer.post(filed, "A scratch comment from the maintainer.", { flag: false });
        const read = await world.runner.issue(filed);
        expect(read.subscribers).toContain(world.repo.maintainer);
        expect(read.comments.find((each) => each.id === posted.id)).toMatchObject({ author: world.repo.maintainer, parent: null, synced: false });
      },
      timeout,
    );

    test(
      "an unflagged post unsubscribes the maintainer first, posts a top-level comment, and writes folds as +++",
      async () => {
        const filed = await file("post");
        await world.maintainer.post(filed, "The maintainer subscribes by commenting.", { flag: false });
        expect((await world.runner.issue(filed)).subscribers).toContain(world.repo.maintainer);
        const posted = await world.runner.post(filed, "The runner's comment.\n\n>>> Details\n\nThe runner's facts.\n\n>>>", { flag: false });
        const read = await world.runner.issue(filed);
        expect(read.subscribers).not.toContain(world.repo.maintainer);
        const comment = read.comments.find((each) => each.id === posted.id);
        expect(comment).toMatchObject({ author: read.creator, parent: null, synced: false });
        expect(comment?.body).toContain("+++ Details");
        expect(comment?.body).not.toContain(">>>");
        expect(Date.parse(posted.created_at)).not.toBeNaN();
      },
      timeout,
    );

    test(
      "a flagged post assigns the maintainer before the comment",
      async () => {
        const filed = await file("flagged post");
        const posted = await world.runner.post(filed, "A flagged scratch comment.", { flag: true });
        const read = await world.runner.issue(filed);
        expect(read.assignee).toBe(world.repo.maintainer);
        expect(read.subscribers).toContain(world.repo.maintainer);
        expect(read.comments.map((each) => each.id)).toContain(posted.id);
      },
      timeout,
    );

    test(
      "writeBrief puts the brief above a +++ Report fold that holds the old description",
      async () => {
        const filed = await file("brief", REPORT);
        const before = (await world.runner.issue(filed)).description;
        await world.runner.writeBrief(filed, BRIEF, { runnerWroteBrief: false });
        const read = await world.runner.issue(filed);
        expect(lines(read.description)).toEqual(lines(briefDescription(BRIEF, before, false)));
      },
      timeout,
    );

    test(
      "markDuplicate reaches the duplicate role's status, whose type is duplicate, and refuses the issue itself",
      async () => {
        const original = await file("duplicate's original");
        const duplicate = await file("duplicate");
        await world.runner.markDuplicate(duplicate, original);
        const read = await world.runner.issue(duplicate);
        expect(read.role).toBe("duplicate");
        expect(read.status).toBe(world.repo.statuses.duplicate);
        expect(read.status_type).toBe("duplicate");
        await expect(world.runner.markDuplicate(original, original)).rejects.toThrow();
      },
      timeout,
    );

    test(
      "issue throws IssueNotFoundError for an issue that doesn't exist",
      async () => {
        await expect(world.runner.issue({ id: `${world.repo.team}-999999`, repo: world.repo })).rejects.toBeInstanceOf(IssueNotFoundError);
      },
      timeout,
    );

    test(
      "a synced issue reads as synced, its synced comment is marked, and detach turns the sync off",
      async () => {
        const { ref, comment } = await world.syncedIssue();
        scratch.push(ref);
        const read = await world.runner.issue(ref);
        expect(read.synced).toBe(true);
        expect(read.sync_attachment).not.toBeNull();
        expect(read.comments.find((each) => each.id === comment)).toMatchObject({ synced: true, parent: null });
        await world.runner.detach({ ...ref, sync_attachment: read.sync_attachment! });
        const detached = await world.runner.issue(ref);
        expect(detached.synced).toBe(false);
        expect(detached.sync_attachment).toBeNull();
      },
      Math.max(timeout, 10 * 60_000),
    );

    test(
      "upload returns the asset URL without its signature",
      async () => {
        const url = await world.runner.upload({ repo: world.repo, name: "contract-suite.txt", contentType: "text/plain", data: new TextEncoder().encode("A scratch upload.\n") });
        expect(url).toStartWith("https://");
        expect(url).not.toContain("signature=");
      },
      timeout,
    );

    test(
      "a session's Reader token reads, a second ask returns the same token, and a revoke ends it",
      async () => {
        const session: TokenSession = { id: `contract${Date.now().toString(36).slice(-6)}`, repo: world.repo };
        const token = await world.runner.sessionToken(session);
        expect(await world.tokenWorks(token)).toBe(true);
        expect(await world.runner.sessionToken(session)).toBe(token);
        await world.runner.revoke(session);
        expect(await world.tokenWorks(token)).toBe(false);
      },
      timeout,
    );
  });
}

/** A description's lines without trailing spaces or blank-line runs, as Linear's editor may store it. */
function lines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line, index, all) => line !== "" || (index > 0 && all[index - 1] !== ""))
    .filter((line, index, all) => !(line === "" && index === all.length - 1));
}
