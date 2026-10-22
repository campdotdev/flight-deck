# Review bots see a PR only after check passes it

Build opens every PR as a draft, and almost every common review bot skips drafts by default, including Copilot's automatic review, CodeRabbit, Codex, Greptile, Cursor Bugbot, Sourcery, and Claude. The factory leaves that default alone. Check starts once CI has finished on the head commit and waits for no bot. When check passes a commit, the runner marks the PR ready, and the bots review that commit then. Copilot's ruleset review, CodeRabbit, Claude Code Review, and Qodo all review a draft when it's marked ready, and Cursor Bugbot did on the PRs observed. So a bot reviews only commits that check has passed, and a round that check sends back costs no bot reviews.

The maintainer still sees the bots' findings judged. If any bot left a finding on the head, the runner moves the issue from In Review back to Ready to check, and check judges the same commit again, with the bots' reviews as its only new input. That second verdict is the bot round. If no bot left a finding, no session runs.

## Considered options

- **Setup turns on draft review for each bot, and check waits for every bot on the draft.** This was the rule from "What stages does an issue pass through, and what does each hand the next?". Every trip back to build would cost a review from each bot, and bots cap their re-reviews: CodeRabbit pauses after 5 reviewed commits, and Sourcery stops after 5 automatic re-reviews. Codex documents no draft setting at all.
- **Build opens the PR ready, and `flight-deck/check` alone says that check hasn't passed.** The bots would review every round here too, and GitHub would show the maintainer a ready PR that check hasn't judged.
- **Bot findings go to the maintainer untouched.** No session would run after check passes. The maintainer would sort every bot nitpick by hand, and on a public PR a stranger's comment can steer what a bot says.

## Consequences

- The bot round is a verdict like any other. When it sends work back, the runner returns the PR to draft and sets `flight-deck/check` to `failure`, and the trip counts toward the loop cap of 3.
- The runner gains one move of its own: from In Review to Ready to check, when a bot leaves a finding on a commit that check passed. The runner's code enforces it with the rest of the lifecycle (ADR 0007).
- Check drops a bot finding with a one-line reason, and the runner resolves that finding's review thread. A bot finding about security, auth, billing, user data, or migrations that check can neither prove nor dismiss with evidence pauses the issue.
- Each listed bot has a done rule, which reads the bot's done mark and holds its re-trigger. Flight Deck ships the rules, and the repo record names the bots (ADR 0016). Copilot's ruleset review fires only the first time a draft goes ready, and nobody has tested whether the author's own Copilot setting does the same. So when the runner marks ready a PR that a bot has already reviewed, it sends that bot's re-trigger, such as a new review request or `@coderabbitai review`.
- A bot that skipped, hit a rate limit, or timed out counts as "didn't review" for that commit, and the runner stops waiting on it.
- The spec PR takes the same path. The spec check passes, the runner marks the PR ready, and a bot round follows.
- `/flight-log` announces a change as ready only after its bot round settles.
- Setup leaves each bot's draft review off. A bot reviews a factory PR only if the machine user qualifies for it. Copilot reviews automatically only the PRs of authors with access to Copilot code review, through a ruleset or the author's own setting, and Copilot Free doesn't include code review. On Shaders, which has no Copilot ruleset, the machine user needed Copilot Pro and its own automatic review turned on. Greptile ignored the machine user's `@greptileai review` there. CodeRabbit reviews only authors with a seat, and on a public repo with fewer than 10 stars it needs a manual trigger.
