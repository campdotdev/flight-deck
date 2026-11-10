# Stream fixtures for the Claude Code adapter's parser

Spec 1 says the Harness contract suite (FLD-116) records these from real `claude -p` sessions on the maintainer's Mac, and the parser takes its fields, units, and time format from them.

Recorded from a real session:

- `init.json`, `rate-limit-event.allowed.json`, and `result.success.json`: lines from the FLD-33 check dry run `fld33-1` on Claude Code 2.1.310 (`prototype/check/evidence/sessions/fld33-1/stream.jsonl` on the branch `prototype/fld-51-menu-bar-app`). `resetsAt` is in Unix seconds, and `utilization` is a fraction of the window (0.04 is 4%).

Placeholders, written from Claude Code's documented format until FLD-116 records the real ones. Each file name starts with `placeholder.`:

- `placeholder.rate-limit-event.rejected.json`: a `rate_limit_event` whose `status` is `rejected`, shaped like the real allowed one.
- `placeholder.assistant.rate-limit-error.json`: an `assistant` message whose `error` is `rate_limit`.
- `placeholder.result.max-budget.json`: the `result` of a run that `--max-budget-usd` ended, with the SDK's `error_max_budget_usd` subtype.
- `placeholder.result.login-expired.json` and `placeholder.assistant.login-expired.json`: a revoked login, as a `result` and as an `assistant` message's error. They match the placeholder `login_expired_patterns` in `data/claude-code.toml`.
- `placeholder.stderr.login-expiring.txt`: Claude Code's warning that the login expires soon. It matches the placeholder `login_expiring_patterns`.

When FLD-116 records a real one, replace the placeholder file, drop its `placeholder.` prefix, and update the patterns in `data/claude-code.toml` to match.
