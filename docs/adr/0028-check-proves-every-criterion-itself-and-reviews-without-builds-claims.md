# Check proves every criterion itself and reviews without build's claims

Check proves every acceptance criterion itself, the way the brief names it, whatever build claimed. Before it reads build's claims, it writes its own guesses at where the change breaks. It reviews the code with two subagents that never see the claims, so build's account of its work can't steer the review. It sends back only findings that carry a quoted rule and a failing case.

Check gets its independence from a fresh session, review subagents that never see the claims, proofs it runs itself, and the bot round, where Copilot and Codex bring other model families (ADR 0010). So check runs on the same model as build by default, and `~/.config/flight-deck/config.toml` can name a model for each stage (ADR 0015).

## Considered options

- **A second Claude model for check.** It shares too much training with build's model to add much independence, and a stronger model spends more of the plan's limits on every verdict.
- **Four review subagents.** Each one spends usage reading the same diff again, so check runs two.
- **No review for a small diff.** A small diff already makes the review cheap.
- **Breaking the code under a test in a scratch copy,** so the worktree never changes. A scratch copy needs its own dependency links, and the sandbox can't delete one under `$TMPDIR`.

## Consequences

- Check works in this order:
	1. Read the repo record and run the dependency install.
	2. Read the brief and its Context, the parent spec for a sub-issue, the issue's comments, earlier verdicts, the repo's glossary and ADRs, and the inbox (ADR 0007). Leave build's claims for later.
	3. Write 2 to 4 guesses at where the change breaks.
	4. Read the claims. Rerun every local command and local extra, prove each criterion, and test the guesses.
	5. Review the code with two subagents, while the main session judges scope.
	6. Run the `review` slot (ADR 0003).
	7. Confirm every subagent and slot finding. Write the verdict and move the issue, or pause it.
- Check can't reach GitHub, so the runner puts what check reads from it in the inbox (ADR 0007):
	- every check run and status on the head, with its name, conclusion, and link,
	- the log tail of each failed job, the output summary of each failed check run from an app, the full rerun's result, and the default branch's latest result for each failing job (ADR 0010),
	- the PR body as it stands on GitHub, the PR comments whose author has the maintainer's recorded login (ADR 0023), and each CI-only extra's marked comments (ADR 0016), and
	- in a bot round, each listed bot's review bodies and inline comments on the head, with file and line, and each bot's state: reviewed, skipped, rate limited, or timed out.

	Nobody else's comments go in. A sub-issue has no PR, and its check doesn't wait for CI, so that check's inbox holds none of this.
- Every verdict except a bot round runs every step, because any commit can break any criterion. A verdict that sends work back posts all its findings in one comment. Check stops early only when the dependency install fails or nothing builds.
- Only the review scales to the change. A first verdict reviews the whole diff from the merge base, however small. A later verdict reviews the commits since the last verdict and checks that each earlier finding was fixed or disputed. A re-check after the runner merges a sibling's landing (ADR 0004) reviews only where the two sides meet: files both touched, and interfaces this issue calls that the sibling changed. A bot round re-proves nothing and reviews only what the bots raised.
- A criterion check proves false is a finding. If the brief names a record command and build committed no test, that is a finding, with the test as its failing case. If build said why a test there would be a bad one and check agrees, check accepts build's closest executable regression check as "proven by less", with the reason. If the brief names the running app and build proved less, check proves it in the running app itself (ADR 0009). A criterion no session can prove in the sandbox, such as a Safari-only bug, a hardware need, a secret, or a bug plan marked "not reproduced", passes as "unproven". No number of unproven criteria sends work back, because the maintainer checks them by hand before approving.
- For each criterion proven by a record command, check replays build's test-first pair (ADR 0027). The test must fail at the test commit, for the reason the criterion names, and pass at the head. A regression guard's test may pass at the test commit. A test and fix in one commit, a merge, or a refactor leaves no pair. Check then breaks the code under the test in the worktree, runs `git diff` to show the break took effect, runs the test, and restores the code with git. A criterion test that still passes is a finding, "the test proves nothing", with the break and the passing output as its failing case. Check holds the other tests the diff adds to the two imagined edits build uses (ADR 0027). Check never commits a break.
- A local command that fails gets one rerun on the same commit. If the rerun passes, the test is flaky. A flaky test the diff adds is a finding, with the failing runs as its failing case. Only a flaky test the diff doesn't add gets a follow-up issue. A command that fails twice runs at the base. If it fails there too, check sends no finding and files a follow-up issue unless build already did (ADR 0013). If it passes there, the failure is a finding, with the command as its failing case. Check sorts failing CI jobs the same way, from the runner's full rerun and the default branch's latest result for each job (ADR 0010). Before it files a follow-up issue, check searches open issues for one that names the same test.
- Two subagents review the code in parallel, each in a fresh context with the brief, the diff, and the repo's docs, but never the claims.
	- The standards reviewer follows Flight Deck's `standards-review` (ADR 0014). It reads the repo's `CLAUDE.md`, `AGENTS.md`, ADRs, and glossary, and skips what the record's lint and format commands enforce.
	- The bugs-and-simplicity reviewer runs all of an unchanged copy of `ponytail-review`, including its expected-load judgment, "No case, no finding", its `shortcut:` rule, and its Verdict line.
