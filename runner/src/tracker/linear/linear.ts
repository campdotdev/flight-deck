// The Linear adapter: the Tracker's production adapter, which speaks Linear's GraphQL API behind the interface
// the in-memory adapter also passes (spec 1, "Tracker (Linear)"). It hides Linear's rules from its callers: the
// role-to-name map, one filtered query per repo per poll, `+++` folds, top-level comments only, the order of the
// flag and unsubscribe writes, the brief's report rules, unsigned upload URLs in everything it writes, and the token mints. Where the real
// API's behavior isn't documented, a comment says "the contract suite pins" it: FLD-116 runs this adapter against
// real Linear and settles each one.
import { ROLES, type Role } from "../../record/index.ts";
import { briefDescription, plusFolds, unsigned } from "../folds.ts";
import { TrackerRefused } from "../refused.ts";
import {
  IssueNotFoundError,
  type FiledIssue,
  type IssueDraft,
  type IssueRef,
  type PostedComment,
  type PostOptions,
  type RelationKind,
  type Snapshot,
  type SnapshotOptions,
  type StatusType,
  type SyncedIssueRef,
  type TeamCheck,
  type TokenSession,
  type Tracker,
  type TrackerComment,
  type TrackerIssue,
  type TrackerRepo,
  type UploadFile,
  type Viewer,
  type WriteBriefOptions,
} from "../types.ts";
import type { LinearApp } from "../mint.ts";
import * as Q from "./queries.ts";
import { blocking, comment, issueFields, snapshot, type CommentNode, type IssueNode, type Page, type Read } from "./snapshot.ts";
import { Transport, type LinearApps, type LinearIdentity } from "./transport.ts";

export type { AppSecret, LinearApps, LinearIdentity } from "./transport.ts";

export interface LinearTrackerOptions {
  /** The Flight Deck app for the runner, or the maintainer's setup key for `flight-deck apply`. */
  identity: LinearIdentity;
  /** The workspace's two apps, read from `credentials.env` at each mint. */
  apps: (workspace: string) => Promise<LinearApps | null>;
  /** Linear's origin, `https://api.linear.app` by default. Tests point it at a local server. */
  api?: string;
  fetch?: typeof fetch;
  /** How long one request may take before it counts as a network error. 30 s by default. */
  timeoutMs?: number;
  /** Where the adapter writes what it can't throw, such as a failed revoke. */
  log?: (message: string) => void;
}

/** A team as the adapter caches it: its UUID and statuses. Refreshed by `checkTeam` and on a missing name. */
interface Team {
  id: string;
  key: string;
  states: { id: string; name: string; type: string }[];
}

interface FullIssueNode extends IssueNode {
  description: string | null;
  team: { key: string };
  creator: { id: string } | null;
  syncedWith: { service: string }[] | null;
  attachments: { nodes: { id: string; url: string; sourceType: string | null }[] };
  comments: Page<CommentNode>;
}

