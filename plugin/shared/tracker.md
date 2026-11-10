# Tracker operations

Every flow reads this file after `session.md`. It maps each tracker operation a flow uses to a Linear MCP read tool. The tracker is Linear.

In a factory session, the tools come from the `linear` MCP server, so `get_issue` is `mcp__linear__get_issue`. In a hand run, use the same tool from the maintainer's own Linear MCP server, whatever its prefix.

## You have no write tool

A factory session has no tool that writes to Linear. Never try one. Every write goes in the outbox, and the runner makes it after you exit: the brief, the status move, the comment, and each follow-up issue.

A hand run has one exception, the take, which `session.md` describes under "Hand runs". A hand run makes no other write to Linear. Its outbox goes through `flight-deck apply`.

## Roles, not status names

Flows name roles, never status names. A role is a key of the record's `[tracker.statuses]` table, such as `ready_to_plan`, `planning`, `ready_to_build`, `paused`, or `duplicate`. Each role maps to the team's own status name. Write roles in the outbox. To match a status that a tool returns, look up its role in `[tracker.statuses]`.

## Operations

| Operation | Tool | How |
| -- | -- | -- |
| Read an issue | `get_issue` | `id` is the identifier, such as `ABC-123`. Set `includeRelations` to `true` to get its duplicate, blocking, and related issues. The result holds the description, the creator, the attachments, and the parent. |
| List its comments | `list_comments` | `issueId` is the identifier. Follow `cursor` while `hasNextPage` is `true`. Each comment has its `id`, `author`, and body. |
| Search the team's issues | `list_issues` | `team` is `session.json`'s `team`, and `query` holds the words. A query matches titles and descriptions, but it misses words inside long descriptions, so read each likely match whole with `get_issue`. |
| List the team's open issues | `list_issues` | `team` is `session.json`'s `team`. Call it once with each open `state` type: `backlog`, `unstarted`, `started`, and `triage`. Follow `cursor` while `hasNextPage` is `true`. |
| Read an attachment | `get_attachment` | `id` comes from `get_issue`'s attachments. Use `format` `url` for the title and the link, such as a Sentry or PostHog record. A signed upload URL lasts five minutes, so call it again rather than reuse one. |
| Read a user | `get_user` | `query` is the user's ID. |
| Read the team's statuses | `list_issue_statuses` | `team` is `session.json`'s `team`. Each status has a name and a type. Match the names against the record's `[tracker.statuses]`. |

The `linear` server allows a few more read tools, such as `extract_images` for images in a description or a comment. Use them when a step needs them. Read Linear only through these tools.
