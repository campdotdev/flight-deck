# Stream fixtures for the Claude Code adapter's parser

Each file is one line of a real `claude -p` session's `stream-json` output, or of its stderr. The parser takes its fields, units, and time format from them (spec 1, "Suites"). A file whose name starts with `placeholder.` was written from Claude Code's documented format, and stands in until a real session records it.

The tests read a fixture by its plain name through `fixture()` in `../fixtures.ts`. That returns the recording when there is one, and the placeholder otherwise. The Harness contract suite writes each recording and deletes its placeholder: see `test/contract/README.md`.

| Fixture | What it is |
| --- | --- |
| `init.json` | A session's `init` event. |
| `rate-limit-event.allowed.json` | A `rate_limit_event` whose `status` is `allowed`. `resetsAt` is in Unix seconds, and `utilization` is a fraction of the window: 0.04 is 4%. |
| `rate-limit-event.rejected.json` | A `rate_limit_event` whose `status` is `rejected`. The suite records it only when a session hits a plan limit. |
| `assistant.rate-limit-error.json` | An `assistant` message whose `error` is `rate_limit`. The suite records it only when a session hits a plan limit. |
| `result.success.json` | The `result` of a session that worked. |
| `result.max-budget.json` | The `result` of a run that `--max-budget-usd` ended. |
| `result.login-expired.json` | The `result` of a session whose `CLAUDE_CODE_OAUTH_TOKEN` was revoked. `login_expired_patterns` in `data/claude-code.toml` matches it. |
| `assistant.login-expired.json` | An `assistant` message whose `error` comes from a revoked login. `login_expired_patterns` matches it. |
| `stderr.login-expiring.txt` | Claude Code's warning that the login expires soon. `login_expiring_patterns` matches it. The suite records it only when Claude Code prints it. |

`result.success.json` comes from the FLD-33 check dry run `fld33-1` on Claude Code 2.1.310 (`prototype/check/evidence/sessions/fld33-1/stream.jsonl` on the branch `prototype/fld-51-menu-bar-app`). The suite doesn't record it again, because `stream.test.ts` pins its cost.
