# Flight Deck

Flight Deck takes a labelled Linear issue on your repo to a draft pull request that you review and merge. It ships as a Claude Code plugin with one flow so far, `/flight-build`. That flow builds a bug labelled `flight-bug` or a feature labelled `flight-feature`, and opens a draft pull request under your own GitHub login. A bug is reproduced with a failing test before it is fixed. The feature path isn't written yet.

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
	implement = ["tdd"]
	finish = []

	[check]
	review = ["standards-review", "ponytail-review"]
	```

	Build follows `reproduce` for bugs only, and `implement` and `finish` for bugs and features. A bare name in a slot is a skill bundled in this repo's `skills/` folder. A path, such as `.claude/skills/repro/SKILL.md`, is a skill in the repo itself.
3. Name the repo's Linear team and its install, test, and typecheck commands in its `AGENTS.md`. If the repo keeps worktrees in a set folder, name that folder in `AGENTS.md` or in a doc it points at.

## Run a flow by hand

In a Claude Code session in the repo, run `/flight-build SHA-12` to build one issue. When another skill has the same name, run `/flight-deck:flight-build SHA-12`. Run `/flight-build` with no issue to take the oldest ready `flight-bug` of the highest priority. An issue is ready when it carries an entry label and no `flight-status` label.

## Test the GitHub script

`bin/flight-github` makes every GitHub write the flows make. Its tests run it against a local bare repo and a stub `gh`:

```sh
bash test/flight-github.sh
```
