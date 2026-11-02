# The factory routes work by its own statuses, in one team per repo

A repo's issues sit in one Linear team, and the repo record names it. Two repos never share a team. Setup adds eight factory statuses to that team beside the team's own: Ready to plan, Planning, Ready to build, Building, Ready to check, Checking, Landed, and Paused. It reuses Backlog, In Review, Done, Canceled, and Duplicate, and it never renames or repurposes a status that issues already sit in. The factory takes only issues the maintainer sends by moving them to Ready to plan. Status alone routes work. The lifecycle defines no labels, and the factory never adds a label, sets an issue's priority, or sets its delegate.

## Considered options

- **An opt-in label on Linear's Todo**, such as Matt Pocock's `ready-for-agent`. Shaders already uses that label, so adding a factory there would make every labelled Todo issue takeable at once. Two conditions are also two things to forget, and the board never said which one build reads.
- **Take every issue except a skip list.** An issue nobody listed, such as a planning issue in the same team, would get built.
- **A project per repo inside a shared team.** An issue belongs to one project, so the maintainer would lose projects for their own grouping.
- **A label per repo inside a shared team.** Every intake route would have to add the label, and the factory would skip an issue without it and tell nobody.
- **Delegating each taken issue to the Flight Deck app user.** Linear opens an agent session on delegation and expects a webhook to answer within 10 seconds. The factory has no webhook, so Linear would show every session as unresponsive.

## Consequences

- Linear Free is the floor, so no flow uses a paid plan's feature, such as Releases or triage responsibility, even as an option. A Free workspace allows 2 teams, so it holds at most 2 factories. A third repo needs a paid plan or a second free workspace with its own two Linear apps.
- Ready to plan is an `unstarted` status, and the other seven are `started`.
- Each stage has a queue, named "Ready to" plus the stage, and a working status named with the stage's verb, such as Ready to build and Building. A take moves an issue from the queue to the working status. Plan hands off to Ready to build. Build hands off to Ready to check, where the issue waits until check can start (ADR 0010). Check moves a passed issue to In Review, or sends it back to Ready to build with its findings.
- In Review stays one of the team's own statuses, though check moves a passed issue into it. The maintainer's own PRs still move their issues there through Linear's Review automation, which stays on, so the runner acts on an issue in In Review only while it's in flight (ADR 0011).
- Statuses belong to a team, so the record maps each lifecycle role to a status name on that team. The record's `[tracker]` table holds `kind = "linear"`, the `workspace`, and the `team` key, such as `SHA`. `[tracker.statuses]` holds one line per role, such as `ready_to_plan = "Ready to plan"`. Flows speak in roles, so a team that renamed Done or In Review still works, and another tracker can map its own states later.
- The map holds names, not IDs, so a renamed status gets caught. Before each session, the runner checks that every name in the map exists on the team. If one is missing, the runner starts no session for that repo, and it files and flags a trouble issue (ADR 0011).
- Setup sets Linear's PR automations for draft and opened PRs to no action, because they would move a factory issue to In Progress, outside the factory. Linear refuses a rule for all branches with no status, so setup deletes the team's `draft` and `start` rules with `gitAutomationStateDelete`. Merge → Done and Review → In Review stay on. The maintainer's own PRs on that team stop moving their issues to In Progress.
- The runner closes an issue in three cases only. It moves a spec's landed sub-issues to Done when the spec PR merges. It cancels the open sub-issues of a canceled spec. When plan marks its issue a duplicate of an open issue, the runner applies the mark (ADR 0008). Any other reason to close an issue, such as work already built, pauses the issue, and the maintainer closes it. Linear's merge automation moves every other merged issue to Done, so Done means merged, not released. No session runs after a merge.
- Planning issues in the same team, such as the wayfinder issues on the Flight Deck team, need no exclusion rule. They never enter a factory status.
- A team can't post project updates, so `/flight-debrief` needs another place for its output. ADR 0012 files its output as proposals.
- ADR 0011 lets the runner set an issue's assignee to flag the maintainer while the issue is in flight.
