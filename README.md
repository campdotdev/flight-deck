# Flight Deck

Flight Deck takes a labelled Linear issue on your repo to a pull request that you review and merge. It ships as a Claude Code plugin with two flows:

- `/flight-build` builds an issue and opens a draft pull request under your own GitHub login. For a bug labelled `flight-bug`, it reproduces the bug with a failing test before it fixes it. For a feature labelled `flight-feature`, it works from the acceptance criteria in your brief and proves each one the way the brief names. Write the brief as the issue's description, in the format of [`skills/brief/SKILL.md`](skills/brief/SKILL.md).
- `/flight-check` judges that draft in a fresh session. It proves the fix on the pull request's head commit, and the bug's test must fail on the base and pass on the head. It then runs the review skills. On a pass, it marks the pull request ready, labels the issue `review`, and assigns the issue to you. On findings, it posts them as a numbered list, removes the issue's flight status, and leaves the pull request a draft. Build doesn't answer findings yet, so for now you fix them or hand them on yourself.

## Install the plugin from a checkout

Clone this repo, then register it as a marketplace and install the plugin from it:

```sh
claude plugin marketplace add ~/path/to/flight-deck
claude plugin install flight-deck@flight-deck
```

After you pull new commits, run `claude plugin marketplace update flight-deck`, then `claude plugin update flight-deck@flight-deck`. To try a branch for one session without installing it, start Claude Code with `claude --plugin-dir ~/path/to/flight-deck`.

The flows need the Linear MCP server and a `gh` that is logged in as you.

## Set up a repo

1. In the repo's Linear team, add the labels `flight-bug` and `flight-feature`. Then add a single-select label group named `flight-status` with the labels `building`, `checking`, `review`, and `needs-you`.
2. Commit a repo record named `flight-deck.toml` at the repo root:

	```toml
	[labels]
	bug = "flight-bug"
	feature = "flight-feature"

	[build]
	reproduce = ["reproducing-bugs"]
	implement = []
	finish = []

	[check]
	review = []
	```

	`[labels]` names the entry labels. To use labels your team already has, rename them here. With `feature = "ready-for-agent"`, build takes issues labelled `ready-for-agent` and leaves `flight-feature` issues alone. Add the labels you name in step 1 instead of the defaults.

	Build follows `reproduce` for bugs only, and `implement` and `finish` for bugs and features. A bare name in a slot is one of Flight Deck's own skills in this repo's `skills/` folder, such as `reproducing-bugs`. Any other bare name, such as `tdd`, is a skill installed on your machine in `~/.claude/skills/`. A path, such as `.claude/skills/repro/SKILL.md`, is a skill in the repo itself.

	The record above fills only `reproduce`, with `reproducing-bugs`, Flight Deck's own fork for build. Fill the other slots with skills you have, such as `tdd` for `implement`, or `code-review` and `ponytail-review` for `review`. An empty slot means nothing to follow. With an empty `review` slot, check still proves the work, but no review skill reads the code, and the verdict says so.
3. Name the repo's Linear team and its install, test, and typecheck commands in its `AGENTS.md`. If the repo keeps worktrees in a set folder, name that folder in `AGENTS.md` or in a doc it points at.

## Run a flow by hand

In a Claude Code session in the repo, run `/flight-build SHA-12` to build one issue. When another skill has the same name, run `/flight-deck:flight-build SHA-12`. Run `/flight-build` with no issue to take the oldest ready issue of the highest priority. An issue is ready when it carries an entry label and no `flight-status` label.

When a flow can't go on without you, it pauses the issue. It posts a comment that opens with **Paused.** and says what you have to do, labels the issue `needs-you`, and assigns it to you. Build pauses, for example, on a bug it can't reproduce or on a brief with no acceptance criteria. To resume a paused build, answer in a comment, or edit the issue, and remove `needs-you`. The next build run takes the issue again and reads the comments you posted since the pause. To resume a paused check, replace `needs-you` with `checking`.

Build ends by labelling the issue `checking`. Run `/flight-check SHA-12` to judge its pull request, or run `/flight-check` with no issue to take the oldest `checking` issue of the highest priority. Check ends without a write while the pull request's CI still runs, so run it again once CI finishes. Its verdict, a comment on the issue, names the commit it judged. A commit pushed after the verdict has no verdict.

## Test the GitHub script

`bin/flight-github` makes every GitHub write the flows make. Its tests run it against a local bare repo and a stub `gh`:

```sh
bash test/flight-github.sh
```
