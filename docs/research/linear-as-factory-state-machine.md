# What can Linear do as a factory's state machine?

Research note for [FLD-4](https://linear.app/campdotdev/issue/FLD-4/what-can-linear-do-as-a-factorys-state-machine). Sources were read on 2026-10-16. Each claim cites a source from the list at the end, such as [S1]. A claim marked **Unconfirmed** is one I could not settle from a primary source. I created and changed nothing in Linear to test a claim. The only Linear calls I made were reads, apart from claiming FLD-4.

## Answer

Linear can hold a factory's state, and its GraphQL API can configure nearly everything a setup flow needs. The Linear MCP server cannot.

- **Setup.** GraphQL has create mutations for workflow statuses, labels, templates, custom views, triage settings, triage responsibility, PR automations, webhooks, and release pipelines [S1]. The MCP server can create and edit labels. It can only read statuses, templates, views, and triage responsibility [S31]. A workflow status can be created without the Linear UI, but only through GraphQL's `workflowStateCreate` [S1]. Status types are fixed. A new status must be `backlog`, `unstarted`, `started`, `completed`, or `canceled`. Triage is a team toggle, and Duplicate is managed by Linear [S1][S12].
- **Agent identity.** An OAuth app installed with `actor=app` gets its own app user. People can delegate issues to it and mention it, and it takes no paid seat [S5][S20]. A workspace admin has to install it [S5]. Its token works from any machine and can also authenticate the MCP server, so a local runner can act as the app user [S10][S28]. The agent-session protocol is the hard part. Linear's docs describe only webhook delivery for new sessions, and Linear expects an acknowledgement within 10 seconds [S6]. The agent APIs are a Developer Preview [S5].
- **Events.** A webhook needs a public HTTPS URL that answers within 5 seconds. Linear retries a failed delivery 3 times over about 7 hours, then may disable the webhook [S4]. Polling fits within the rate limits: 5,000 requests an hour for an OAuth app user, and 2,500 for a personal API key [S3]. Linear's docs tell integrations to use webhooks rather than poll [S2].
- **Attention.** Assigning or mentioning the maintainer puts a notification in their inbox [S17][S24]. Moving an issue into a status does not notify anyone, apart from completions and cancellations. A view subscription covers that case, but it skips the subscriber's own actions [S16][S18]. Triage responsibility can assign or notify, on Business and Enterprise plans only [S13].
- **Releases and project updates.** Both have GraphQL mutations and MCP write tools [S1][S31]. Releases need a Business or Enterprise plan and a release pipeline, and the MCP server cannot create a pipeline [S21][S31]. Project updates attach to Linear projects [S22].
- **Ready to build.** One GraphQL query can return candidate issues together with the state of each blocker [S1]. Linear has a `hasBlockedByRelations` filter, but I could not confirm whether it still matches after the blocker closes. Through the MCP server, the same check takes one `get_issue` call per candidate and one more per blocker [S31].

## Configure a team without the UI

A setup flow can create every status, label, template, and view it needs through GraphQL. Only labels are writable through the MCP server.

| What setup configures | GraphQL mutation [S1] | MCP server tool [S31] |
|---|---|---|
| Workflow statuses | `workflowStateCreate`, `workflowStateUpdate`, `workflowStateArchive` | Read only: `list_issue_statuses`, `get_issue_status` |
| Default status for new issues | `teamUpdate` with `defaultIssueStateId` | None |
| Triage on or off | `teamUpdate` with `triageEnabled`, `requirePriorityToLeaveTriage` | None |
| Triage responsibility | `triageResponsibilityCreate`, `Update`, `Delete` | Read only: `get_triage_responsibility` |
| Issue labels and label groups | `issueLabelCreate`, `Update`, `Retire`, `Restore`, `Delete` | `save_issue_label`, `retire_issue_label`, `restore_issue_label` |
| Templates | `templateCreate`, `templateUpdate`, `templateDelete` | Read only: `list_templates`, `get_template`. `save_issue` applies a template on create |
| Custom views | `customViewCreate`, `customViewUpdate`, `customViewDelete` | Read only: `list_custom_views`. `list_issues` accepts `customView` |
| PR automations | `gitAutomationStateCreate`, `Update`, `Delete` | None |
| Auto-close of parents and sub-issues | `teamUpdate` with `autoCloseParentIssues`, `autoCloseChildIssues` | None |
| Webhooks | `webhookCreate`, `webhookUpdate`, `webhookDelete` | None |
| Release pipelines and stages | `releasePipelineCreate`, `releaseStageCreate` | Read only: `list_release_pipelines` |
| Teams | `teamCreate`, `teamUpdate` | Read only: `get_team`, `list_teams` |

### Statuses

`WorkflowStateCreateInput` takes `teamId`, `name`, `color`, `type`, and optional `description` and `position`. Its `type` accepts only `backlog`, `unstarted`, `started`, `completed`, and `canceled` [S1]. A state read back from the API can also have the type `triage` or `duplicate` [S1]. Triage appears when `triageEnabled` is turned on for the team, and the Duplicate status "is a system-managed status that cannot be renamed or customized" [S12].

Teams reorder statuses only within a category. "The categories themselves stay in a fixed order" [S12]. Each category must keep at least one status [S12]. `workflowStateArchive` archives a state only when every issue in it is already archived [S1].

An issue created through the API without a `stateId` lands in the team's first Backlog status, or in Triage if Triage is on [S2].

### Labels

Labels belong to the workspace or to one team [S14]. A label group nests one level. The product docs say only one label from a group can sit on an issue at a time [S14]. The current schema adds `groupType` with `singleSelect` and `multiSelect`, and `singleSelect` is the default for groups [S1]. The MCP tool exposes the same option [S31]. The docs and the schema disagree here, and the schema is newer.

Team labels with the same name act as one label in the UI's filters. That "does not extend to the API (you'll have to use the unique identifier for each team's label)" [S14]. Some label names are reserved, including `state`, `status`, `priority`, and `project` [S14].

### Templates

`TemplateCreateInput` takes a `type` such as `issue`, `project`, or `document`, an optional `teamId`, and `templateData` as JSON [S1]. **Unconfirmed:** the shape of `templateData`. The schema calls it "JSON-encoded attributes of the target entity type" and documents nothing more [S1].

A template can preset team, status, priority, assignee, delegated agent, project, labels, estimate, and sub-issues [S15]. A workspace template cannot preset team labels or team statuses [S15]. A team can set a default template that applies to every new issue, with separate defaults for members and non-members [S15].

### Views

`customViewCreate` takes a `filterData` of type `IssueFilter`, the same filter type the `issues` query takes [S1]. A view can be shared, owned by a user, and scoped to a team or a project [S1][S16]. Triage issues are left out of every view unless a status filter includes Triage [S13].

### Who may change team settings

Team owners choose whether all members or only team owners may manage "workflow statuses, cycles, triage rules, agent guidance, and other team settings", labels, and templates [S25]. `teamUpdate` "requires team owner or workspace admin permissions for most changes" [S1]. On the Free plan, every member is an admin [S25]. An app installed with `actor=app` cannot also request the `admin` scope [S5].

**Unconfirmed:** whether an app user can call `workflowStateCreate`, `templateCreate`, or `teamUpdate`. No source I read says which roles or scopes those mutations need.

## Run the factory as an agent

### App users

Linear's agent platform treats an agent as an app user. It can be mentioned, take delegated issues, write comments, and work on projects and documents [S5][S20]. An agent "cannot sign in to the app, access admin functionality or manage users" [S20]. Agents are not billable seats [S5][S20]. The agent APIs are a Developer Preview, and "Functionality and Agent APIs may change before general availability" [S5].

To make one, register an OAuth app in Linear settings and add `actor=app` to the authorization URL [S5][S9]. After that, "all mutations such as creating issues, comments, and status changes will be performed by the app" [S9]. Installing at workspace scope needs admin permission [S5]. The admin picks which teams the agent can reach during installation [S20]. Two optional scopes control how people reach the agent:

- `app:assignable` lets the app be "assigned as a delegate on issues and made a member of projects" [S5].
- `app:mentionable` lets the app be "mentioned in issues, documents, and other editor surfaces" [S5].

An app in `actor=app` mode can also post as a named person with `createAsUser` and `displayIconUrl` on `issueCreate` and `commentCreate`. The result renders as "User (via Application)" [S9][S1].

### Tokens a local runner can hold

Linear offers two token types for an app user.

- **Authorization code.** The access token lasts 24 hours and refreshes with a refresh token [S10]. Linear supports PKCE, which makes the client secret optional [S10].
- **Client credentials.** The app owner first turns this grant on in the app's settings. The token "will be an `app` actor token that has access to all public teams in the workspace and is valid for 30 days". It has no refresh token, and an app may hold up to 1,000 active tokens [S10].

The MCP server accepts an OAuth token or API key in an `Authorization: Bearer` header. Linear says "you can use this to interact with the MCP server as an app user" [S28]. Claude Code on the Mac could then call the MCP tools as the factory's app user instead of as the maintainer.

**Unconfirmed:** whether a client-credentials token carries `app:assignable` and `app:mentionable`, and whether Linear accepts a `localhost` redirect URI. The OAuth page's examples use `http://localhost:3000/oauth/callback` but state no rule [S10].

### Delegation

Assigning an issue to an agent sets `Issue.delegate` and leaves the human assignee in place [S5][S19]. The issue still appears in the assignee's My Issues view [S19]. Custom views and Insights can filter by delegate [S20]. The GraphQL `IssueFilter` and the MCP tool `list_issues` both filter by delegate [S1][S31], and the MCP tool `save_issue` sets one [S31].

Linear's best practices give two rules for status [S7]:

- When work starts on a delegated issue that is not already started, completed, or canceled, move it to the team's first `started` status. That is the started state with the lowest `position`.
- If no delegate is set when the agent starts implementation work, the agent sets itself as delegate.

### Agent sessions

Linear opens an agent session when someone mentions or delegates to the agent [S5]. It then sends an `AgentSessionEvent` webhook with the action `created` [S6]. A follow-up message from a person arrives as `prompted` [S6]. The `created` payload carries `promptContext`, a ready-made prompt string with the issue, comments, and guidance [S6][S1].

Linear sets these timing rules [S6][S7]:

- The webhook receiver answers within 5 seconds.
- The agent emits an activity, or sets `externalUrls`, within 10 seconds of `created`. Otherwise "the session may be marked unresponsive".
- A session goes stale after 30 minutes without an activity. Another activity recovers it.

The agent reports progress with `agentActivityCreate`. Activity types are `thought`, `action`, `elicitation`, `response`, and `error` [S6]. Linear posts `response`, `elicitation`, and `error` activities as comments on the issue [S7]. Linear derives the session status from the last activity. The values are `pending`, `active`, `awaitingInput`, `complete`, `error`, `stale`, and `stopping` [S6][S1]. `agentSessionUpdate` sets `externalUrls`, which is where a PR link goes, and a `plan` checklist [S6]. A person can send a `stop` signal. The agent can send `auth` and `select` signals with an elicitation [S8].

An agent can also open a session itself with `agentSessionCreateOnIssue` or `agentSessionCreateOnComment` [S6].

**Unconfirmed:** whether a runner can learn about new sessions without a webhook. The schema has a root `agentSessions` query and an `AgentSession.status` field [S1], but no doc says whether an app user can poll it for its own sessions. I also could not confirm whether a session marked unresponsive recovers when a late activity arrives.

### Linear's own agent

Linear Agent is on by default in every workspace [S20]. Its coding sessions run Claude Code or Codex in Linear's cloud, return a draft PR, and bill against prepaid AI credits [S29]. Linear also offers "Open issues in coding tools", which opens an issue in Claude Code from the Linear desktop app with a custom prompt [S19].

## Get events to a runner on the Mac

### Webhooks

A webhook consumer must be "a publicly accessible HTTPS, non-localhost URL" that returns HTTP 200 [S4]. Linear counts a delivery as failed after 5 seconds without a response or on any non-200 status. It retries 3 times, after 1 minute, 1 hour, and 6 hours. If the URL stays unresponsive, Linear may disable the webhook until someone turns it back on by hand [S4]. Each delivery carries a `Linear-Signature` HMAC-SHA256 header and a `webhookTimestamp`. Linear recommends rejecting any delivery more than a minute old [S4].

The webhook resource types are `AgentSessionEvent`, `AppUserNotification`, `Attachment`, `Comment`, `Customer`, `CustomerNeed`, `Cycle`, `Document`, `Initiative`, `InitiativeUpdate`, `Issue`, `IssueLabel`, `IssueSLA`, `OAuthAuthorization`, `PermissionChange`, `Project`, `ProjectLabel`, `ProjectUpdate`, `Reaction`, `Release`, `ReleaseNote`, and `User` [S1]. Issue relations and workflow states have no resource type of their own [S1]. An `Issue` update payload includes `updatedFrom` with the previous values of the changed fields [S4].

**Unconfirmed:** whether adding or removing a blocking relation fires an `Issue` webhook.

There are two ways to create a webhook:

- **Workspace webhook.** A workspace admin creates it in settings, or an OAuth app with the `admin` scope calls `webhookCreate`. "Only workspace admins, or OAuth applications with the `admin` scope, can create or read webhooks" [S4].
- **OAuth app webhook.** The webhook URL is part of the app's settings. "When an organization authorizes the app, a webhook is created for that organization at the configured URL" [S4]. Agent session events arrive this way [S5].

Each OAuth app has one configured URL, so every workspace that installs the same app sends its events to that URL [S4].

### Polling

Linear's GraphQL guide lists "Poll updates for each issue" under Don't, and says "There should never be a reason to do this and your application might get rate limited" [S2]. Its advice is about polling each issue one by one. A single filtered query on a timer is a different pattern, and the rate limits allow it [S3]:

| Authentication | Requests per hour | Complexity points per hour |
|---|---|---|
| Personal API key | 2,500, shared by every key of the same user | 3,000,000 |
| OAuth app | 5,000 per user or app user | 2,000,000 |
| Unauthenticated | 600 per IP address | 100,000 |

One query may not exceed 10,000 complexity points [S3]. Each property costs 0.1 point, each object 1 point, and a connection multiplies its children by `first`, which defaults to 50 [S3]. Linear raises the limits for workspace-level OAuth apps based on the workspace's paid user count [S3]. A rate-limited request returns HTTP 400 with the error code `RATELIMITED` [S3].

As a worked example, a runner that polls once every 10 seconds sends 360 requests an hour. That uses 7% of an OAuth app user's request budget, or 14% of a personal API key's. Date filters such as `IssueFilter.updatedAt` accept ISO 8601 durations relative to now, such as `P2W`, so each poll can ask only for recent changes [S1][S11].

**Unconfirmed:** whether calls through the MCP server count against the same per-user limits.

### GraphQL subscriptions

The schema declares a `Subscription` root type with 85 fields, such as `issueUpdated`, `commentCreated`, and `agentSessionCreated` [S1]. None of the developer docs I read mention a WebSocket endpoint or third-party use of it. The GraphQL guide points to webhooks for real-time updates [S2]. **Unconfirmed:** whether an outside client can use these subscriptions.

## Get the maintainer's attention

### Inbox and subscriptions

A user is subscribed to an issue automatically when they create it, are assigned to it, or are mentioned in its description or a comment [S17][S18]. A mention in a comment thread subscribes the user to that thread only [S18]. Subscribers get an inbox notification for key events on the issue [S17]. The inbox keeps up to 2,000 open notifications and archives older ones [S17][S18]. Desktop, mobile, and Slack notifications arrive in real time. Email arrives as delayed digests, and only for notifications still unread [S18].

Status changes notify less than a factory might expect:

- With "Status changes" turned on, the notifications FAQ names only completions and cancellations as notifying subscribers [S18].
- The status-changes group also covers urgent-priority changes and changes to blocking relationships. "You cannot select only status changes" [S18].
- For an issue entering a specific status, Linear points to a view subscription [S18].

A view subscription notifies when an issue is added to the view, completed or canceled in it, or both. "You won't receive notifications in views you subscribe to for actions you take yourself" [S16].

**Unconfirmed:** whether Linear also drops assignment and mention notifications when the actor and the recipient are the same user. The docs state the rule only for view subscriptions.

### API support

- `issueSubscribe` subscribes any user to an issue, and `IssueCreateInput.subscriberIds` subscribes users at creation [S1]. The MCP server has no subscriber parameter [S31].
- `notificationSubscriptionCreate` subscribes "the authenticated user" to one team, project, label, custom view, cycle, initiative, customer, or user [S1]. The MCP server has no tool for it [S31].
- `notifications` and `inboxNotifications` read the authenticated user's inbox [S1]. The MCP server can read them with `get_notifications` and mark or snooze them with `mark_notification` [S31].
- An app user has its own notifications. Linear can send them to the app as `AppUserNotification` webhooks [S1][S5].

### Triage responsibility

Triage responsibility picks who handles issues that enter Triage. Its `action` is either `assign` or `notify` [S1][S13]. A schedule can rotate the person, and PagerDuty, OpsGenie, Rootly, and incident.io can drive it [S13]. Triage Rules, Triage Intelligence, and Triage Responsibility need a Business or Enterprise plan [S13]. New issues land in Triage when an integration creates them, when they are created from the Triage view, or when someone outside the team creates them [S13].

Agents fit in here too. Best practice for an issue that an automation delegated to an agent is to keep it in Triage and "leave assignment up to a human actor to action" [S7]. Triage rules can delegate an issue to an agent [S19].

## Write releases and project updates

### Releases

Releases need a Business or Enterprise plan. Business allows up to 15 pipelines [S21]. A pipeline is `continuous` or `scheduled` and has stages. A release has a name, a commit SHA, a version, and a set of issues [S21][S1]. Workflow automations can move issues when a release completes [S21]. In CI, a pipeline is driven by its own access key. "You cannot use a personal API key in place of a pipeline access key" [S21].

| Operation | GraphQL [S1] | MCP server [S31] |
|---|---|---|
| Create a pipeline | `releasePipelineCreate`, "subject to plan entitlement and quota limits" | None |
| Create or update a release | `releaseCreate`, `releaseUpdate`, `releaseComplete`, `releaseSync` | `save_release` |
| Link issues to a release | `issueToReleaseCreate` | `save_issue` with `addReleases` |
| Write release notes | `releaseNoteCreate`, `releaseNoteUpdate` | `save_release_note` |

The campdotdev workspace has no release pipelines today [S31].

### Project updates

A project update has a Markdown body and a health of `onTrack`, `atRisk`, or `offTrack` [S1][S22]. GraphQL writes one with `projectUpdateCreate`, and the MCP server writes one with `save_status_update` [S1][S31]. The project lead posts the first update, and after that any workspace member can [S22]. Reminders go only to the lead, and only for projects in an In Progress status [S22].

**Unconfirmed:** whether an app user can post a project's first update, or any update.

## Find the issues that are ready to build

### The data model

A relation has a source `issue`, a target `relatedIssue`, and a `type` [S1]. The type enum has `blocks`, `duplicate`, `related`, and `similar` [S1]. "A blocks B" is stored once, with A as the source. B sees it through `Issue.inverseRelations` [S1]. Sub-issues are `Issue.children` and `Issue.parent` [S1]. GraphQL exposes the manual order of sub-issues as `Issue.subIssueSortOrder` [S1].

The product docs say that "once the blocking issue has been resolved, the relationship moves under Related" [S23]. That sentence describes the issue sidebar. **Unconfirmed:** whether the stored relation type changes when a blocker closes.

### Filters

`IssueFilter` has `hasBlockedByRelations`, `hasBlockingRelations`, `parent`, `children`, `state.type`, `labels`, `delegate`, `assignee`, `updatedAt`, `and`, and `or` [S1]. The filtering guide does not cover relations or sub-issues [S11]. **Unconfirmed:** whether `hasBlockedByRelations` still matches an issue whose only blockers are closed. Until that is settled, a "ready" check has to read each blocker's state.

One query can do that. The following query has not been run, and the filter values are placeholders:

```graphql
query ReadyCandidates($teamId: ID!) {
	issues(
		first: 50
		filter: {
			team: { id: { eq: $teamId } }
			state: { type: { in: ["unstarted"] } }
		}
	) {
		nodes {
			identifier
			parent { identifier }
			inverseRelations(first: 10) {
				nodes {
					type
					issue { identifier state { type } }
				}
			}
		}
	}
}
```

An issue is ready when no `blocks` entry in its `inverseRelations` points at an issue whose state type is `backlog`, `unstarted`, or `started`. By the formula in the rate-limiting guide, the query costs about 1,800 points, which is under the 10,000-point cap for one query [S3].

### Through the MCP server

`list_issues` filters by `parentId`, `state`, `label`, `assignee`, `delegate`, and `customView`, but not by relations [S31]. `get_issue` returns `blocks` and `blockedBy` as identifier and title only [S31]. A read of FLD-4's relations on 2026-10-16 returned exactly those two fields. Checking whether a blocker is closed takes another `get_issue` call per blocker.

### Automations that touch these states

- Teams can close a parent when all its sub-issues close, and close sub-issues when the parent closes [S1].
- The GitHub integration moves linked issues on PR events. By default an issue goes to In Progress when a PR opens and to Done when it merges [S27]. The events are `draft`, `start`, `review`, `mergeable`, and `merge` [S1]. Branch-specific rules can override these. A `gitAutomationStateCreate` with a null `stateId` means "take no action" [S1][S27].
- With several linked PRs, the issue moves when the last one reaches the required state [S27].

## Plan limits

| Limit | Free | Basic | Business | Enterprise |
|---|---|---|---|---|
| Issues | 250 | Unlimited | Unlimited | Unlimited |
| Teams | 2 | 5 | Unlimited | Unlimited |
| Releases | No | No | Up to 15 pipelines | No pipeline limit |
| Triage rules, Intelligence, and Responsibility | No | No | Yes | Yes |

Sources: issue and team limits [S26][S30]. Releases [S21]. Triage features [S13]. The pricing page lists "Agent platform" on the Free plan [S30]. **Unconfirmed:** the plan of the campdotdev workspace. The MCP server does not report it.

## The MCP server compared with GraphQL

The Linear MCP server is hosted at `https://mcp.linear.app/mcp`. A read-only variant is at `/mcp/readonly` [S28]. In this session it acts as the signed-in user, Hunter Garrett [S31].

Operations the MCP server exposes [S31]:

- Issues: create and update, including status, assignee, delegate, labels, parent, relations, project, cycle, milestone, releases, links, and a template on create.
- Comments, documents, projects, milestones, project updates, attachments, releases, and release notes: create and update.
- Issue labels and project labels: create, update, retire, and restore.
- Notifications: read, mark read, and snooze.
- Linear Diffs: list, read, comment, review, and `merge_diff`, which merges a PR or adds it to the merge queue.
- Reads of statuses, templates, views, teams, users, cycles, release pipelines, triage responsibility, and agent skills.

Operations that need GraphQL directly [S1][S31]:

- Workflow statuses, templates, custom views, and release pipelines: create, update, and delete.
- Team settings: Triage, default status, auto-close, and PR automations.
- Triage responsibility: create and update.
- Webhooks.
- Agent sessions and agent activities.
- Issue subscribers and notification subscriptions.

## What this means for Flight Deck

These facts constrain the decisions that wait on this ticket, mainly [FLD-10](https://linear.app/campdotdev/issue/FLD-10) on the lifecycle and [FLD-11](https://linear.app/campdotdev/issue/FLD-11) on the runtime, plus intake, `/flight-log`, `/flight-launch`, and `/flight-debrief`. They do not make those decisions.

- **A setup flow that uses only the MCP server can create labels and nothing else on the team.** Statuses, templates, views, Triage, triage responsibility, PR automations, and webhooks need GraphQL calls or the maintainer clicking through settings.
- **Every factory stage maps to one of five status types or to a label.** Status types are fixed, and categories keep a fixed order. Triage and Duplicate cannot be created as statuses.
- **The GitHub integration moves issues on its own.** If a repo's GitHub integration is on, a PR opening moves the issue to In Progress and a merge moves it to Done unless the team's PR automations are changed. A factory status between "PR open" and "merged" will be overwritten unless setup turns those automations off.
- **The factory's Linear identity decides whether the maintainer gets notified.** If the factory writes as the maintainer, Linear's own rules skip view-subscription alerts for the maintainer's own actions. Every factory comment also reads as the maintainer's. An app user writes as someone else.
- **An app user brings setup costs.** It needs an OAuth app, a workspace admin to install it, and admin action again to change its team access. The agent APIs are a Developer Preview.
- **One Flight Deck OAuth app means one webhook URL for every install.** Each workspace that installs a shared app sends events to the URL in that app's settings. The alternative is for each maintainer to create their own OAuth app.
- **The agent-session protocol assumes a reachable endpoint.** Sessions announce themselves by webhook, and Linear may mark a session unresponsive after 10 seconds without an activity. A runner that only polls would have to poll at least that often, or skip agent sessions and use statuses and labels alone.
- **A sleeping Mac loses events.** Webhook retries end after about 7 hours, and Linear may then disable the webhook. A webhook-driven runner still needs a catch-up query on wake.
- **Polling fits the budget.** A query every 10 seconds uses 7% of an OAuth app user's hourly requests. A personal API key's quota is shared with every other key the maintainer holds.
- **Moving an issue into a status does not notify anyone by default, apart from completions and cancellations.** Reaching the maintainer means an assignment, a mention, a view subscription, or triage responsibility, and triage responsibility needs a Business plan.
- **Plan limits shape a repo's footprint.** The Free plan allows 250 issues and 2 teams. Releases and triage responsibility need Business. `/flight-launch` cannot rely on Linear Releases for a maintainer on Free or Basic.
- **Project updates attach to Linear projects.** `/flight-debrief` can post one only where the repo's issues belong to a project.
- **The ready-to-build check is one GraphQL query.** Through the MCP server it takes one call per candidate plus one per blocker.
- **The MCP server can merge PRs.** `merge_diff` merges a GitHub PR through Linear Diffs where the workspace has granted code access. Any agent holding the Linear MCP server with write access can call it.

## Sources

All sources were read on 2026-10-16. I read the product docs at linear.app/docs through the MCP server's `search_documentation` tool, which returns the page text and URL.

- [S1] Linear GraphQL schema, [`packages/sdk/src/schema.graphql`](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql) in `linear/linear`, last changed in commit `9dd2ed8` on 2026-10-15.
- [S2] [Getting started with the GraphQL API](https://linear.app/developers/graphql)
- [S3] [Rate limiting](https://linear.app/developers/rate-limiting)
- [S4] [Webhooks](https://linear.app/developers/webhooks)
- [S5] [Agents](https://linear.app/developers/agents)
- [S6] [Developing the agent interaction](https://linear.app/developers/agent-interaction)
- [S7] [Agent interaction best practices](https://linear.app/developers/agent-best-practices)
- [S8] [Agent signals](https://linear.app/developers/agent-signals)
- [S9] [OAuth actor authorization](https://linear.app/developers/oauth-actor-authorization)
- [S10] [OAuth 2.0 authentication](https://linear.app/developers/oauth-2-0-authentication)
- [S11] [Filtering](https://linear.app/developers/filtering)
- [S12] [Issue status](https://linear.app/docs/configuring-workflows)
- [S13] [Triage](https://linear.app/docs/triage)
- [S14] [Issue labels](https://linear.app/docs/labels)
- [S15] [Issue templates](https://linear.app/docs/issue-templates)
- [S16] [Custom views](https://linear.app/docs/custom-views)
- [S17] [Inbox](https://linear.app/docs/inbox)
- [S18] [Notifications](https://linear.app/docs/notifications)
- [S19] [Assign and delegate issues](https://linear.app/docs/assigning-issues)
- [S20] [AI agents](https://linear.app/docs/agents-in-linear)
- [S21] [Releases](https://linear.app/docs/releases)
- [S22] [Initiative and project updates](https://linear.app/docs/initiative-and-project-updates)
- [S23] [Issue relations](https://linear.app/docs/issue-relations)
- [S24] [Editor](https://linear.app/docs/editor), section on mentions
- [S25] [Members and roles](https://linear.app/docs/members-roles)
- [S26] [Teams](https://linear.app/docs/teams)
- [S27] [GitHub](https://linear.app/docs/github)
- [S28] [MCP server](https://linear.app/docs/mcp)
- [S29] [Coding sessions](https://linear.app/docs/coding-sessions)
- [S30] [Pricing](https://linear.app/pricing)
- [S31] The Linear MCP server's tool list and tool schemas, loaded in this session through ToolSearch, and these read-only calls against campdotdev: `get_issue` on FLD-2 and FLD-4, `list_issues` on FLD-2's children, `get_team` and `get_triage_responsibility` on Flight Deck, `list_release_pipelines`, and `get_workspace`.
