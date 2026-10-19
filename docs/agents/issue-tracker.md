# Issue tracker: Linear

Flight Deck's planning lives in Linear, on the **Flight Deck** team, with the `FLD-` identifier prefix, in the workspace `campdotdev`. Reach Linear through the Linear MCP server. There is no `linear` CLI here.

The wayfinder map for v1 is [Wayfinder map: Flight Deck v1 spec](https://linear.app/campdotdev/issue/FLD-2/wayfinder-map-flight-deck-v1-spec). It and its decision tickets live in the **Flight Deck wayfinding** project.

This file adapts the hand-written Linear conventions in `campdotdev/shaders` (`docs/agents/issue-tracker.md`). `setup-matt-pocock-skills` ships templates for GitHub, GitLab, and local markdown only.

## Conventions

- **Create an issue**: `mcp__linear__save_issue` with `team: "Flight Deck"` and a `title`. Omit `id` when creating. Pass the body as `description` in Markdown, with literal newlines rather than escape sequences.
- **Fold the body into a collapsible.** A spec or ticket carries far more text than a human scanning the issue needs. A long description also pushes the sub-issue list and the relations off screen. Open the description with one to three sentences a human reads first. Put everything else inside a Linear collapsible titled `Context for AI`, fenced with `>>>`:

  ```markdown
  One to three sentences a human reads first.

  >>> Context for AI

  ## Problem Statement

  ...

  >>>
  ```

  Headings, lists, code fences, and issue mentions survive inside the fold, and `get_issue` returns the full body, so a model loses nothing. `+++ Context for AI` parses too, but Linear serializes it to `>>>`, so write `>>>`. Keep the summary outside the fold, because `list_issues` truncates descriptions and a folded body with nothing above it reads as an empty issue in list previews.
- **Read an issue**: `mcp__linear__get_issue` with the identifier, such as `FLD-104`. Pass `includeRelations: true` whenever blocking edges matter, because relations are omitted by default.
- **List issues**: `mcp__linear__list_issues`, filtered by `team`, `state`, `assignee`, `label`, or `parentId`.
- **Comment**: `mcp__linear__save_comment`.
- **Read comments**: `mcp__linear__list_comments`.
- **Apply labels**: `mcp__linear__save_issue` with `addLabels`, which appends. See the label trap below before you reach for `labels`.
- **Close**: `mcp__linear__save_issue` with `state: "Done"`, or `state: "Canceled"` when the work is being dropped rather than finished.

### Three traps

1. **`labels` replaces the entire label set.** It is not additive. An issue carrying `Feature` that you save with `labels: ["wayfinder:map"]` loses `Feature`. On an existing issue, pass `addLabels` to append and `removeLabels` to drop one. Omitting all three leaves the labels untouched, which is what you usually want.
2. **`blocks` and `blockedBy` are append-only.** Saving them never removes an existing edge. Use `removeBlocks` and `removeBlockedBy` to drop one.
3. **Linear has no open or closed flag.** It has workflow states with a type. On this team the states are `Backlog` (backlog), `Todo` (unstarted), `In Progress` (started), `In Review` (started), `Done` (completed), `Canceled` (canceled), and `Duplicate` (duplicate). Treat backlog, unstarted, and started as open. Treat completed, canceled, and duplicate as closed, so a `Duplicate` issue never surfaces as open work.

## When a skill says "publish to the issue tracker"

Create a Linear issue on the Flight Deck team.

## When a skill says "fetch the relevant ticket"

Call `get_issue` with the `FLD-` identifier, then `list_comments` for the discussion.

## Wayfinding operations

Used by `/wayfinder`. The **map** is one issue, and its tickets are child issues of it.

**Labels.** The five labels wayfinder needs exist on this team as team labels: `wayfinder:map`, `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, and `wayfinder:task`. Do not recreate them.

- **Map**: one issue labelled `wayfinder:map`, holding the `## Destination`, `## Notes`, `## Decisions so far`, `## Not yet specified`, and `## Out of scope` sections. Create it with `save_issue`, passing `team: "Flight Deck"`, `project: "Flight Deck wayfinding"`, and `labels: ["wayfinder:map"]`.
- **Child ticket**: an issue created with `parentId` set to the map's identifier, which makes it a Linear sub-issue and renders under the map in Linear's own UI. Label it `wayfinder:<type>`, one of `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.
- **Blocking**: Linear's native issue relations, which render as a visible blocked banner in the UI. Wire an edge with `save_issue` on the blocked ticket, passing `blockedBy: ["FLD-123"]`, or from the other side with `blocks`. Create the issues first and wire the edges in a second pass, because both ends need identifiers before they can reference each other. A ticket is unblocked when every issue blocking it sits in a closed state.
- **Frontier query**: `list_issues` with `parentId` set to the map, `orderBy: "createdAt"`, and `fields: ["title", "statusType", "assignee", "updatedAt"]`. Ask for all four. The default response omits status and assignee, and the default order is `updatedAt`, which reshuffles every time a ticket is written to. `state` matches one state type per call, so no single call covers open work. Filter the results in the client instead: keep the tickets whose `statusType` is `backlog`, `unstarted`, or `started`, whose `assignee` is empty, and which `get_issue` with `includeRelations: true` shows has no open blocker. The earliest-created ticket wins, because wayfinder creates a map's tickets in map order in one pass. Reordering sub-issues by hand in Linear does not move a ticket in this query, because that manual order is not exposed here.
- **Claim**: `save_issue` with `assignee: "me"`. Make it the session's first write, before any other work, so the ticket stops matching the frontier query as early as possible.

  The claim is advisory, not a lock. `save_issue` overwrites the assignee instead of testing it first, so two sessions that both run the frontier query before either one writes will both claim the same ticket. Both writes succeed, and neither session can see the collision, because every session claims as the same user. Claiming first shortens the window. It does not close it. If two wayfinder sessions have to run at once, keep them off each other's tickets outside Linear: give each session its own map, or have a human hand out the tickets.

  A session that stops without resolving leaves the assignee set, and the frontier query then skips that ticket for good. Clear a stale claim with `save_issue` and `assignee: null`, then reclaim it. First establish that no session still holds it. Linear keeps no record of running sessions, and every session claims as the same user, so the assignee never says which session owns the ticket. Read what the ticket does show. `updatedAt` is when the claim landed, because claiming writes nothing else, and `list_comments` says whether the answer already posted. Then take one of three routes:

  1. If the answer is already posted, the session died part-way through Resolve. Leave the claim alone and finish the missing writes with the Resolve procedure below.
  2. If you know the session that claimed it has stopped, clear the assignee and reclaim.
  3. Otherwise ask the human before clearing. Age is a weak signal on its own. A claim a few minutes old usually belongs to a live session, and a research ticket can run for a long time before its next write.
- **Resolve**: three writes, in this order.

  1. Post the answer with `save_comment`.
  2. Append a context pointer to the map's `## Decisions so far` with a `patch` operation.
  3. Set the ticket to `state: "Done"`.

  Closing last is what makes a partial failure recoverable. A ticket closed before the map records it leaves the frontier with no trace of its answer. A ticket left open keeps its claim, so the frontier query still skips it, and nothing returns it to the frontier on its own. Recover it through the stale-claim routes under Claim: finish the writes that are missing, and clear the assignee only after you establish that no live session holds the ticket.

  None of the three writes is idempotent, so never retry one without first checking whether it already landed. Re-read the current state: `get_issue` for the workflow state and the map body, and `list_comments` for the answer. Then run only the writes still missing, in the same order. A repeated `save_comment` posts the answer twice, and a repeated `patch` appends the pointer twice.

  Diagnose a failed `patch` from the error it returns. An anchor that matched zero times or more than once needs a corrected anchor, checked against the map body you just re-read. A transport error, a permission error, or a rejected payload is a different failure, and re-anchoring hides it. The map body survives either one, as the patch section below explains.

  The ticket is resolved only once all three writes have landed. Leave it open while any one is missing, and say which one.

### Appending to the map without rewriting it

`save_issue` takes a `patch` array that applies edits atomically against the current description, which avoids re-sending the whole map body and avoids clobbering a concurrent session's edit. Anchor on the heading:

```json
{
  "id": "FLD-000",
  "patch": [
    {
      "op": "insert_after",
      "anchor": "## Decisions so far",
      "text": "\n\n- [Ticket title](url): one-line gist of the answer"
    }
  ]
}
```

Every anchor must match the current content exactly once, and one failing operation aborts the whole save.

## Scope note

Wayfinder decision tickets live in the **Flight Deck wayfinding** project, apart from any work the factory builds. Close them as they resolve. A decision ticket left open after its answer landed is the same failure as a stale status section in a spec.