/** Linear's form of a UUID, which the mutations' ID arguments take. An identifier such as `SHA-12` isn't one. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class LinearTracker implements Tracker {
  private readonly transport: Transport;
  private readonly teams = new Map<string, Team>();
  /** Each session's Reader token, by session ID, with its workspace. */
  private readonly readers = new Map<string, { workspace: string; token: string }>();

  constructor(options: LinearTrackerOptions) {
    this.transport = new Transport({
      identity: options.identity,
      apps: options.apps,
      api: options.api ?? "https://api.linear.app",
      fetch: options.fetch ?? fetch,
      timeoutMs: options.timeoutMs ?? 30_000,
      log: options.log ?? (() => {}),
    });
  }

  // Reads.

  snapshot(repo: TrackerRepo, options: SnapshotOptions = {}): Promise<Snapshot> {
    return snapshot(this.reader(repo.workspace), repo, options.since ?? null);
  }

  async issue(ref: IssueRef): Promise<TrackerIssue> {
    const answer = await this.transport.graphql<{ issue: FullIssueNode | null }>(ref.repo.workspace, Q.ISSUE, { id: ref.id }, { notFound: true });
    const node = answer.data?.issue ?? null;
    if (node === null) throw new IssueNotFoundError(ref.id);
    const comments = node.comments.nodes.map(comment);
    let page = node.comments.pageInfo;
    while (page.hasNextPage) {
      const more = await this.query<{ issue: { comments: Page<CommentNode> } }>(ref.repo.workspace, Q.ISSUE_COMMENTS, { id: node.id, after: page.endCursor });
      comments.push(...more.issue.comments.nodes.map(comment));
      page = more.issue.comments.pageInfo;
    }
    comments.sort(byCreated);
    const fields = issueFields(node, ref.repo);
    const synced = (node.syncedWith ?? []).some((each) => each.service === "github");
    // `blockers` and `unblocks` are read only for an issue in `ready_to_plan` on the repo's team, as in a snapshot.
    const blocks = node.team.key === ref.repo.team && fields.role === "ready_to_plan" ? (await blocking(this.reader(ref.repo.workspace), [node.id])).get(node.id) : undefined;
    return {
      ...fields,
      blockers: blocks?.blockers ?? [],
      unblocks: blocks?.unblocks ?? 0,
      team: node.team.key,
      status_type: node.state.type as StatusType,
      description: node.description ?? "",
      creator: node.creator?.id ?? "",
      comments,
      synced,
      sync_attachment: synced ? syncAttachment(node.attachments.nodes) : null,
      archived: node.archivedAt !== null,
    };
  }

  async checkTeam(repo: TrackerRepo): Promise<TeamCheck> {
    let team: Team | null;
    try {
      team = await this.loadTeam(repo);
    } catch (error) {
      if (error instanceof TrackerRefused) return { ok: false, reason: "unreadable" };
      throw error;
    }
    if (team === null) return { ok: false, reason: "unreadable" };
    const names = new Set(team.states.map((state) => state.name));
    const roles = ROLES.filter((role) => !names.has(repo.statuses[role]));
    return roles.length === 0 ? { ok: true } : { ok: false, reason: "missing", roles };
  }

  // Writes.

  async move(ref: IssueRef, role: Role): Promise<void> {
    await this.update(ref, { stateId: await this.stateId(ref.repo, role) });
  }

  async post(ref: IssueRef, body: string, options: PostOptions): Promise<PostedComment> {
    const state = await this.flagState(ref);
    const maintainer = ref.repo.maintainer;
    if (options.flag) {
      await this.update({ ...ref, id: state.id }, { assigneeId: maintainer });
    } else if (state.assignee !== maintainer && state.subscribed) {
      // An issue the runner flagged keeps the maintainer assigned and subscribed, so the comment reaches them.
      await this.unsubscribeUser(ref.repo, state.id);
    }
    // Always top-level: no `parentId`, so the comment never lands in a synced thread (ADR 0008).
    const answer = await this.query<{ commentCreate: { success: boolean; comment: { id: string; createdAt: string } | null } }>(ref.repo.workspace, Q.COMMENT, {
      input: { issueId: state.id, body: unsigned(plusFolds(body)) },
    });
    const posted = answer.commentCreate;
    if (!posted.success || posted.comment === null) throw new TrackerRefused(`Linear didn't create the comment on ${state.identifier}`);
    return { id: posted.comment.id, created_at: posted.comment.createdAt };
  }

  async flag(ref: IssueRef): Promise<void> {
    await this.update(ref, { assigneeId: ref.repo.maintainer });
  }

  async clearFlag(ref: IssueRef): Promise<void> {
    const state = await this.flagState(ref);
    if (state.assignee !== null) await this.update({ ...ref, id: state.id }, { assigneeId: null });
    // Linear keeps a former assignee subscribed, so the unsubscribe reads the state from before the unassign.
    if (state.subscribed || state.assignee === ref.repo.maintainer) await this.unsubscribeUser(ref.repo, state.id);
  }

  async unsubscribe(ref: IssueRef): Promise<void> {
    const state = await this.flagState(ref);
    // Each removal sends the maintainer a notification, so the adapter removes only a subscription that exists (ADR 0011).
    if (state.subscribed) await this.unsubscribeUser(ref.repo, state.id);
  }

  async writeBrief(ref: IssueRef, brief: string, options: WriteBriefOptions): Promise<void> {
    const answer = await this.query<{ issue: { id: string; description: string | null } }>(ref.repo.workspace, Q.DESCRIPTION, { id: ref.id });
    const description = unsigned(briefDescription(brief, answer.issue.description ?? "", options.runnerWroteBrief));
    await this.update({ ...ref, id: answer.issue.id }, { description });
  }

  async markDuplicate(ref: IssueRef, of: IssueRef): Promise<void> {
    const [id, original] = await Promise.all([this.uuid(ref), this.uuid(of)]);
    if (id === original) throw new TrackerRefused(`${ref.id} can't be a duplicate of itself`);
    const stateId = await this.stateId(ref.repo, "duplicate");
    const answer = await this.query<{ relation: { success: boolean }; update: { success: boolean } }>(ref.repo.workspace, Q.DUPLICATE, {
      relation: { issueId: id, relatedIssueId: original, type: "duplicate" },
      id,
      input: { stateId },
    });
    if (!answer.relation.success || !answer.update.success) throw new TrackerRefused(`Linear didn't mark ${ref.id} a duplicate of ${of.id}`);
  }

  async file(draft: IssueDraft, role: Role): Promise<FiledIssue> {
    // The status is named, because Linear sends an issue created through the API to the team's default status
    // otherwise (ADR 0013). No label, priority, assignee, or delegate (ADR 0006).
    const team = await this.team(draft.repo);
    const stateId = await this.stateId(draft.repo, role);
    const answer = await this.query<{ issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string } | null } }>(draft.repo.workspace, Q.CREATE, {
      input: { teamId: team.id, stateId, title: unsigned(draft.title), description: unsigned(draft.description) },
    });
    const filed = answer.issueCreate.issue;
    if (!answer.issueCreate.success || filed === null) throw new TrackerRefused(`Linear didn't file "${draft.title}"`);
    return { id: filed.id, repo: draft.repo, identifier: filed.identifier, url: filed.url };
  }

  async relate(ref: IssueRef, other: IssueRef, kind: RelationKind): Promise<void> {
    const [id, related] = await Promise.all([this.uuid(ref), this.uuid(other)]);
    const answer = await this.query<{ issueRelationCreate: { success: boolean } }>(ref.repo.workspace, Q.RELATE, { input: { issueId: id, relatedIssueId: related, type: kind } });
    if (!answer.issueRelationCreate.success) throw new TrackerRefused(`Linear didn't relate ${ref.id} to ${other.id}`);
  }

  async detach(ref: SyncedIssueRef): Promise<void> {
    const answer = await this.query<{ issueExternalSyncDisable: { success: boolean } }>(ref.repo.workspace, Q.DETACH, { attachment: ref.sync_attachment });
    if (!answer.issueExternalSyncDisable.success) throw new TrackerRefused(`Linear didn't turn off ${ref.id}'s GitHub sync`);
  }

  async upload(file: UploadFile): Promise<string> {
    const answer = await this.query<{ fileUpload: { success: boolean; uploadFile: { uploadUrl: string; assetUrl: string; headers: { key: string; value: string }[] } | null } }>(
      file.repo.workspace,
      Q.UPLOAD,
      { contentType: file.contentType, filename: file.name, size: file.data.byteLength },
    );
    const target = answer.fileUpload.uploadFile;
    if (!answer.fileUpload.success || target === null) throw new TrackerRefused(`Linear didn't take the upload of ${file.name}`);
    const headers: Record<string, string> = { "Content-Type": file.contentType, "Cache-Control": "public, max-age=31536000" };
    for (const header of target.headers) headers[header.key] = header.value;
    await this.transport.put(target.uploadUrl, headers, file.data);
    return unsigned(target.assetUrl);
  }

  // Tokens.

  runnerToken(workspace: string): Promise<void> {
    return this.transport.runnerToken(workspace);
  }

  revokeRunnerToken(workspace: string): Promise<void> {
    return this.transport.revokeRunnerToken(workspace);
  }

  async sessionToken(session: TokenSession): Promise<string> {
    const workspace = session.repo.workspace;
    const held = this.readers.get(session.id);
    if (held !== undefined && (await this.transport.accepts(held.token))) return held.token;
    const token = await this.transport.mint("reader", workspace);
    this.readers.set(session.id, { workspace, token });
    if (held !== undefined) await this.transport.revoke(held.token);
    return token;
  }

  async revoke(session: TokenSession): Promise<void> {
    // A session a new runner never minted for, such as a replayed exit after a restart, has nothing to revoke.
    const held = this.readers.get(session.id);
    if (held === undefined) return;
    this.readers.delete(session.id);
    await this.transport.revoke(held.token);
  }

  async tryReaderMint(workspace: string): Promise<void> {
    await this.transport.revoke(await this.transport.mint("reader", workspace));
  }

  // Who the adapter acts as.

  async viewer(workspace: string): Promise<Viewer> {
    return viewerOf(await this.query<{ viewer: ViewerNode }>(workspace, Q.VIEWER, {}));
  }

  async appViewer(workspace: string, app: LinearApp): Promise<Viewer> {
    const token = await this.transport.mint(app, workspace);
    try {
      return viewerOf((await this.transport.withToken<{ viewer: ViewerNode }>(token, Q.VIEWER, {})).data!);
    } finally {
      await this.transport.revoke(token);
    }
  }

  // Helpers.

  private reader(workspace: string): Read {
    return <T>(query: string, variables: Record<string, unknown>, partial = false) => this.query<T>(workspace, query, variables, partial);
  }

  private async query<T>(workspace: string, query: string, variables: Record<string, unknown>, partial = false): Promise<T> {
    const answer = await this.transport.graphql<T>(workspace, query, variables, { partial });
    return answer.data as T;
  }

  private async update(ref: IssueRef, input: Record<string, unknown>): Promise<void> {
    const answer = await this.query<{ issueUpdate: { success: boolean } }>(ref.repo.workspace, Q.UPDATE, { id: ref.id, input });
    if (!answer.issueUpdate.success) throw new TrackerRefused(`Linear didn't update ${ref.id}`);
  }

  private async unsubscribeUser(repo: TrackerRepo, id: string): Promise<void> {
    const answer = await this.query<{ issueUnsubscribe: { success: boolean } }>(repo.workspace, Q.UNSUBSCRIBE, { id, user: repo.maintainer });
    if (!answer.issueUnsubscribe.success) throw new TrackerRefused(`Linear didn't unsubscribe the maintainer from ${id}`);
  }

  private async flagState(ref: IssueRef): Promise<{ id: string; identifier: string; assignee: string | null; subscribed: boolean }> {
    const answer = await this.transport.graphql<{ issue: { id: string; identifier: string; assignee: { id: string } | null; subscribers: { nodes: { id: string }[] } } | null }>(
      ref.repo.workspace,
      Q.FLAG_STATE,
      { id: ref.id, user: ref.repo.maintainer },
      { notFound: true },
    );
    const issue = answer.data?.issue ?? null;
    if (issue === null) throw new IssueNotFoundError(ref.id);
    return { id: issue.id, identifier: issue.identifier, assignee: issue.assignee?.id ?? null, subscribed: issue.subscribers.nodes.some((user) => user.id === ref.repo.maintainer) };
  }

  /** The issue's UUID, which `IssueRelationCreateInput` needs. An identifier is read once to find it. */
  private async uuid(ref: IssueRef): Promise<string> {
    if (UUID.test(ref.id)) return ref.id;
    const answer = await this.transport.graphql<{ issue: { id: string } | null }>(ref.repo.workspace, Q.ISSUE_ID, { id: ref.id }, { notFound: true });
    const id = answer.data?.issue?.id;
    if (id === undefined) throw new IssueNotFoundError(ref.id);
    return id;
  }

  /** The UUID of the team's status that the record names for the role, reading the team again once when it's missing. */
  private async stateId(repo: TrackerRepo, role: Role): Promise<string> {
    const name = repo.statuses[role];
    const cached = this.teams.get(repo.team)?.states.find((state) => state.name === name);
    if (cached !== undefined) return cached.id;
    const state = (await this.loadTeam(repo))?.states.find((each) => each.name === name);
    if (state === undefined) throw new TrackerRefused(`team ${repo.team} has no status ${name}`);
    return state.id;
  }

  private async team(repo: TrackerRepo): Promise<Team> {
    const team = this.teams.get(repo.team) ?? (await this.loadTeam(repo));
    if (team === null) throw new TrackerRefused(`the Flight Deck app can't read team ${repo.team}`);
    return team;
  }

  /** Reads the team and its statuses, or `null` when the identity can't read a team by that key. */
  private async loadTeam(repo: TrackerRepo): Promise<Team | null> {
    const data = await this.query<{ teams: { nodes: { id: string; key: string; states: { nodes: Team["states"] } }[] } }>(repo.workspace, Q.TEAM, { key: repo.team });
    const node = data.teams.nodes.find((each) => each.key === repo.team);
    if (node === undefined) {
      this.teams.delete(repo.team);
      return null;
    }
    const team = { id: node.id, key: node.key, states: node.states.nodes };
    this.teams.set(repo.team, team);
    return team;
  }
}

/**
 * The GitHub sync's attachment: the issue's attachment from GitHub that links a GitHub issue. The contract suite
 * pins whether `sourceType` reads `github` for it.
 */
function syncAttachment(attachments: { id: string; url: string; sourceType: string | null }[]): string | null {
  const github = attachments.filter((each) => each.sourceType === "github" || /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+/.test(each.url));
  return (github.find((each) => /\/issues\/\d+/.test(each.url)) ?? github[0])?.id ?? null;
}

interface ViewerNode {
  id: string;
  name: string;
  organization: { urlKey: string };
}

function viewerOf(data: { viewer: ViewerNode }): Viewer {
  return { id: data.viewer.id, name: data.viewer.name, workspace: data.viewer.organization.urlKey };
}

function byCreated(a: TrackerComment, b: TrackerComment): number {
  return a.created_at.localeCompare(b.created_at);
}
