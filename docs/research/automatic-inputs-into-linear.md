# What GitHub, Sentry, and PostHog can send into Linear

Research for [FLD-8](https://linear.app/campdotdev/issue/FLD-8/what-can-github-sentry-and-posthog-send-into-linear). I fetched every source on 2026-10-16 and connected or configured nothing. A claim marked "Unconfirmed" has no primary source behind it. Numbers in brackets point to the source list.

## Answer

Four of the ticket's signals reach Linear through an integration a vendor already runs. Linear's GitHub integration syncs new GitHub issues into a Linear team. Sentry alert rules create Linear issues through Linear's Sentry integration, both for new issues and for regressions. PostHog's error-tracking alerts can create a Linear issue when a new error issue appears, though PostHog's docs don't say so yet and I confirmed it in PostHog's source code. These paths run from one vendor's cloud to another, so they need no public URL and no running Mac.

Failing CI on the default branch, Dependabot alerts, and code-scanning alerts have no native path into Linear. Secret-scanning alerts don't either. Each one needs a webhook receiver at a public URL, a GitHub Actions workflow that calls Linear's API from GitHub's runners, or polling. PostHog's reopened and spiking alerts, and its other signals, have no native path either.

For duplicates, every source except CI already folds repeats into one record with a stable ID: a Sentry issue, a PostHog issue, a Dependabot alert number, a code-scanning alert number. CI is the exception, because each failed run gets a new run ID. Every native path puts the source URL on the Linear issue, and Linear's `attachmentsForURL` query finds a Linear issue by that URL. No native path is documented to look for an existing Linear issue before it creates one.

## Signals

| Source | Signal | Native path into Linear | What else it needs | What it offers for spotting duplicates |
| --- | --- | --- | --- | --- |
| GitHub | Issues | Yes. Linear's GitHub Issues Sync pairs a repo with a Linear team, one-way or two-way. It syncs title, description, status, assignee, labels, sub-issues, comments, and priority [1][2]. | The Linear GitHub app on the repo. Only issues created after setup sync. Older ones need Linear's importer [1]. Two-way sync is limited to one repo at a time [1]. Unconfirmed: whether synced issues land in Triage. Linear's Triage doc says integration-created issues default to Triage but names only Slack and Sentry [3]. | The Linear issue carries the GitHub issue as a sync attachment [1]. |
| GitHub | Failing CI on the default branch | No. Linear reads check results only to hold back its "ready for merge" PR automation [1]. | One of three routes. A `workflow_run` webhook, action `completed`, sent to a public URL [12]. An Actions workflow triggered by `workflow_run` with a `branches` filter that calls Linear's API from GitHub's runners. GitHub runs it only if the workflow file is on the default branch, and runs it whatever the conclusion, so the workflow checks `conclusion` itself [13]. Polling `GET /repos/{owner}/{repo}/actions/runs` with `branch` and `status=failure` [15]. | Each run has `workflow_id`, `path`, `head_sha`, `run_attempt`, and `html_url` [15]. Nothing groups repeat failures. A workflow that fails on five commits produces five runs, each with its own `id`. |
| GitHub | Dependabot alerts | None found. Linear's GitHub doc doesn't mention them [1], and a search of Linear's integration directory found no integration for them. | Dependabot alerts work on public and private repos [21]. A `dependabot_alert` webhook goes to a public URL. Its actions include `created`, `reopened`, `auto_reopened`, `reintroduced`, `fixed`, and `dismissed` [12]. This event can't trigger an Actions workflow [13], so an Actions route has to poll on `schedule`, at most every 5 minutes, with the `vulnerability-alerts` read permission [13][14]. Polling from the Mac uses `GET /repos/{owner}/{repo}/dependabot/alerts?state=open` and a classic token with `security_events` scope for private repos [16]. | Alert `number`, unique within the repo, plus GHSA ID, CVE ID, package name, and manifest path [16]. A recurrence arrives as `reopened`, `auto_reopened`, or `reintroduced` on an existing alert, not as `created` [12]. |
| GitHub | Code-scanning alerts | None found [1]. | A `code_scanning_alert` webhook. Its actions include `created`, `reopened`, `appeared_in_branch`, and `fixed` [12]. This event can't trigger an Actions workflow [13]. Polling uses `GET /repos/{owner}/{repo}/code-scanning/alerts` with the `security-events` read permission [14][17]. Private repos need a GitHub Code Security license [18]. | Alert `number`, `rule.id`, `tool.name`, and the most recent instance's path, start line, and ref [17]. |
| GitHub | Secret-scanning alerts | None found [1]. | A `secret_scanning_alert` webhook [12]. This event can't trigger an Actions workflow [13]. I didn't research the REST endpoint. | Not researched. |
| Sentry | New issue | Yes. A Sentry issue alert with the trigger "A new issue is created" and an action that notifies the Linear integration creates a Linear issue [4][22][23]. A person can also create or link a Linear issue from a Sentry issue's sidebar [4]. Completing the Linear issue resolves the linked Sentry issues, and reassigning it in Linear updates the Sentry assignee [4]. | Sentry cloud, one Sentry organization per Linear workspace, and a public Linear team [4]. Linear's Triage doc names Sentry as an integration whose issues default to Triage [3]. Unconfirmed: which Linear fields the alert action sets [4][22]. Throttling limits how often an alert acts on one issue, from every trigger up to once per 30 days [23]. | Sentry already groups events into one issue. The Linear issue carries a link to the Sentry issue [5]. Sentry search has `is:linked` and `is:unlinked` for issues with or without a tracker link [28]. The issue webhook payload has `id`, `shortId`, `permalink`, `count`, `userCount`, `firstSeen`, and `lastSeen` [25]. |
| Sentry | Regression | Yes, through the same alert action with the trigger "A resolved issue regresses". "An issue escalates" is a separate trigger [23]. | Unconfirmed: whether a regression reopens the Linear issue already linked or creates a second one [4]. Sentry's issue webhook has no `regressed` action. A regression is an unresolved issue with substatus `regressed`, and whether it fires the `unresolved` action is unconfirmed [25]. A webhook receiver must answer within 1 second [24]. | Sentry defines a regressed issue as "a resolved issue that's come up again" [27], so it keeps its ID and its existing Linear link. |
| PostHog | Error tracking: new issue | Yes. PostHog's alert setup offers Linear as a destination for the "Issue created" trigger [37][38]. It runs the `template-linear` destination, which calls Linear's `issueCreate` and then attaches a link to the PostHog issue [31][36]. PostHog's alerts doc lists only Slack, Discord, Teams, and an HTTP webhook [30], so this row rests on PostHog's source code. A person can also click Create issue under External references, which adds a partial stack trace and a link back [32]. | A Linear workspace connected in PostHog through OAuth [29], and a public Linear team [6]. The template sends only team, title, and description, with no workflow state [36]. Unconfirmed: whether the issue lands in Triage [3]. The template is marked `free: false` [36]. Unconfirmed: what that costs. | PostHog groups exceptions into issues by fingerprint, with custom fingerprints and grouping rules on top [34]. The attached URL includes a timestamp and `utm_` parameters [38], so it differs from the plain PostHog issue URL. The template doesn't check for an existing Linear issue and doesn't record the new one as a PostHog external reference [36]. PostHog's API lists external references and can search the connected tracker for existing issues [35]. |
| PostHog | Error tracking: reopened or spiking | No. PostHog ships Linear wiring only for "Issue created". Reopened and spiking alerts go to Slack, Discord, Teams, PagerDuty, or an HTTP webhook [38]. | An HTTP webhook to a public URL [30], or polling `GET /api/projects/:project_id/error_tracking/issues/` [35]. | A reopened issue is "a previously resolved issue" coming back [37], so it keeps its PostHog issue ID. |
| PostHog | Session replay | Manual only. A person clicks Create issue in the replay's Linked issues tab, and the Linear issue gets a link back to the replay [33]. | A person in the PostHog UI. | The replay link. |
| PostHog | Survey responses, rage clicks, insight alerts, and logs alerts | None found. PostHog has alert triggers for these and ships no Linear wiring for any of them [38]. | A webhook or polling. Unconfirmed: whether `template-linear` can be attached to these triggers by hand. | Not researched. |

## Sources

All fetched 2026-10-16.

1. Linear, "GitHub": https://linear.app/docs/github
2. Linear changelog, "GitHub Issues Sync" (2023-12-14): https://linear.app/changelog/2023-12-14-github-issues-sync
3. Linear, "Triage": https://linear.app/docs/triage
4. Linear, "Sentry": https://linear.app/docs/sentry
5. Linear integration directory, Sentry: https://linear.app/integrations/sentry
6. Linear integration directory, PostHog: https://linear.app/integrations/posthog
7. Linear developers, "Getting started": https://linear.app/developers/graphql
8. Linear changelog, "UI refresh" (2026-03-12): https://linear.app/changelog/2026-03-12-ui-refresh
9. Linear changelog, "Multi-level sub-teams" (2026-04-09): https://linear.app/changelog/2026-04-09-multi-level-sub-teams
10. Linear developers, "Attachments": https://linear.app/developers/attachments
11. Linear developers, "Rate limiting": https://linear.app/developers/rate-limiting
12. GitHub Docs, "Webhook events and payloads": https://docs.github.com/en/webhooks/webhook-events-and-payloads
13. GitHub Docs, "Events that trigger workflows": https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows
14. GitHub Docs, "Workflow syntax", `permissions`: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
15. GitHub Docs, REST "Workflow runs": https://docs.github.com/en/rest/actions/workflow-runs
16. GitHub Docs, REST "Dependabot alerts": https://docs.github.com/en/rest/dependabot/alerts
17. GitHub Docs, REST "Code scanning": https://docs.github.com/en/rest/code-scanning/code-scanning
18. GitHub Docs, "About code scanning": https://docs.github.com/en/code-security/code-scanning/introduction-to-code-scanning/about-code-scanning
19. GitHub Docs, "Testing webhooks" (smee.io): https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/testing-webhooks
20. GitHub Docs, "Using the GitHub CLI to forward webhooks for testing": https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/using-the-github-cli-to-forward-webhooks-for-testing
21. GitHub Docs, "Configuring Dependabot alerts": https://docs.github.com/en/code-security/dependabot/dependabot-alerts/configuring-dependabot-alerts
22. Sentry Docs, "Linear": https://docs.sentry.io/organization/integrations/issue-tracking/linear/
23. Sentry Docs, "Issue alert configuration": https://docs.sentry.io/product/alerts/create-alerts/issue-alert-config/
24. Sentry Docs, integration platform "Webhooks": https://docs.sentry.io/organization/integrations/integration-platform/webhooks/
25. Sentry Docs, webhooks "Issues": https://docs.sentry.io/organization/integrations/integration-platform/webhooks/issues/
26. Sentry Docs, "Integration platform": https://docs.sentry.io/organization/integrations/integration-platform/
27. Sentry Docs, "Issue states and triage": https://docs.sentry.io/product/issues/states-triage/
28. Sentry Docs, "Issue properties" for search: https://docs.sentry.io/concepts/search/searchable-properties/issues/
29. PostHog Docs, error tracking "Set up integrations": https://posthog.com/docs/error-tracking/integrations
30. PostHog Docs, error tracking "Alerts": https://posthog.com/docs/error-tracking/alerts
31. PostHog Docs, destinations "Linear": https://posthog.com/docs/cdp/destinations/linear
32. PostHog Docs, "Assign issues to teammates", External references: https://posthog.com/docs/error-tracking/assigning-issues
33. PostHog Docs, session replay "Integrations": https://posthog.com/docs/session-replay/integrations
34. PostHog Docs, "Issues and exceptions": https://posthog.com/docs/error-tracking/issues-and-exceptions
35. PostHog API reference, error tracking: https://posthog.com/docs/api/error-tracking-2
36. PostHog source, `nodejs/src/cdp/templates/_destinations/linear/linear.template.ts` on `master` at `3aa9e5a742ed`: https://github.com/PostHog/posthog/blob/master/nodejs/src/cdp/templates/_destinations/linear/linear.template.ts
37. PostHog source, `products/error_tracking/frontend/scenes/ErrorTrackingConfigurationScene/alerting/alertWizardConfig.ts` at the same commit: https://github.com/PostHog/posthog/blob/master/products/error_tracking/frontend/scenes/ErrorTrackingConfigurationScene/alerting/alertWizardConfig.ts
38. PostHog source, `frontend/src/scenes/hog-functions/sub-templates/sub-templates.ts` at the same commit: https://github.com/PostHog/posthog/blob/master/frontend/src/scenes/hog-functions/sub-templates/sub-templates.ts

## What this means for Flight Deck

These facts bear on the intake decision. The decision belongs to the maintainer.

- **The native paths need no URL and no awake Mac.** They run between vendors' clouds, so they keep filing while the laptop is closed. Each one needs a one-time connection in a web UI [1][4][29].
- **Flight Deck's own writes skip Triage unless they name it.** Since 2026-03-12, an issue that a team member creates through the API without a `stateId` goes to the team's default state, even with Triage on [8]. The MCP has followed the same rule since 2026-04-09 [9]. Linear's developer guide still says such issues go to Triage [7]. An agent that files issues as the maintainer has to pass the Triage state's ID.
- **Every webhook needs a URL the sender can reach.** Sentry requires a webhook URL when you create an integration [26]. GitHub's `gh webhook forward` is "only designed for use during testing and development", allows one user per repo at a time, and "is not supported for use in production" [20]. GitHub's smee.io guide and Sentry's tunnel advice are both framed as local testing [19][24]. Sentry treats a webhook that takes longer than 1 second as a timeout [24].
- **GitHub Actions is the only push route without a public URL for the uncovered GitHub signals.** A workflow runs on GitHub's runners and can call Linear's API with a key stored as a repo secret. It covers failing CI through `workflow_run`. Dependabot, code-scanning, and secret-scanning alerts can't trigger a workflow, so Actions reaches them only on a `schedule`, at most every 5 minutes, from the default branch [13]. This route puts a workflow file and a Linear key in the user's repo.
- **Polling from the Mac stops while the Mac sleeps, but alerts are lists of open records.** A poll after sleep still sees what is open: Dependabot `state=open` [16], code scanning `state=open` [17], Sentry `is:unresolved` with `is:unlinked` [28], and PostHog's issue list [35]. Failed CI runs are events, not open records, so a poll finds them by `status=failure` and the `created` date [15]. A Linear API key allows 2,500 requests an hour [11].
- **Linear can find an issue by its source URL.** `attachmentsForURL` returns the attachments and issues for a URL, and an attachment URL is idempotent per issue [10]. Every native path stores the source URL on the Linear issue [1][5][36]. PostHog's alert-created URLs carry a timestamp [38], so a lookup by the plain PostHog issue URL may miss them. Unconfirmed: whether `attachmentsForURL` matches only exact URLs.
- **The native paths create first, so duplicates can only be caught afterwards.** The PostHog template calls `issueCreate` with no lookup [36], and neither Linear nor Sentry documents a lookup for the Sentry alert action [4][22]. With a native path, the earliest a factory can check for a duplicate is after the issue exists in Linear.
- **Linear's own duplicate suggestions need a paid tier.** Triage Intelligence surfaces likely duplicates on the Business and Enterprise plans only [3].
- **Sentry and PostHog won't file into a private Linear team.** Both integrations work only with public teams [4][6].
- **Two-way GitHub sync covers one repo at a time.** One-way sync from several repos into one team has no such limit [1]. A maintainer who runs factories on several repos in one workspace can two-way sync only one of them.
