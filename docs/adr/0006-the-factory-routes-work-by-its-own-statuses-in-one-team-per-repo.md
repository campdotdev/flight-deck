# The factory routes work by its own statuses, in one team per repo

A repo's issues sit in one Linear team, and the repo record names it. Two repos never share a team. Setup adds eight statuses to that team beside the team's own: Ready to plan, Planning, Ready to build, Building, Ready to check, Checking, Landed, and Paused. It reuses Backlog, In Review, Done, Canceled, and Duplicate, and it never renames or repurposes a status that issues already sit in. The factory takes only issues the maintainer sends by moving them to Ready to plan. Status alone routes work. The lifecycle defines no labels, and the factory never sets an issue's delegate or assignee.

## Considered options

- **An opt-in label on Linear's Todo**, such as Matt Pocock's `ready-for-agent`. Shaders already uses that label, so adding a factory there would make every labelled Todo issue takeable at once. Two conditions are also two things to forget, and the board never said which one build reads.
- **Take every issue except a skip list.** An issue nobody listed, such as a planning ticket in the same team, would get built.
- **A project per repo inside a shared team.** An issue belongs to one project, so the maintainer would lose projects for their own grouping.
- **A label per repo inside a shared team.** Every intake route would have to add the label, and the factory would skip an issue without it and tell nobody.
- **Delegating each taken issue to the Flight Deck app user.** Linear opens an agent session on delegation and expects a webhook to answer within 10 seconds. The factory has no webhook, so Linear would show every session as unresponsive.

## Consequences

- A Free workspace allows 2 teams, so it holds at most 2 factories. A third repo needs a paid plan or a second free workspace with its own Flight Deck app.
- Statuses belong to a team, so the record maps each lifecycle role to a status name on that team. Flows speak in roles, so another tracker can map its own states later.
- Setup sets Linear's PR automations for draft and opened PRs to no action, because they would move a factory issue to In Progress, outside the factory. Merge → Done stays on. The maintainer's own PRs on that team stop moving their issues to In Progress.
- Planning tickets in the same team, such as the wayfinder tickets on the Flight Deck team, need no exclusion rule. They never enter a factory status.
- A team can't post project updates, so `/flight-debrief` needs another place for its output. ADR 0012 files its output as proposals.
- ADR 0011 lets the runner set an issue's assignee to flag the maintainer, while the issue sits in a factory status. The factory still never sets a delegate.
