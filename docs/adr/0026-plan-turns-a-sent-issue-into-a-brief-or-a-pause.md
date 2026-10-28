# Plan turns a sent issue into a brief or a pause

Plan is the first session to read an issue (ADR 0013). It turns a sent issue into a brief, or it pauses the issue. It never decides whether the work should happen, because the maintainer's send already did. Plan decides anything the brief can settle that is cheap to undo. It pauses only for decisions the maintainer lives with after the merge. The report, its spec, and the maintainer's own comments count as decisions already made. Anyone else's comments, such as a stranger's comment synced from GitHub, count as part of the report.

The brief says what to change and how much, and build decides how. Every acceptance criterion traces to the problem the report describes, and plan never copies the report's commands, URLs, or code into the brief as steps. Only plan writes the brief, and after plan only the maintainer edits it. Build and check never edit it. When either finds the brief wrong, it pauses the issue and proposes the change (ADR 0027, ADR 0028).

## Considered options

- **Plan creates the sub-issues of an issue too big for one build.** The split decides the shape of the change, so the maintainer makes it.
- **pstack's TIMEBOX, REPORT, STANDING, and FORBIDDEN fields in the brief.** The record's time limits, build's claims, the record with `AGENTS.md`, and the runner already cover them.

## Consequences

- Plan works in this order:
	1. Read the repo record and run the dependency install, as every session does.
	2. Read the report, the comment thread, the parent spec for a sub-issue, and the repo's glossary and ADRs if it has them.
	3. Look for a duplicate among the team's open issues, and for code that already does what the report asks.
	4. For a bug, run the `reproduce` slot (ADR 0003).
	5. Settle scope: the smallest change that fully covers the report. Then check the change against the contract, dependency, and size rules below.
	6. For a change users see, run the `design` slot.
	7. Write the brief and move the issue to Ready to build, or pause it.
- A duplicate doesn't pause. Plan marks the issue a duplicate of the open issue it matches (ADR 0007). Sentry and PostHog attach the error record's URL to each issue they file. Each folds an error's repeats into one record with a stable ID, and a Sentry regression keeps its ID, so two issues that link the same record are duplicates. PostHog's alert adds a timestamp and `utm_` parameters to the URL, so plan compares record IDs, not whole URLs. Code that already does what the report asks pauses the issue, and the pause names that code.
- Plan follows `ponytail` at `ultra` when it settles scope (ADR 0014). Ponytail's order for picking a change shapes the brief's scope and Context: skip what nobody asked for, then reuse what the repo has, then the standard library, then an installed dependency. Ultra's pushback becomes Out of scope, or a pause.
- Plan pauses when:
	1. The report doesn't say enough to write a testable acceptance criterion.
	2. The smallest change would drop an outcome the report asked for.
	3. The change breaks a public contract as the repo's last release shipped it: a library's exports, a CLI's flags and output, an HTTP API, a file or config format, a database schema, or public URLs.
	4. The change adds a public contract, or reshapes one added since the last release, and neither the report nor the spec fixes the shape. If one of them fixes it, plan writes the shape into the brief and continues.
	5. The change needs a new dependency.
	6. The change alters what users see, and the design draws its component or screen but not a state the change needs, or the change adds a screen or component that no frame draws. For a new screen or component, the pause proposes copying the nearest drawn one, so a one-word answer clears it.
	7. The issue is too big for one build.
- Three lines in the brief's Design part let a change users see go ahead without a case 6 pause:
	- "design not checked", when the `design` slot is empty (ADR 0003).
	- "no design for <area>", when the change touches an existing area the design never drew. Plan, build, and check treat it like "design not checked".
	- "no design needed", with the reason from a `## Design` section that says so, as `/flight-new` writes it (ADR 0013). It holds even for a new screen or component.

	A design-tool failure, such as a lapsed sign-in or a spent daily limit, pauses the issue with that reason and never becomes "design not checked". Only a call Figma refuses for its per-minute limit gets a retry first (ADR 0003).
- Plan pauses at the first case that needs the maintainer. Its pause lists every other case plan has found by then, so one answer clears them all, and it gives the answer plan proposes (ADR 0019).
- An issue is too big for one build when plan can't fill every field of the brief without guessing, or when its acceptance criteria span more than one seam that build would commit separately. Plan then pauses with a proposed split: sub-issue titles, one line each, and their blocking order. The maintainer makes the split, by hand or with `/flight-new`, and sends it as a spec. When the report orders its own work, such as "start with MeshGradient, then sweep the rest", plan briefs the first part and files the rest as follow-up issues instead of pausing.
- For a bug, plan tries to reproduce it with the record's commands or the running app, within half of plan's time limit in the record. It runs commands and throwaway scripts in its worktree and commits nothing, because only build writes code. The reproduction goes in the brief's Context: the steps, the command, and what happened. Plan continues if the bug reproduced, or if the expected outcome is clear enough for a testable criterion, and pauses otherwise. When the steps are clear but the sandbox can't reproduce the bug, such as a Safari-only bug, the brief says what plan tried and marks the bug "not reproduced".
- The brief follows Flight Deck's fork of Matt Pocock's `triage/AGENT-BRIEF.md` (ADR 0014). It has six fields and a Context section. The fields are Summary, Current behavior, Desired behavior, Key interfaces, Acceptance criteria, and Out of scope.
	- Key interfaces lists each public contract the change breaks or adds. Once the maintainer answers a pause about a break, plan marks that break as accepted.
	- Acceptance criteria marks each regression guard, whose test can pass before build's change.
	- Out of scope holds anything else the report asks for, unless it needs a new dependency or changes a contract, which pauses the issue.
	- Context holds pointers, not instructions: the parent spec for a sub-issue, plan's reproduction, related issues, the GitHub issue for a synced one (ADR 0008), and where plan looked in the code. Paths are allowed there. A fact plan found that settles how, such as a helper to reuse or the root cause, goes there too. Its Design part gives one line per state the change creates or alters, with that state's frame link.
- When an issue comes back to Ready to plan, plan rewrites the whole brief from the report, the thread, and the previous brief. It keeps the maintainer's answers, and any edits they made to the brief, as decisions. The fold keeps only the report, because Linear's description history holds the earlier briefs. The maintainer can also edit the brief and move the issue straight to Ready to build.
