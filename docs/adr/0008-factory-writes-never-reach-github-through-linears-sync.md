# Factory writes never reach GitHub through Linear's sync

Linear's GitHub Issues Sync copies a Linear issue's description to the GitHub issue body. Two-way sync does this by design, and a July 2026 changelog entry says Linear's updates reach GitHub under one-way sync too. No setting keeps a single edit from syncing. Plan replaces an issue's description with its brief, so on a synced issue it would rewrite a stranger's GitHub issue body, on a public repo, under an identity Linear doesn't document. So before the runner applies plan's brief to a synced issue, it removes the sync attachment and leaves a plain link to the GitHub issue in its place. The GitHub issue keeps the reporter's text. The runner posts every factory comment outside the issue's synced thread, and Linear keeps those comments out of GitHub. The brief's Context carries the GitHub issue's link, so build's PR closes the GitHub issue with `Fixes owner/repo#N` when it merges.

## Considered options

- **Let the brief reach GitHub.** The GitHub issue would show the brief, with the report in a Linear fold that GitHub may not render. Linear doesn't say which GitHub account the edit would appear under.
- **Put the brief in a comment on synced issues only.** The brief would live in one of two places, depending on where the issue came from. The maintainer can't edit a comment the Flight Deck app user posted, which breaks the rule that only the maintainer edits the brief after plan writes it.

## Consequences

- A detached issue stays detached. A reporter's later GitHub comments stop reaching Linear, and the maintainer sees them only as GitHub notifications.
- A pause asks the maintainer, never the filer. Linear posts a synced-thread comment under the commenter's connected GitHub account, and the Flight Deck app user has none. The maintainer passes any question on to the reporter.
- Until the detach, the factory's status moves keep a synced issue open on GitHub, because Linear maps every unstarted and started status to open.
- GitHub issues arrive through one-way sync, and setup won't add a factory to a team that syncs two-way (ADR 0013). One-way sync still carries comments and open or closed status in both directions, so the runner detaches every synced issue before it applies a brief. Nobody has confirmed that deleting the sync attachment through the API stops the sync the way the unlink in Linear's UI does. A dry run on Shaders tests it.
