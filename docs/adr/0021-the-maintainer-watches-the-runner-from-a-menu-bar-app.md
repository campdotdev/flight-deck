# The maintainer watches the runner from a menu bar app

Flags reach the maintainer through Linear (ADR 0011), but nothing showed the runner itself: what it's running, whether it's alive, and how much of the plan it has used. After the FlutedGlass dry run, the maintainer asked for one place to see that. A prototype over that run's state tried four forms, and the maintainer chose a menu bar app that shows the bare minimum. Flight Deck ships one for the Mac's runner. Its icon shows how many issues need the maintainer, and whether the runner is working, held, stopped, or not responding. Its menu lists, in this order, the flagged issue that has waited longest, the running sessions and runner jobs, the plan usage, the controls **Start**, **Hold new work**, and **Stop**, and **Open Linear**. The app reads the runner's state and calls the runner's own commands, so it holds no credential and writes nothing to Linear or GitHub.

## Considered options

- **A local web page that leads with what needs the maintainer.** It had room for the spec's numbers: sessions, session time, cost at API prices, and the time spent waiting on the maintainer. The maintainer wants to think a fuller UI through before v1 commits to one.
- **A board and timeline page.** It showed where every issue sits and when each session ran. That suits a look back at a run, not a glance.
- **A richer `flight-deck status` on its own.** It shows the same content, but only in an open terminal.
- **Up to 5 flags, with debrief's proposals on a row of their own.** The prototype showed this first. The maintainer cut it to one flag and one row into Linear.
- **A carousel of flags.** A macOS menu has no carousel, and paging through flags in the menu would repeat the Needs you view.
- **Answering a pause from the menu.** The runner holds only the Flight Deck app's Linear key, so an answer would read as Flight Deck's, not the maintainer's. Linear already takes the one-word answer from the phone (ADR 0019). Each flagged issue in the menu opens in Linear instead.

## Consequences

- The menu shows one flagged issue: the longest-waiting one that holds up work. Debrief's proposals hold up nothing, so the menu shows the oldest proposal only when no other flag waits. When the shown flag clears, the next one takes its place. Below it, a row such as "10 more in Linear" opens the Needs you view, which lists the rest. The icon counts every flag.
- Needs you is one shared view for the whole workspace, so a single link covers every factory in it. It lists the issues assigned to the maintainer that sit in a factory status or that the Flight Deck app filed, grouped by status. Changes ready for review, paused issues, and the proposals and trouble issues in Triage each get their own group. Linear leaves Triage out of a view unless its filter names Triage, so the filter does. My Issues would also list the maintainer's own work in other teams.
- ADR 0011 turned down subscribing to a "Needs you" view, because a filter on status would notify the maintainer before the bot round settles. This view filters on the assignment, which the runner makes only when a flag is real, and nobody subscribes to it. Notifications still come from the assignment.
- Setup creates the Needs you view with the first factory in a workspace, under the maintainer's login, and adds each later factory's statuses to its filter. `flight-deck remove` takes a factory's statuses out of it and deletes the view with the workspace's last factory (ADR 0017).
- A hold stops the runner from starting new sessions while running sessions and jobs finish. A held runner still polls, applies outboxes, lands issues, and flags the maintainer. **Hold new work** puts the runner on hold, and **Start** ends the hold. They run `flight-deck hold` and `flight-deck start`, and **Stop** runs `flight-deck stop`, which holds the runner before it ends every session (ADR 0007).
- The runner also holds itself short of the plan limits, as "What runs on the Mac, and how does it start each session?" decided. That hold ends on its own when the limit resets, and the menu shows when.
- **Stop** asks the maintainer to confirm while a session runs. Each stopped session's issue pauses without a flag (ADR 0011) and stays paused until the maintainer moves it.
- Usage shows the plan's five-hour window and its week, each with its reset time. On an API key, it shows spending against the daily and monthly caps (ADR 0007).
- One runner serves every repo on the Mac (ADR 0002), so the menu covers every factory on it and names each issue's repo. **Open Linear** opens the Needs you view.
- The menu and `flight-deck status` read the same state, which the runner rewrites at each poll, so they always agree. Both lag Linear by up to one poll, about a minute.
- When the runner's heartbeat is more than 3 minutes old, the icon says the runner isn't responding. Silence no longer hides a dead runner, though a closed lid still stops the factory.
- The menu posts no notifications. Flags reach the maintainer through Linear, and the runner posts a macOS notification only for trouble that stops it (ADR 0011).
- v1 has no fuller local UI: no board, no timeline, no spec numbers, and no local PR walkthrough. ADR 0020 already ruled out a published walkthrough. A fuller UI is a later effort.
- ADR 0024 decides how the app is built, shipped, and started, and where it first appears in the menu bar.
