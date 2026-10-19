# The runner flags the maintainer by assigning them

A hands-off maintainer needs to hear about the issues that need them, and only those. On the board, `/flight-log` was a session that wrote a daily brief and posted it as a comment. The runner applies every outbox, so it learns about each pause and each passed check as it happens, and it makes no model calls. So `/flight-log` is no longer a flow, and no brief replaces it. When an issue needs the maintainer, the runner flags it by assigning it to them. That covers a pause, a change ready for review once its bot round settles, a stale take, and an issue the runner files about trouble with the runner itself. Each time the runner takes an issue, it unsubscribes the maintainer, so the factory's handoff comments stay out of the maintainer's Linear inbox. Everything else the maintainer looks up when they choose: My Issues, two views that setup creates, and `flight-deck status`.

## Considered options

- **The board's daily brief.** A session would spend plan limits every weekday writing prose about a list of issue links. Each item on it either needs the maintainer now, and the next morning's brief is too late, or doesn't need them at all. A daily post that repeats unread notifications teaches the maintainer to skip it.
- **A view subscription on a "Needs you" view.** Setup could subscribe the maintainer under their own login. A view filters only on Linear fields, so its notification would fire when an issue enters In Review, before its bot round settles. ADR 0010 rules that out.
- **Leave subscriptions alone, and let the maintainer filter.** Linear puts every notification in the inbox, and no preference keeps one out. Preferences control only desktop, mobile, email, and Slack, so turning off comment push would also mute comments from people.

## Consequences

- ADR 0006 said the factory never sets an issue's assignee. While an issue sits in a factory status, the factory now owns its assignee. The runner clears an assignee set before the maintainer sent the issue, assigns the maintainer to flag it, and clears the assignee when the issue goes back into a factory queue. Outside the factory's statuses, the assignee is the maintainer's. The factory still never sets a delegate.
- Linear always subscribes an assignee, so a flagged issue's comments reach the maintainer until the flag clears. Clearing it sends "unassigned from you".
- The runner unsubscribes the maintainer at every take, not only the first, because a comment the maintainer posts on an issue subscribes them again.
- `flight-deck stop` flags nothing, because the maintainer stopped the factory. Follow-up issues, plan-limit holds, and landings flag nothing either. ADR 0012 flags each proposal that debrief files, because a proposal exists only to get the maintainer's decision.
- Trouble that stops the whole runner, such as an expired Claude login, leaves no issue to flag. The runner files one issue per cause in each affected factory's Triage (ADR 0013), flags it, and posts a macOS notification in case the Linear credential is what broke. The maintainer closes that issue, so the runner still closes issues in only the two cases the lifecycle allows.
- Silence can't tell a quiet day from a dead runner. launchd restarts a runner that crashes, and a closed lid stops the factory, as "What runs on the Mac, and how does it start each session?" accepted.
