# Build proves each criterion the way the brief names it

Build turns a brief into commits that prove each acceptance criterion the way the brief names it, then hands its claims to check. Where the proof is a record command, build writes the test first and commits it failing before the code that makes it pass, so check can replay the test failing first (ADR 0028). Build pauses when the brief turns out wrong, when it's stuck, and on a merge conflict it can't resolve. It also pauses on an unclear or conflicting change request (ADR 0023), before handoff for a rendered file whose record entry says `pause`, except on a sub-issue (ADR 0022), and on a failed dependency install (ADR 0018). Its rules for a wrong brief mirror plan's (ADR 0026). It decides everything else itself.

Build has no review step. It runs the repo's commands, and check owns the judgment calls: standards, design, and how simple the code is. The repo's standards still reach build through `CLAUDE.md` and `AGENTS.md`, which every session loads (ADR 0007).

## Considered options

- **A review step in build,** such as the board's `/standards-review`. An agent that reviews its own code is biased toward it, and check reviews the diff in a fresh session anyway.
- **Rebasing onto the base.** A rebase would rewrite commits the runner may already have pushed, and it would hide the failing-test commit that check replays.
- **Build does what every finding says.** Build would follow a wrong finding into the code, including a bot finding that a stranger's comment steered on a public PR.

## Consequences

- Build works in this order:
	1. Read the repo record and run the dependency install.
	2. Read the brief and its Context, the parent spec for a sub-issue, the comment thread, the inbox, and the repo's glossary and ADRs. On rework, also read the latest findings and build's previous claims. Read the branch's commits as what an earlier build wrote.
	3. Prove each acceptance criterion the way the brief names it, test first where the proof is a record command.
	4. Run the `finish` slot (ADR 0003).
	5. Merge the base's latest tip: the spec branch for a sub-issue, and the default branch for a standalone issue or a spec.
	6. Run every local command and local extra in the record.
	7. For a standalone issue or a spec, write the PR title and body (ADR 0020).
	8. Write the claims and move the issue to Ready to check, or pause it.
- Build follows Flight Deck's fork of `tdd` (ADR 0014), which takes the brief's Key interfaces as the seams to write criterion tests at. A criterion proven by a record command gets a test in that command's category. Build commits the test failing, then the code that makes it pass, so commits come in pairs. A regression guard's test can pass before build's change, so it needs no failing commit. A refactor gets its own commit, made only while every test passes. A criterion proven in the running app or by a type check only needs no committed test. Build judges its other new tests by the two imagined edits from pstack's `principle-test-behavior-not-implementation`: break the behavior, then change only the internals.
- When a criterion's test would be a bad one, because it mostly tests mocks, depends on timing, or needs heavy infrastructure for a small fix, build uses the closest executable regression check and says why in its claims. That choice never pauses the issue, because check judges it.
- Commit messages follow the repo's format. Where the repo's release tooling reads commit messages, such as semantic-release or release-please, build marks the commit that carries an accepted break or an added contract in that format, from the brief's Key interfaces.
- On a bug, plan's reproduction becomes build's first failing test, and the commit that fixes it names the cause build confirmed. If the reproduction no longer fails at build's base, the brief is wrong, and build pauses. If plan marked the bug "not reproduced", build fixes it from the cause it finds and marks the criterion "unproven".
- For each frame the brief's Design part links, build reads the frame layer by layer and quotes each layer's value in its claims.
- While it writes code, build follows an unchanged copy of `ponytail` at `full` (ADR 0014). It marks each shortcut in the code with a `shortcut: <the limit>, <when to upgrade>` comment, as `ponytail` asks, and lists it in its claims. Check's reviewers never see the claims, so the comment is how they tell a deliberate shortcut from a mistake. The lines ponytail ends a reply with go in the claims.
- Build pauses when making the criteria pass would:
	1. need a new dependency,
	2. break a public contract, or add one whose shape the brief doesn't fix,
	3. span more than one seam,
	4. change what users see in a state that the brief's Design part doesn't cover, when the `design` slot checked it, or
	5. hit a criterion that contradicts the code or another criterion.

	Rule 2 also applies when merging the base pulls in a release that shipped a contract the change alters, because the change has become a break the brief never accepted. The pause says what build found and proposes a change to the brief, and its answer sends the issue to Ready to plan. When the Design part says "design not checked" or "no design for <area>", build follows the repo's existing UI, says so in its claims, and doesn't pause. These rules don't apply to what a change request explicitly asks for (ADR 0023), except that a change request accepts a break only when it says the old form stops working (ADR 0026).
- The runner tells build its deadline. When two fixes built on one premise fail the same test, build writes the premise down and tests it before it tries a third fix. Build pauses as stuck when it has dropped every premise it can test and a criterion still fails, or when about 15% of its time is left and a criterion still fails. The 15% is a starting value. The pause lists what build tried, what failed, and its best guess at the cause. Build never hands off a criterion it knows fails. A criterion it can't prove inside the sandbox goes to check marked "unproven".
- Build runs every local command and local extra in the record once, after the `finish` slot and the merge. While it works, it may run a narrower command the record holds, such as touched tests only. It commits a formatter's changes like any others. When a command fails, build reruns it at the base commit. If it fails there too, build didn't cause it. Build leaves it alone, lists it under what it couldn't verify, and files a follow-up issue (ADR 0013). If a criterion depends on that command passing, the brief is wrong, and build pauses.
- Build merges its base and never rebases. It resolves every conflict where it can keep both sides' intent. It reads both sides' commits, and the other side's issue through the Linear MCP server's read tools. It keeps both intents, invents no behavior, and reruns the commands. It pauses only when keeping one side's behavior would drop the other's. Check judges the result either way.
- On rework, build commits each finding's failing case as a test before the fix, whenever the case can run. Build may dispute a finding it believes contradicts the brief. It leaves the code as it is and answers the finding by number in its claims, with its reason and its evidence. Check then drops the finding or repeats it (ADR 0028).
- Build rewrites its claims and the PR body in full at every handoff, so check never stitches claims together across rounds. The claims have four parts:
	1. One claim per acceptance criterion. Each claim says what satisfies the criterion, which test or closest executable regression check proves it, and how build proved it: by a record command, in the running app, by a type check only, or unproven. It names the command build ran and the commit the claim covers.
	2. Each shortcut, with its limit.
	3. Each change the brief didn't ask for, with its reason.
	4. What build couldn't verify. Build never leaves the maintainer a check it could have run itself.

	The claims also answer each disputed finding by number, say how build handled each change request (ADR 0023), and carry each `finish` skill's line, such as "no changeset: docs-only change".
- A pause for a rendered file comes at step 8, after every other step. Its outbox holds the claims and the PR body, and the claims name each file the maintainer supplies. The maintainer's answer then goes straight to check, with no build session in between (ADR 0022). On a sub-issue, build doesn't pause for the file, and its claims say "rendered file: build on the spec asks for it".
