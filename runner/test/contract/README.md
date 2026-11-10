# How to run the contract suites and probes on your Mac

Spec 1 pins `socket_name_bytes`, `login_expired_patterns`, and the parser's fixtures from real runs on your Mac, before its build is first installed. The production-adapter halves of these suites do that. They need your credentials, so CI skips them. Each one runs only when `FLIGHT_DECK_CONTRACT` names it.

| Part | File | Runs against |
| --- | --- | --- |
| `tracker` | `tracker/linear.test.ts` | Real Linear, on the Shaders team |
| `harness` | `harness/claude-code.test.ts` | Real `claude -p` sessions |
| `lockdown` | `probes/lockdown.test.ts` | One real session, with the real Linear adapter |
| `instructions` | `probes/instructions.test.ts` | One real session, over `--input-format stream-json` |

The in-memory and scripted halves, `tracker/memory.test.ts` and `harness/scripted.test.ts`, run in every `bun test`. So do the rig, pin, and GraphQL checks in `support/` and `tracker/linear-queries.test.ts`.

## Before you start

1. Merge FLD-99 first. The Harness suite measures sandbox-runtime's sockets with the pinned copy in `vendor/sandbox-runtime/`.
2. Use Bun 1.4.3. `bun --version` must print `1.4.3`.
3. Run `bun install --frozen-lockfile` in `runner/`, and again in `vendor/sandbox-runtime/`.
4. Create the Flight Deck Reader app in campdotdev, by hand, with only the `read` scope.
5. Run `flight-deck login linear campdotdev`. It writes `~/.config/flight-deck/credentials.env` with these five keys:

	```
	LINEAR_APP_ID_CAMPDOTDEV=...
	LINEAR_APP_SECRET_CAMPDOTDEV=...
	LINEAR_READER_ID_CAMPDOTDEV=...
	LINEAR_READER_SECRET_CAMPDOTDEV=...
	LINEAR_SETUP_KEY_CAMPDOTDEV=...
	```

	If your build doesn't have `login linear` yet (FLD-113), write the file yourself with mode `0600`.
6. Check that your own `gh` login can open and close issues on `campdotdev/shaders`: `gh auth status`. The suites never use the machine user's `gh` config.
7. Check that `claude` is on your `PATH` and logged in to your subscription. To run a different `claude`, set `FLIGHT_DECK_CLAUDE` to its path.
8. Make a revoked Claude Code OAuth token. Run `claude setup-token`, copy the token it prints, then revoke that token in your Claude account settings. Keep the token for the Harness run below. A token that was never valid gives a different error, so use one you revoked.
9. Pick a scratch GitHub repo that the machine user can push to. The lockdown probe's session tries to push a branch to it, so a push the sandbox let through would show there.

Run the parts in the order below, from `runner/`. The Tracker suite checks both Linear apps before the sessions need the Reader app.

## Run the Tracker contract suite

```
FLIGHT_DECK_CONTRACT=tracker bun test test/contract/tracker
```

It files scratch issues in Triage on the Shaders team as the Flight Deck app, and cancels each one as you when it ends. Its detach test opens one GitHub issue on `campdotdev/shaders` through your own `gh`, waits up to 5 minutes for Linear's GitHub Issues Sync to bring it and a comment over, and closes it when the suite ends.
It writes `test/tracker/fixtures/linear-contract.json`: what real Linear returned for each fact the Linear adapter assumes. Those facts are which comment field marks a synced comment, the sync attachment's `sourceType`, what a duplicate relation alone does, which way a `blocks` relation reads, the "not found" error, and that a Reader token can't write. Compare `duplicate_relation_alone` with the FLD-111 note on `markDuplicate`, which sends the relation and the status change as two mutations.

If it fails:

- An assertion in "the Tracker contract, against the Linear adapter" means real Linear doesn't do what the in-memory adapter models. Change the in-memory adapter and the Linear adapter to match Linear, then run both halves again.
- "Cancel these scratch issues by hand" names issues the suite couldn't cancel. Cancel them in Linear.
- A sync step that didn't happen within 5 minutes means the GitHub Issues Sync is off for Shaders, or slow. Check it in Linear's settings, then run the suite again.

## Run the Harness contract suite

```
FLIGHT_DECK_REVOKED_OAUTH_TOKEN=<the revoked token> FLIGHT_DECK_CONTRACT=harness bun test test/contract/harness
```

It starts six real `claude -p` sessions on your subscription, each under your real session root, `/Users/Shared/flight-deck/<you>/`. It keeps its own data folder in `~/.local/share/flight-deck-contract/`, where every transcript stays after the run.

It writes these files:

