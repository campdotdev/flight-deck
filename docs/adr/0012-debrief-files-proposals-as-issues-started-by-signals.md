# Debrief files proposals as issues, started by signals

On the board, `/flight-debrief` ran every Friday and opened one PR with up to 5 changes to checks, standards, and flow skills, then posted a Linear project update. Later decisions broke each part. That PR would be the only change in the repo that build didn't write and check didn't judge. A flow's skill now belongs to Flight Deck, not to the repo. A team can't post a project update. So debrief writes no code. It files each change it proposes as a proposal: an unsent issue in the repo's team, at most 5 per debrief, which the runner flags. The maintainer sends a proposal through plan, build, and check like any other issue, makes the change by hand when it lies outside the repo, or cancels it. Debrief runs when something went wrong, not on a clock. The runner counts each signal in code, the way it already sees every pause and verdict, and a count that reaches its threshold starts a debrief session.

## Considered options

- **The board's Friday routine and PR.** A clock spends a session in a quiet week and doesn't fire while the Mac sleeps. In a busy week, a mistake waits days for its debrief. The PR would skip check, and ADR 0007 would pause it anyway, because it edits `CLAUDE.md` and the repo record.
- **One debrief issue per run that lists the proposals.** The maintainer would have to turn each proposal they accept into an issue by hand.
- **Hand runs only.** The maintainer would run `/flight-debrief` when something bothered them, and `flight-deck status` would show the counts. A hands-off maintainer rarely notices the pattern a count catches.
- **A notes file for each flow in the repo**, such as `.flight-deck/notes/build.md`, so debrief could correct a flow locally. Each repo would fork Flight Deck's behavior, and the notes would go stale across updates. A repo already steers every flow through `CLAUDE.md`, `CODING_STANDARDS.md`, and its slots.

## Consequences

- Flight Deck ships eight signals with default thresholds, which "Review /flight-debrief for a solo maintainer on any repo" lists. The repo record can override any threshold, and a threshold of 0 turns its signal off. Each count covers the time since the last debrief, so no evidence gets debriefed twice. At most one debrief runs per repo at a time.
- ADR 0011 said follow-up issues flag nothing. A proposal is flagged, because it exists only to get the maintainer's decision.
- A fix to one of Flight Deck's own flows becomes an upstream report. That is a proposal outside the repo, with a link that opens a prefilled issue on Flight Deck's GitHub repo. Nothing leaves the Mac unless the maintainer files it. Debrief writes no eval cases.
- The runner keeps each session's transcript in its data folder for 30 days. When a signal crosses its threshold, the runner copies the transcripts of the issues behind it into debrief's inbox. Debrief reads them as untrusted text, and the runner's secret scan covers every proposal before the runner files it.
- A proposal loosens something when it removes or relaxes a check, a standard, or a steering rule, or when it widens what sessions can reach. Its title then starts with "Loosens:", and its first sentence says what gets weaker and why.
- The runner keeps a list of the proposals it has filed, so no label marks them. Debrief comments new evidence on an open proposal instead of filing it again. It doesn't refile a change the maintainer canceled in the last 90 days.
- No project update and no daily brief carries debrief's output. `flight-deck status` shows each count and when the last debrief ran.
