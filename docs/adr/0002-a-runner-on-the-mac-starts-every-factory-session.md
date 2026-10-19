# A runner on the Mac starts every factory session

Flight Deck ships a program as well as skills. One runner per Mac, kept alive by launchd, polls Linear and GitHub about once a minute and starts every factory session as a `claude -p` run of the unmodified Claude Code binary. One runner serves every repo on the Mac with a factory, because those repos share one Claude plan's limits. Taking issues, the concurrency cap, worktrees, and recovery from failed sessions are code in the runner, not instructions in a prompt.

## Considered options

- **The board's routines, as one launchd job per flow.** Flight Deck would ship only skills and plists. An issue would wait up to an hour between stages. Every tick would spend a session from the plan limits just to look for work. The rules for taking issues and for recovery would live in prompt text that a session can ignore.
- **Claude Code's own schedulers.** Desktop scheduled tasks need the app open. `/loop` needs an open session and expires after 7 days. `claude --bg` is a research preview that needs an interactive trust step for each folder. None of them starts a session when an issue changes in Linear.
- **An Agent SDK program instead of `claude -p`.** It adds a permission callback and typed events. Anthropic's terms tell products built on the Agent SDK to use API keys, so the SDK would rule out running the factory on the maintainer's subscription.

## Consequences

- Factory sessions load the repo's config and Flight Deck, and nothing from the maintainer's user setup. The runner passes `--setting-sources project,local`, then adds Flight Deck and the Linear MCP server back explicitly. A maintainer's personal `CLAUDE.md` rules, such as using GitButler, never reach a factory session. ADR 0007 narrows the flag to `--setting-sources project` and locks what each session loads.
- Installing Flight Deck means installing the runner and its launchd agent. A Claude Code plugin can't do that on its own, because every process a plugin declares stops with its session.
