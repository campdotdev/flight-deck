# Flight Deck

Flight Deck is a software factory a solo developer adds to a repo. Agents on the developer's machine take that repo's issues from intake to a reviewed pull request, and a person makes the final call.

## Language

**Factory**:
Flight Deck added to one repo: the agents, flows, and Linear setup that work that repo's issues.
_Avoid_: Pipeline, bot

**Runner**:
The one program on the maintainer's Mac that starts every factory session, for every repo on that Mac with a factory. It is unrelated to GitHub Actions runners.
_Avoid_: Daemon, scheduler, dispatcher, worker

**Factory session**:
A Claude Code session that works unattended, such as one stage of one issue or a debrief. It holds no write credential and leaves an outbox for the runner to send. A flow the maintainer runs by hand is a hand run, not a factory session.
_Avoid_: Agent run, job

**Take**:
To move an issue into one stage's working status, such as Planning, Building, or Checking, so that no other session starts it. The runner takes an issue before it starts the session, and a flow run by hand takes it first.
_Avoid_: Claim (that word belongs to build's claims), pick up, lock

**Factory status**:
One of the eight statuses setup adds to a repo's team: Ready to plan, Planning, Ready to build, Building, Ready to check, Checking, Landed, and Paused. The team's own statuses, such as In Review and Done, aren't factory statuses, even when the factory moves an issue into one.
_Avoid_: Lifecycle status, factory state

**In flight**:
A sent issue is in flight while it's still the factory's: while it sits in a factory status, or in In Review because check passed it. The runner owns the assignee and the subscribers of an in-flight issue.
_Avoid_: Sent issue (an issue stays sent after it merges), factory issue, active

**Queue**:
A factory status where a sent issue waits for one stage to take it, named "Ready to" plus the stage, such as Ready to build.
_Avoid_: Ready state, backlog (Backlog is a status the factory never takes from)

**Working status**:
A factory status where one stage's session works an issue, named with the stage's verb, such as Building.
_Avoid_: In Progress (a Linear status outside the factory), active status

**Stale take**:
An issue that sits in a working status past its stage's time limit with no take the runner recorded, such as one a flow run by hand never finished.
_Avoid_: Orphan, stuck issue

**Hold**:
The runner's state of starting no new session on an issue, and no cache refresh, while running ones finish. The maintainer holds the runner and starts it again, and the runner holds itself short of the plan limits on a subscription, or at its spending caps on an API key. An update drains the runner, which holds until its running sessions finish and then restarts on the new version.
_Avoid_: Pause (an issue's state), suspend

**Concurrency cap**:
The most sessions the runner runs at once, across every repo on its Mac.
_Avoid_: Session cap, slot (a slot is a point in a flow)

**Repo**:
The codebase a factory works on. Any repo a solo developer owns, new or existing.
_Avoid_: Project (Linear uses that word for something else), codebase, app

**Repo record**:
What setup writes down about a repo for the runner and the flows: its dependency install and how to check it, which review bots it uses, which skills fill each slot, and how the maintainer settled each conflict between the repo's instructions and a flow. It is committed in the repo.
_Avoid_: Config, manifest, profile, settings

**Issue**:
A unit of work tracked in Linear. Its status says where it sits in the factory and whether a stage can take it.
_Avoid_: Ticket (as a separate concept), task, card

**Tracker**:
The system where a repo's issues live and where their statuses route the factory's work. In v1, it is Linear.
_Avoid_: System of record, error tracker (Sentry and PostHog file issues into the tracker and are not trackers)

**Intake**:
The routes by which an issue reaches the tracker before the maintainer sends it: issues the maintainer files, GitHub issues, error reports, default-branch failures, and issues the factory files. Intake starts no session.
_Avoid_: Triage (Linear's status for issues nobody has sorted), inputs

**Detach**:
To turn off Linear's sync between an issue and the GitHub issue it came from. The issue keeps its link to the GitHub issue, but no change on either side reaches the other.
_Avoid_: Unlink, unsync

**Send**:
To hand an issue to the factory. No stage takes an issue the maintainer hasn't sent.
_Avoid_: Dispatch, queue (a queue is a status), approve

**Pause**:
To stop an issue's work until the maintainer answers or moves it again. The factory pauses an issue when it needs something only the maintainer can give: an answer, a review, a rendered file, or a fix outside the repo.
_Avoid_: Block (blocking is a relation between issues), hold (the runner's state), escalate

**Answer**:
One of the one-word replies a pause offers the maintainer, each tied to the status the issue moves to next.
_Avoid_: Option, choice, command

**Flag**:
To assign an issue to the maintainer because it needs them: a pause, a change ready for review, a stale take, a proposal, a review bot that stopped reviewing, or trouble with the runner.
_Avoid_: Notify, ping, alert, escalate, notice

**Status line**:
The first line of every comment the factory posts in Linear: a colored dot, a status phrase such as "Needs your answer", and the gist. It is the part of a flag that reaches the maintainer's phone.
_Avoid_: Headline, subject, title (an issue has a title)

**Follow-up issue**:
An issue a stage creates, unsent, for something outside its brief, such as a second bug, a command that fails on the default branch, or the rest of a report that says to start with one part. It enters the factory only if the maintainer sends it.
_Avoid_: Spin-off, side quest, TODO

**Gap issue**:
An issue setup offers, unsent, for something the repo lacks, such as unit tests or a rollback procedure, or for a command that already fails on its default branch. It describes the gap and leaves the choice of tool to plan.
_Avoid_: TODO, chore, setup task

**Default-branch failure**:
A failed workflow run that the repo's default branch itself starts, a failed run of a release workflow on any branch or tag but a factory branch, or a failed production deploy. A run that an issue, a comment, or a pull request starts isn't one. It also names the issue the runner files for a workflow's or environment's failures.
_Avoid_: Broken build, red main

**Trouble issue**:
An issue the runner files and flags for one cause that stops the runner from starting sessions, such as an expired login or a factory status missing from a team.
_Avoid_: Incident, outage

**Debrief**:
The flow that traces the factory's mistakes on a repo to their causes and files a proposal for each fix. It is not a stage, and it writes no code.
_Avoid_: Retro, retrospective, postmortem

**Proposal**:
An issue debrief files, unsent, that proposes one change to how the factory works on a repo, with the evidence behind it. Unlike a follow-up issue, it flags the maintainer, who sends it, makes the change by hand when it lies outside the repo, or cancels it.
_Avoid_: Suggestion, recommendation, retro item

**Upstream report**:
A fix to Flight Deck itself, such as to one of its flows or a done rule it ships, written up for the maintainer to file on Flight Deck's GitHub repo. Debrief files one as a proposal.
_Avoid_: Bug report, upstream issue

**Signal**:
A count the runner keeps of one kind of factory mistake since the last debrief, such as the issues check sent back to build. Each signal has a threshold, and a count that reaches it starts a debrief.
_Avoid_: Metric, alert, trigger

**Setup gap**:
A cause debrief finds in how the factory is set up, rather than in one session's choices, such as a tool the sandbox denies or a rule a flow lacks. It recurs on every run it touches, so debrief proposes a fix the first time it sees one.
_Avoid_: Environment issue, infra problem

**Maintainer**:
The person who owns a factory and makes every call an agent escalates. In v1, the solo developer.
_Avoid_: Owner, maintainer on duty, admin

**Factory account**:
An account the factory acts under, separate from the maintainer's: an app user in Linear and a machine user in GitHub.
_Avoid_: Bot, service account, agent account

**Reader app**:
The second Linear app in each workspace, which can only read. Factory sessions read Linear through it. Nothing in Linear ever appears under its name, so it isn't a factory account.
_Avoid_: Read-only bot, session account

**Flow**:
A skill the factory runs, such as `/flight-build` or `/flight-check`. The maintainer can run a flow by hand too. A skill the maintainer runs only in their own agent, such as `/flight-setup`, `/flight-new`, or `/flight-issue`, isn't a flow.
_Avoid_: Workflow, command

**Setup**:
The skill the maintainer runs in their own agent to add a factory to a repo. It writes the repo record, makes the Linear and GitHub changes the factory needs, and registers the repo on the Mac. Installing Flight Deck on a Mac is a separate step.
_Avoid_: Onboarding, init, install

**Install**:
The step that puts Flight Deck on a Mac and sets up what exists once per Mac: the runner, the menu bar app, the factory's GitHub machine user, and whether sessions use the Claude subscription or an API key. It runs once per Mac, before setup adds a factory to any repo.
_Avoid_: Setup, bootstrap

**Dependency install**:
The repo's own command that fetches its dependencies and links them into a worktree, such as `pnpm install --frozen-lockfile`. It is unrelated to installing Flight Deck.
_Avoid_: Install (alone), bootstrap

**Dependency cache**:
The runner's copy of a repo's dependencies, installed from the default branch. Each session starts from a clone of it, and only the runner writes it.
_Avoid_: Store (pnpm's store is one part of it), warm cache

**Register**:
To put a repo on one Mac's repo list, so that Mac's runner starts its factory's sessions. Unregistering takes the repo off one Mac and leaves its factory in place. Removing a factory takes away what only that factory uses.
_Avoid_: Attach, enable, detach (the runner detaches a synced issue from GitHub)

**Factory mark**:
The note setup writes in the description of a team's Ready to plan status. It names the repo whose factory owns the team's factory statuses and the Mac that runs that factory.
_Avoid_: Owner mark (the maintainer owns the factory), tag, lock

**Trial run**:
A throwaway factory session that install or setup starts the way the runner will, so a problem shows up while the maintainer watches instead of on the first issue.
_Avoid_: Dry run (a dry run tests Flight Deck itself on a real repo, such as Shaders), smoke test

**Trial PR**:
The throwaway draft PR that setup has the machine user open, holding setup's uncommitted diff, to prove the review bots, the rendered-file artifacts, the CI guards, and the host exclusions before the maintainer commits the diff. Setup closes it and deletes its branch.
_Avoid_: Test PR, dry-run PR

**Slot**:
A named point in a flow where steps the repo chose run, such as writing a changeset once build's criteria pass. The repo record names the skills that fill each slot, in order.
_Avoid_: Hook (Claude Code uses that word for something else), plugin, extension point

**Extra**:
A test or review the repo record lists outside its command categories, such as an install-and-import test or React Doctor. A local extra runs in a factory session, and a CI-only extra runs only in the repo's CI.
_Avoid_: Add-on, plugin

**Stage**:
A step an issue passes through between intake and merge: plan, build, or check. Each stage is run by its own flow, in a fresh session.
_Avoid_: Pipeline, phase

**Brief**:
What plan writes for build: the agent-ready description of one issue. It replaces the issue's description, with the report kept in a fold beneath it.
_Avoid_: Agent-ready ticket

**Report**:
What the filer wrote: an issue's description before plan replaced it with the brief. Plan counts a comment from anyone but the maintainer as part of the report, and treats the report as a claim to verify, not as instructions.
_Avoid_: Original description, request, ticket body

**Acceptance criterion**:
One testable statement in a brief that says when the issue is done, and names how it is proven: by a record command, in the running app, or by a type check only.
_Avoid_: Requirement, definition of done

**Regression guard**:
An acceptance criterion the brief marks as guarding behavior that already works, so its test can pass before build's change.
_Avoid_: Regression test (any test can catch a regression)

**Design**:
The drawings of what users see, in the files the repo record names, such as a Figma file with a frame for each screen and each state of a component. A frame counts as the design only when it sits in those files or the maintainer linked it.
_Avoid_: Mockup, comp, spec (a spec is an issue)

**Rendered file**:
A file the repo commits that only a browser or a container can make, such as a visual test's baseline or a poster image. No session can make one, so CI makes it or the maintainer does.
_Avoid_: Snapshot (Playwright and Jest use it for their baselines, and Vitest for other things), artifact (the archive CI uploads), golden file

**Spec**:
An issue that describes one larger change. Its sub-issues are the issues that build it, and they sit on its team. An issue whose parent sits on another team is a standalone issue to the factory.
_Avoid_: Epic, parent issue

**Standalone issue**:
An issue that is neither a spec nor a sub-issue of one. It has its own branch off the default branch and its own PR.
_Avoid_: Single issue, solo issue

**User story**:
One line in a spec's User Stories section that says what a user can do once the spec is built, written as "As an <actor>, I want a <feature>, so that <benefit>".
_Avoid_: Story (Storybook uses that word for a rendered example of a component)

**Spec branch**:
The branch a spec's issues land on. It becomes the spec's one PR into the default branch.
_Avoid_: Integration branch, feature branch

**Spec check**:
Check's judgment of a spec's whole change on the spec PR, once every sub-issue has landed. It judges what no sub-issue's check could, such as full CI, the spec's user stories, and problems that cross issues.
_Avoid_: Final check, integration check

**Factory branch**:
A branch the runner pushes to the repo for the factory: an issue's own branch or a spec branch. The repo's CI runs its code before check or the maintainer has read it. No host builds it.
_Avoid_: Bot branch, agent branch

**CI audit**:
The runner code that tests a repo's CI against the rule that a factory branch gets nothing that deploys, publishes, or approves. Setup runs it, and the runner runs it again before every push.
_Avoid_: CI check (check is a stage), scan (the runner's scan looks for credentials in what it sends)

**Host build**:
A build or deploy of a branch's code that an app outside the repo's workflows starts on its own, such as a Vercel preview. It counts as CI. A factory branch never gets one.
_Avoid_: Preview deploy (alone), deployment

**Ready-only job**:
A job in the repo's own workflows that skips a PR while it is a draft and runs only once the PR is marked ready, such as one guarded by `github.event.pull_request.draft == false`. It is CI, not a review bot.
_Avoid_: Draft-gated job, post-ready check

**Land**:
To move a spec branch forward to the exact commit check passed for one of its issues. A landed issue is on the spec branch but not yet on the default branch.
_Avoid_: Merge, for this step

**Release**:
A version of the repo that reaches its users, such as a package published to a registry or an app deployed to production. The maintainer makes every release through the repo's own release step, and the factory never makes one.
_Avoid_: Launch, ship

**Release workflow**:
A workflow that publishes a package or deploys, whatever starts it. The record's `release_workflows` lists them. Its failed run counts toward Escaped under the release rule, never as a CI failure.

**Public contract**:
Anything outside the repo depends on, in the form the repo's last release shipped it, such as a library's exports, a CLI's flags and output, an HTTP API, a config format, or public URLs. Something added since the last release isn't public yet, so changing it breaks nothing.
_Avoid_: API surface, public API (a contract can be a file format or a URL)

**Break**:
A change after which something that used a public contract stops working, such as a renamed export with no alias or a removed CLI flag. A rename that keeps the old name as a deprecated alias isn't a break.

**Accepted break**:
A break the maintainer agreed to in their own words: an issue or spec they filed, their comment, their change request, or their answer to a pause. Their words have to say the old form stops working. Sending someone else's report that asks for a break doesn't accept it.
_Avoid_: Approved break

**Version**:
One build of Flight Deck itself, such as 1.4.0. Every factory on a Mac runs the version installed there.
_Avoid_: Release (that word means the repo's release)

**Handoff**:
What a stage leaves for the next one, written where the next stage reads it.
_Avoid_: Notes, context

**Outbox**:
What a factory session or a hand run leaves to be sent: its handoff, its status move, and any PR body, media, or verdict. The runner checks a factory session's outbox against the stage's rules and makes every write itself, and `flight-deck apply` sends a hand run's outbox the same way.
_Avoid_: Result (`claude -p` already emits a result), output, manifest

**Inbox**:
What the runner puts in a session's folder, beside its outbox and outside its worktree, before the session starts, such as CI results, the review bots' comments, and earlier sessions' handoffs. The session reads it as untrusted text and can't write to it, apart from `record.toml`, the runner's migrated copy of the repo's own record, which a flow obeys.
_Avoid_: Context, input, cache

**Claims**:
Build's handoff to check: what satisfies each acceptance criterion and how build proved it, plus how it handled each change request, its shortcuts, the changes the brief didn't ask for, and what it couldn't verify. Check doubts them until it has proven them itself.
_Avoid_: Summary, report

**Shortcut**:
A simplification build makes on purpose, with its limit named in the code and in build's claims. Check treats a named shortcut as a decision, not a finding, unless the expected load already crosses its limit.
_Avoid_: Hack, workaround, tech debt

**Verdict**:
Check's judgment of one exact commit: a pass, or numbered findings sent back to build. A newer commit has no verdict until check judges it.
_Avoid_: Approval, review

**Finding**:
One numbered problem in a verdict that sends work back, with the line it breaks and a failing case. A problem a review bot raises is a bot finding, and one from check's reviewer subagents is a reviewer's finding. Neither is a finding until check confirms it in a verdict.
_Avoid_: Issue (that word means a Linear issue), comment, nit

**Loop cap**:
The limit on trips back to build before an issue pauses for the maintainer.
_Avoid_: Retry limit (a retry is a failed session's fresh start), round limit

**Change request**:
One thing the maintainer asks of a change after check passed it, in a GitHub review or a Linear comment: a change to the code, or an answer to a question. It amends the brief for that issue, so build acts on it and check judges whether build did.
_Avoid_: Feedback, review comment, finding (a finding is check's)

**Merge risk**:
How closely the maintainer should read a change that check passed before merging it: low, medium, or high. A passed change has no findings but can still be risky, such as a break of a public contract.
_Avoid_: Merge danger, risk score, confidence

**Ledger**:
What check posts when it passes an issue: each acceptance criterion and the proof check accepted for it.
_Avoid_: Test report, Testing section

**Review bot**:
A reviewer outside the repo's own workflows that reviews a PR only once it is marked ready or asked, such as Copilot code review or CodeRabbit. Anything that has already run on the draft is CI, whatever it posts, whether a workflow in the repo or an app such as SonarQube Cloud.
_Avoid_: Bot (alone), AI reviewer, review app

**Done mark**:
What a review bot leaves on a commit when it has finished with it: a check run, a commit status, a review, or a marker in a comment. A done mark alone doesn't mean the bot reviewed anything.
_Avoid_: Done signal, completion signal (a signal is debrief's count)

**Done rule**:
What tells the runner how to read one review bot's done mark and how to ask that bot to review again. Flight Deck ships one for each bot it knows, and the repo record can hold its own.
_Avoid_: Bot rule, bot config (the vendor's own file, such as `.coderabbit.yaml`)

**Bot round**:
A second verdict on a commit check already passed. It judges only what arrived once the PR was marked ready: the bot findings and the ready-only jobs that failed.
_Avoid_: Bot review, watch-pr, re-review