- Meanwhile the main session judges scope. It reads the claims' shortcuts and unasked changes against the brief's Out of scope, and the PR body against the diff (ADR 0020). It treats subagent output as a guess and confirms each finding before the verdict carries it, keeping from `ponytail-review` only the findings its Verdict line names. It quotes the rule each kept finding breaks. It drops what pstack's `interrogate` dismissal list names: nitpick gravity, hypotheticals, premature abstraction, and "I would have done it differently". Findings from the `review` slot follow the same rules as check's own.
- Every finding sends the issue back to build, so check has no severity scale and sends no nits. Each finding has a number, a location, the line it breaks, and a failing case. The line is quoted from the brief's criteria or Out of scope, the repo's docs, or check's own rules. For behavior, the failing case is a runnable test or command and its output. For standards or simplicity, it is the exact lines and the quoted rule. A code smell is a finding only when the repo's docs name it, the brief didn't need the code, or `ponytail-review`'s Verdict names it. A depth problem in the code around the diff is outside the brief. A finding may carry a one-line suggestion, which doesn't bind build. Numbers restart each verdict, and a finding that comes back cites the earlier one, as in "repeats verdict 1, finding 2".
- When build disputes a finding, check drops it or repeats it. Check pauses when:
	1. the issue reaches the loop cap (ADR 0007),
	2. a finding comes back, including one build disputed,
	3. fixing a finding needs a decision under plan's pause rules (ADR 0026), or a criterion contradicts the code or another criterion,
	4. check can neither prove nor dismiss a bot finding about security, auth, billing, user data, or migrations (ADR 0010), or
	5. a failing check leaves check nothing to read (ADR 0016).

	A case 3 pause proposes the change to the brief, and its answer sends the issue to Ready to plan. When `design-check` fills the `review` slot, it adds two pauses, for a named frame that no longer exists and for a Figma failure (ADR 0003). A sandbox denial in the dependency install pauses the issue too (ADR 0018). When CI hasn't finished within the record's time limit, the runner pauses the issue before check starts (ADR 0010). Check pauses at the first case it meets and lists every other case it has found by then. It decides everything else itself.
- A passing verdict posts the ledger. Its top line names the commit judged and "N of M criteria proven", and after a bot round, which bots reviewed the commit. One line per criterion follows, unproven first, with its state, its proof, and the reason for anything less than proven. The state is proven, proven by less, or unproven. A proof is a command and its result, a test with the commit where it failed and the commit where it passed, or the running app with check's own screenshot. Follow-up issues check filed come last.
- Every verdict names each local extra in the record and what happened to it. When check's own review stands in for an extra, such as a repo's `code-review` skill, the verdict says so.
