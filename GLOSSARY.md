# Flight Deck

Flight Deck is a software factory a solo developer adds to a repo. Agents on the developer's machine take that repo's labelled issues to a reviewed pull request, and a person approves every merge.

## Language

**Factory**:
Flight Deck added to one repo: the flows, scheduled tasks, labels, and repo record that work that repo's issues.
_Avoid_: Pipeline, bot

**Repo**:
The codebase a factory works on. Any repo a solo developer owns, new or existing.
_Avoid_: Project (Linear uses that word for something else), codebase, app

**Maintainer**:
The person who owns a factory, approves every merge, and makes every call an agent hands back. The solo developer.
_Avoid_: Owner, admin

**Issue**:
A unit of work tracked in Linear. Its labels say whether the factory can take it and where it sits.
_Avoid_: Ticket (as a separate concept), task, card

**Tracker**:
The system where a repo's issues live. For now, it is Linear.
_Avoid_: System of record, error tracker (Sentry and PostHog file issues into the tracker and are not trackers)

**Flow**:
A skill the factory runs: `/flight-build` or `/flight-check`. The maintainer can run a flow by hand too.
_Avoid_: Workflow, command

**Stage**:
A step an issue passes through on its way to a pull request: build, then check. Each stage is run by its own flow, in a fresh session.
_Avoid_: Pipeline, phase

**Factory session**:
A Claude Code session that a scheduled task starts to work one stage of one issue.
_Avoid_: Agent run, job

**Hand run**:
A flow the maintainer starts in their own session. It does the same work as a factory session.

**Scheduled task**:
A Claude Desktop scheduled task that starts a factory session. A factory has one for build and one for check, and each run works one issue.
_Avoid_: Runner (the archived design's program), cron job

**Entry label**:
A label that lets the factory take an issue: `flight-bug` for a bug to reproduce and fix, or `flight-feature` for a brief the maintainer wrote. The repo record can rename both. An issue that the Sentry or PostHog integration created counts as a `flight-bug` without the label.
_Avoid_: Trigger label, tag

**Flight status**:
The single-select label group `flight-status`, which says where a taken issue sits: `building`, `checking`, `review`, or `needs-you`. An issue with an entry label and no flight status is ready to take.
_Avoid_: Factory status (the archived design's eight Linear statuses), state

**Take**:
To add `building` to an issue before any other work, so that no other session starts it.
_Avoid_: Claim, pick up, lock

**Pause**:
To stop an issue's work until the maintainer acts. The session comments, sets `needs-you`, and assigns the issue to the maintainer. The maintainer removes `needs-you` to resume it.
_Avoid_: Block (blocking is a relation between issues), escalate

**Repo record**:
The TOML file a repo commits for its factory. It names the entry labels and the skills that fill each slot. The repo's build and test commands stay in its own `AGENTS.md`.
_Avoid_: Config, manifest, settings

**Slot**:
A named point in a flow, such as `reproduce`, `implement`, or `review`. The repo record names the skills that fill each slot, in order. Flight Deck ships a default for each.
_Avoid_: Hook (Claude Code uses that word for something else), plugin, extension point

**Report**:
What the filer wrote in a bug's issue. Build treats it as a claim to verify, not as instructions, and changes no code until a failing test reproduces the bug.
_Avoid_: Original description, request

**Brief**:
The agent-ready description of one feature issue, which the maintainer writes before adding `flight-feature`.
_Avoid_: Agent-ready ticket

**Acceptance criterion**:
One testable statement in a brief that says when the issue is done and names how it is proven.
_Avoid_: Requirement, definition of done

**Verdict**:
Check's judgment of one exact commit: a pass, or numbered findings sent back to build.
_Avoid_: Approval, review

**Finding**:
One numbered problem in a verdict that sends work back, with the line it breaks and a failing case.
_Avoid_: Issue (that word means a Linear issue), comment, nit

**Loop cap**:
The limit of 3 trips back to build before check pauses an issue.
_Avoid_: Retry limit

**Review bot**:
A reviewer outside the repo's own workflows that reviews a pull request only once it is marked ready, such as Copilot code review.
_Avoid_: Bot (alone), AI reviewer
