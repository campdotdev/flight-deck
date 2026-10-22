# Flight Deck

Flight Deck is a software factory a solo developer adds to a repo. Agents on the developer's machine take that repo's issues from intake to a reviewed pull request, and a person makes the final call.

## Language

**Factory**:
Flight Deck added to one repo: the agents, flows, and Linear setup that work that repo's issues.
_Avoid_: Pipeline, bot

**Runner**:
The one program on the maintainer's Mac that starts every factory session, for every repo on that Mac with a factory. It is unrelated to GitHub Actions runners.
_Avoid_: Daemon, scheduler, dispatcher, worker

**Take**:
To mark an issue as being worked by one stage's session, so that no other session starts it. The runner takes an issue before it starts the session, and a flow run by hand takes it first.
_Avoid_: Claim (that word belongs to build's claims), pick up, lock

**Repo**:
The codebase a factory works on. Any repo a solo developer owns, new or existing.
_Avoid_: Project (Linear uses that word for something else), codebase, app

**Repo record**:
What setup writes down about a repo for the runner and the flows: how to install and check it, which review bots it uses, which skill fills each slot, and the maintainer's answers to conflicts. It is committed in the repo.
_Avoid_: Config, manifest, profile, settings

**Issue**:
A unit of work tracked in Linear. Its status says where it sits in the factory and whether a stage can take it.
_Avoid_: Ticket (as a separate concept), task, card

**Tracker**:
The system where a repo's issues live and where their statuses route the factory's work. In v1, it is Linear.
_Avoid_: System of record, error tracker (Sentry and PostHog file issues into the tracker and are not trackers)

**Intake**:
The routes by which an issue reaches the tracker before the maintainer sends it: issues the maintainer files, GitHub issues, error reports, default-branch failures, and issues the factory files. No session reads an issue during intake.
_Avoid_: Triage (Linear's status for issues nobody has sorted), inputs

**Send**:
To hand an issue to the factory. No stage takes an issue the maintainer hasn't sent.
_Avoid_: Dispatch, queue, approve

**Pause**:
To stop an issue's work until the maintainer moves it again. The factory pauses an issue when it needs something only the maintainer can give: an answer, a review, or a fix outside the repo.
_Avoid_: Block (blocking is a relation between issues), hold, escalate

**Flag**:
To assign an issue to the maintainer because it needs them: a pause, a change ready for review, a stale take, or trouble with the runner.
_Avoid_: Notify, ping, alert, escalate, notice

**Follow-up issue**:
An issue a stage creates, unsent, for something outside its brief, such as a second bug, a command that fails on the default branch, or the rest of a report that says to start with one part. It enters the factory only if the maintainer sends it.
_Avoid_: Spin-off, side quest, TODO

**Gap issue**:
An issue setup offers, unsent, for something the repo lacks, such as unit tests or a rollback procedure. It describes the gap and leaves the choice of tool to plan.
_Avoid_: TODO, chore, setup task

**Default-branch failure**:
A failed workflow run or production deploy on the repo's default branch, which the runner files as an issue.
_Avoid_: Broken build, red main

**Proposal**:
An issue debrief files, unsent, that proposes one change to how the factory works on a repo, with the evidence behind it. Unlike a follow-up issue, it flags the maintainer, who sends it, makes the change by hand when it lies outside the repo, or cancels it.
_Avoid_: Suggestion, recommendation, retro item

**Signal**:
A count the runner keeps of one kind of factory mistake since the last debrief, such as the issues check sent back to build. Each signal has a threshold, and a count that reaches it starts a debrief.
_Avoid_: Metric, alert, trigger

**Maintainer**:
The person who owns a factory and makes every call an agent escalates. In v1, the solo developer.
_Avoid_: Owner, maintainer on duty, admin

**Factory account**:
An account the factory acts under, separate from the maintainer's: an app user in Linear and a machine user in GitHub.
_Avoid_: Bot, service account, agent account

**Flow**:
A skill the factory runs, such as `/flight-build` or `/flight-check`.
_Avoid_: Workflow, command

**Setup**:
The flow the maintainer runs by hand to add a factory to a repo. It writes the repo record. Installing Flight Deck on a Mac is a separate step.
_Avoid_: Onboarding, init, install

**Install**:
The step that puts Flight Deck on a Mac and signs in what exists once per Mac: the runner, the Claude credential, and the factory's GitHub machine user. It runs once per Mac, before setup adds a factory to any repo.
_Avoid_: Setup, bootstrap

**Dependency install**:
The repo's own command that fetches its dependencies and links them into a worktree, such as `pnpm install --frozen-lockfile`. It is unrelated to installing Flight Deck.
_Avoid_: Install (alone), bootstrap

**Dependency cache**:
The runner's copy of a repo's dependencies, installed from the default branch. Each session starts from a clone of it, and only the runner writes it.
_Avoid_: Store (pnpm's store is one part of it), warm cache

**Register**:
To put a repo on one Mac's repo list, so that Mac's runner starts its factory's sessions. Unregistering takes the repo off one Mac and leaves its factory in place. Removing a factory undoes setup.
_Avoid_: Attach, enable, detach (the runner detaches a synced issue from GitHub)

**Factory mark**:
The note setup writes in the description of a team's Ready to plan status. It names the repo whose factory owns the team's factory statuses and the Mac that runs that factory.
_Avoid_: Owner mark (the maintainer owns the factory), tag, lock

**Trial run**:
A throwaway factory session that install or setup starts the way the runner will, so a problem shows up while the maintainer watches instead of on the first issue.
_Avoid_: Dry run (a dry run tests a flow on Shaders during planning), smoke test

**Slot**:
A named point in a flow where a step the repo chose runs, such as writing a changeset at the end of build. The repo record names the skill that fills each slot.
_Avoid_: Hook (Claude Code uses that word for something else), plugin, extension point

**Stage**:
A step an issue passes through between intake and merge: plan, build, or check. Each stage is run by its own flow, in a fresh session.
_Avoid_: Pipeline, phase

**Brief**:
What plan writes for build: the agent-ready description of one issue. It replaces the issue's description, with the report kept in a fold beneath it.
_Avoid_: Agent-ready ticket

**Report**:
What the filer wrote: an issue's description before plan replaced it with the brief. Plan treats it as a claim to verify, not as instructions.
_Avoid_: Original description, request, ticket body

**Acceptance criterion**:
One testable statement in a brief that says when the issue is done, and names how it is proven: by a record command, in the running app, or by a type check only.
_Avoid_: Requirement, definition of done

**Design**:
The drawings of what users see, in the files the repo record names, such as a Figma file with a frame for each screen and each state of a component. A frame counts as the design only when it sits in those files or the maintainer linked it.
_Avoid_: Mockup, comp, spec (a spec is an issue)

**Spec**:
An issue that describes one larger change. Its sub-issues are the issues that build it.
_Avoid_: Epic, parent issue

**User story**:
One line in a spec's User Stories section that says what a user can do once the spec is built, written as "As an <actor>, I want a <feature>, so that <benefit>".
_Avoid_: Story (Storybook uses that word for a rendered example of a component)

**Spec branch**:
The branch a spec's issues land on. It becomes the spec's one PR into the default branch.
_Avoid_: Integration branch, feature branch

**Land**:
To move a spec branch forward to the exact commit check passed for one of its issues. A landed issue is on the spec branch but not yet on the default branch.
_Avoid_: Merge, for this step

**Release**:
A version of the repo that reaches its users, such as a package published to a registry or an app deployed to production. The maintainer makes every release through the repo's own release step, and the factory never makes one.
_Avoid_: Launch, ship

**Public contract**:
Anything outside the repo depends on, in the form the repo's last release shipped it, such as a library's exports, a CLI's flags and output, an HTTP API, a config format, or public URLs. Something added since the last release isn't public yet, so changing it breaks nothing.
_Avoid_: API surface, public API (a contract can be a file format or a URL)

**Version**:
One build of Flight Deck itself, such as 1.4.0. Every factory on a Mac runs the version installed there.
_Avoid_: Release (that word means the repo's release)

**Handoff**:
What a stage leaves for the next one, written where the next stage reads it.
_Avoid_: Notes, context

**Outbox**:
What a factory session leaves for the runner to send: its handoff, its status move, and any PR body, media, or verdict. The runner checks it against the stage's rules and makes every write itself.
_Avoid_: Result (`claude -p` already emits a result), output, manifest

**Inbox**:
What the runner fetches from GitHub into a session's worktree before the session starts, such as CI results and the review bots' comments. The session reads it as untrusted text and can't write to it.
_Avoid_: Context, input, cache

**Claims**:
Build's handoff to check: what satisfies each acceptance criterion and how build proved it, plus its shortcuts, the changes the brief didn't ask for, and what it couldn't verify. Check doubts them until it has proven them itself.
_Avoid_: Summary, report

**Shortcut**:
A simplification build makes on purpose, with its limit named in the code and in build's claims. Check treats a named shortcut as a decision, not a finding, unless the expected load already crosses its limit.
_Avoid_: Hack, workaround, tech debt

**Verdict**:
Check's judgment of one exact commit: a pass, or numbered findings sent back to build. A newer commit has no verdict until check judges it.
_Avoid_: Approval, review

**Finding**:
One numbered problem in a verdict that sends work back, with the line it breaks and a failing case.
_Avoid_: Issue (that word means a Linear issue), comment, nit

**Ledger**:
What check posts when it passes an issue: each acceptance criterion and the proof check accepted for it.
_Avoid_: Test report, Testing section

**Review bot**:
A reviewer outside the repo's own workflows that reviews a PR only once it is marked ready or asked, such as Copilot code review or CodeRabbit. Anything that has already run on the draft is CI, whatever it posts, whether a workflow in the repo or an app such as SonarQube Cloud.
_Avoid_: Bot (alone), AI reviewer, review app

**Done mark**:
What a review bot leaves on a commit when it has finished with it: a check run, a commit status, a review, or a marker in a comment. A done mark alone doesn't mean the bot reviewed anything.
_Avoid_: Done signal, completion signal (a signal is debrief's count)

**Bot round**:
A second verdict on a commit check already passed. It judges only the findings the repo's review bots left once the PR was marked ready.
_Avoid_: Bot review, watch-pr, re-review