- `data/limits.toml`: `socket_name_bytes`, the longest socket path that Claude Code's sandbox and sandbox-runtime make under a session's `tmp/`. A run of 3 or more digits counts as 5 bytes, because it may be a process ID.
- `data/claude-code.toml`: `login_expired_patterns`, from the session it starts with the revoked token.
- `test/harness/fixtures/`: `init.json`, `rate-limit-event.allowed.json`, `result.max-budget.json`, `result.login-expired.json`, and `assistant.login-expired.json` when the revoked token produces one. Each recording replaces its `placeholder.` file.
- When a session hits a plan limit, `rate-limit-event.rejected.json` or `assistant.rate-limit-error.json`.
- When Claude Code warns that your login expires soon, `stderr.login-expiring.txt` and `login_expiring_patterns`. Your login has to be close to expiry for that, so most runs keep the placeholder. Run the suite again when Claude Code shows the warning.

At the end it prints what it wrote and what it left as a placeholder. It also prints each Linear read tool that Linear's MCP server lists and the allow list lacks. A missing tool doesn't fail the suite. Adding one is a spec change you make.

If it fails:

- "socket_name_bytes is N, and ... passes 103 bytes" means a session's temp folder can't hold the sockets under your session root. The spec has a bug. The suite pinned nothing. Don't install spec 1's build until the spec changes.
- "the session never called X" means the model skipped a step. Run the suite again. "X was denied" means `settings.json` doesn't allow a tool this Claude Code version needs. That's a spec change.
- "Set FLIGHT_DECK_REVOKED_OAUTH_TOKEN" means you left it out. "no error in its transcript" means the token still works. Revoke it, then run the suite again.
- An assertion in "the Harness contract, against a real claude -p session" means the Claude Code adapter doesn't match this Claude Code version. The test names the step.

## Run the lockdown probe

```
FLIGHT_DECK_CONTRACT_PUSH_REPO=<owner/repo> FLIGHT_DECK_CONTRACT=lockdown bun test test/contract/probes/lockdown.test.ts
```

It files one scratch issue on Shaders, then starts one session that tries each act ADR 0007 forbids and writes what stopped each one to `lockdown.json` in its outbox. The test doesn't trust that report alone. It passes when the report says every act was blocked and the evidence agrees:

- The transcript shows a try at each act.
- No file appears outside the allowed paths.
- The repo's `SessionStart` hook leaves no marker.
- The local bare repo and your push repo get no branch.
- Flight Deck's clone and the worktree's own `.git` don't change.
- `runner.sock` hears only the session's `headersHelper`.
- The transcript shows each Linear write and each WebFetch of `github.com` denied by permissions.
- The scratch issue's `updatedAt` doesn't change.

It writes `<session root>/worktrees/CLAUDE.md` while it runs and removes it at the end, so don't run it while a runner is taking issues.

It writes nothing to commit. It prints whether sandboxed Bash could read the Keychain. That read is a known gap (ADR 0007), so it doesn't fail the probe.

If it fails, a session can do something ADR 0007 forbids, or the probe proved nothing for one act. Each line of the failure names the act. Don't install spec 1's build until a rerun passes. "the transcript shows no try at X" means the model skipped a step: run the probe again. If `<session root>/worktrees/CLAUDE.md` exists before the run, the probe refuses to start. Read that file, remove it, then run the probe again.

## Run the instructions probe

```
FLIGHT_DECK_CONTRACT=instructions bun test test/contract/probes/instructions.test.ts
```

It starts one session on a repo where every instruction file holds its own canary line, then sends three messages: one that reads a file in `sub/`, starts a subagent, and prints a variable, then `/compact`, then one that asks again. It passes when the first and third answers hold the canaries of both root `CLAUDE.md` files, the imported file, the unscoped rule, and `AGENTS.md`. The subagent's answer must hold the same canaries, except `AGENTS.md`. No answer may hold another canary. The variable from the repo's settings must be empty, and the `init` event must list neither the repo's skill nor its subagent. It also writes `<session root>/worktrees/CLAUDE.md` and `outside.md` beside it, and `~/fd-instructions-probe-<token>.md`, and removes them at the end.

It writes nothing to commit.

If it fails, Claude Code changed what reaches a session. The failure lists each canary that went missing or showed up. Treat it as a Claude Code change: decide whether the spec's instruction rules still hold before you install.

## Commit what the runs wrote

1. Run `git diff ../data test/harness/fixtures test/tracker/fixtures`.
2. Read each recorded fixture. Remove anything private you don't want in the repo, such as a path or an email address, and keep the fields the parser reads.
3. Check that each new pattern in `data/claude-code.toml` matches only the error it came from.
4. Run `bun test test/harness test/contract`. The parser's tests now read the recordings.
5. Commit the changes.

To run every part in one go, set `FLIGHT_DECK_CONTRACT=1`, `FLIGHT_DECK_REVOKED_OAUTH_TOKEN`, and `FLIGHT_DECK_CONTRACT_PUSH_REPO`, then run `bun test test/contract`.
