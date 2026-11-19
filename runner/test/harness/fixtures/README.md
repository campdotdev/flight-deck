# Stream fixtures for the Claude Code adapter's parser

Spec 1 says the Harness contract suite (FLD-116) records these from real `claude -p` sessions on the maintainer's Mac, and the parser takes its fields, units, and time format from them.

Recorded from a real session:

- `init.json`, `rate-limit-event.allowed.json`, and `result.success.json`: lines from the FLD-33 check dry run `fld33-1` on Claude Code 2.1.310 (`prototype/check/evidence/sessions/fld33-1/stream.jsonl` on the branch `prototype/fld-51-menu-bar-app`). `resetsAt` is in Unix seconds, and `utilization` is a fraction of the window (0.04 is 4%).
- `result.max-budget.json`: the `result` of a `claude -p` run on Claude Code 2.1.325 that `--max-budget-usd 0.01` ended after one turn, recorded on 2026-11-15 from a scratch folder, with only the Read tool and a prompt to read several files one at a time. Its subtype is `error_max_budget_usd`, and `errors` holds the message. One field, `credential_expires_at` (the login's expiry), was removed before commit, because the repo is public and the parser never reads it.

Placeholders, written from Claude Code's documented format until FLD-116 records the real ones. Each file name starts with `placeholder.`:

- `placeholder.rate-limit-event.rejected.json`: a `rate_limit_event` whose `status` is `rejected`, shaped like the real allowed one.
- `placeholder.assistant.rate-limit-error.json`: an `assistant` message whose `error` is `rate_limit`.
- `placeholder.result.login-expired.json` and `placeholder.assistant.login-expired.json`: a revoked login, as a `result` and as an `assistant` message's error. They match the placeholder `login_expired_patterns` in `data/claude-code.toml`.
- `placeholder.stderr.login-expiring.txt`: Claude Code's warning that the login expires soon. It matches the placeholder `login_expiring_patterns`.

When FLD-116 records a real one, replace the placeholder file, drop its `placeholder.` prefix, and update the patterns in `data/claude-code.toml` to match.
