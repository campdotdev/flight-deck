# Which review bots developers use most, and how each signals it has reviewed a commit

Research for [FLD-27](https://linear.app/campdotdev/issue/FLD-27/which-review-bots-do-developers-use-most-and-how-does-each-one-signal). Vendor docs were read on 2026-10-16. GitHub API observations were made between 02:15 and 03:00 UTC on 2026-10-17, which is the evening of 2026-10-16 in US time. Each claim cites a source from the list at the end, such as [S1]. The Answer summarizes the sections below it, and those sections carry the citations. A claim marked **Observed** comes from reading real public pull requests through the GitHub API, and it names them. A claim marked **Unconfirmed** has no primary source behind it. A claim marked **Inference** follows from the sources, but no source states it.

## Answer

By pull requests reviewed on public GitHub in September 2026, GitHub Copilot code review, OpenAI's Codex, and CodeRabbit lead by a wide margin. Each of the three reviewed between 333,000 and 623,000 PRs that month. Greptile, Sourcery, Cursor Bugbot, and Claude form a second group, with 54,000 to 109,000 each. SonarQube Cloud posts no reviews, but it comments on more PRs than anything outside the top three, so a repo that uses it has one more thing to wait for.

No single signal tells a script that every bot has finished. Each bot needs its own rule:

- **Copilot code review.** It posts a `COMMENTED` review whose `commit_id` is the commit it reviewed. While it works, it is a pending reviewer in GraphQL `reviewRequests`, though REST's `requested_reviewers` leaves it out. A `copilot-pull-request-reviewer` check run is `in_progress` at the same time. The check run completes a few seconds before the review lands, so wait for the review.
- **Codex.** Its summary comment carries a hidden `codex-review-state:v1` JSON block with the reviewed `commit_sha` and a `status` of `running` or `completed`. With findings it also posts a review. With none it posts no review and reacts 👍 to the PR.
- **CodeRabbit.** It sets a commit status named `CodeRabbit`, first `pending` with "Review in progress" and then `success`. The docs describe a `CodeRabbit` check run, but none of 107 PRs I read had one. `success` also covers "Review rate limited" and "Review skipped", so read the description.
- **Claude Code Review.** A `Claude Code Review` check run from the `claude` app moves from "Code review queued..." to a completed run whose conclusion is `neutral`, or `skipped` when a push changed no files.
- **Sourcery.** A `Sourcery review` check run goes `in_progress`, then `success`, `failure`, or `skipped`.
- **Greptile.** A `Greptile Review` check run goes `in_progress`, then `success`, `failure`, or `neutral` when a newer push cancels it. It posts no review when it has no comments.
- **Cursor Bugbot.** A `Cursor Bugbot` check run goes `in_progress`, then `success` or `neutral`. `neutral` covers findings, a run cancelled by a newer commit, and a run that failed, such as on a usage limit, so read the title and summary.
- **SonarQube Cloud.** A `SonarCloud Code Analysis` check run appears already completed, with `success` or `failure`. No in-progress run exists, so a script needs a timeout.

Three traps catch a script that trusts a review object alone:

- Copilot posts a `COMMENTED` review on the head commit even when it reviewed nothing, such as "Copilot was unable to review this pull request because the user who requested the review has reached their quota limit."
- A bot can finish reviewing an older commit after the head has moved. Compare the review's `commit_id` with the current head SHA, every time.
- Several bots post no review when they find nothing. Codex reacts 👍 instead, and Greptile, Bugbot, Graphite, and Qodo can post nothing at all.

For a solo developer, the free routes are narrow. Copilot needs Copilot Pro at $10 a month. Codex needs ChatGPT Plus at $20 a month. CodeRabbit's Free plan summarizes PRs but does not review them, though public repos get reviews free. Bugbot needs Cursor Premium at $30 a month. Claude Code Review needs a Team or Enterprise plan. Greptile's free Starter plan gives one developer 50 credits a month, which buys 50 base reviews. Sourcery and SonarQube Cloud review public repos free.

## Adoption ranking

Some vendors publish figures, but no two count the same thing. GitHub Marketplace shows install counts only for apps sold there, and Copilot, Codex, Claude, and Gemini have no such listing. To rank on one scale, I counted pull requests with GitHub's search API [S1]. Each query took the form `is:pr reviewed-by:<login> created:2026-09-01..2026-09-30`, and a second query swapped `reviewed-by:` for `commenter:`. Every count came back with `incomplete_results: false`.

| Rank | Bot | GitHub login | PRs it reviewed | PRs it commented on | Marketplace installs | Vendor's own figure |
|---|---|---|---|---|---|---|
| 1 | GitHub Copilot code review | `copilot-pull-request-reviewer[bot]` | 623,418 | 623,400 | No listing. Built into GitHub. | "60 million Copilot code reviews", "more than one in five code reviews on GitHub", and "More than 12,000 organizations" reviewing every PR automatically, on 2026-03-05 [S2] |
| 2 | Codex code review | `chatgpt-codex-connector[bot]` | 455,831 | 903,962 | No listing | None found |
| 3 | CodeRabbit | `coderabbitai[bot]` | 332,738 | 1,107,371 | 346,943 [S3] | "1,049,817 reviews on open-source repositories in September 2026", and "installed on more than 300,000 public repositories" [S4] |
| 4 | Greptile | `greptile-apps[bot]` | 109,032 | 150,114 | 41,960 [S5] | "Over 22,000+ teams use Greptile" [S6] |
| 5 | Sourcery | `sourcery-ai[bot]` | 90,913 | 93,271 | 72,284 [S7] | None found |
| 6 | Cursor Bugbot | `cursor[bot]` | 65,992 | 117,999 | No listing | "A mandatory pre-merge check for thousands of teams" [S8] |
| 7 | Claude | `claude[bot]` | 54,057 | 109,100 | No listing | Not checked |
| 8 | Gemini Code Assist | `gemini-code-assist[bot]` | 19,382 | 22,746 | No listing found | Not checked |
| 9 | Qodo | `qodo-code-review[bot]` | 13,595 | 59,818 | 31,934 for Qodo Merge Pro and 893 for its open source listing [S9] | None found |
| 10 | Graphite | `graphite-app[bot]` | 8,221 | 2,250 | 62,173 for the whole Graphite app, not only its reviewer [S10] | None found |
| 11 | Codacy | `codacy-production[bot]` | 4,705 | 46,013 | 78,972 [S11] | "Trusted by 15,000+ organizations and 200,000+ developers" [S12] |
| None | SonarQube Cloud | `sonarqubecloud[bot]` | 0 | 255,453 | 372,481 for SonarCloud [S13] | "over 7M developers", for all of Sonar [S14] |

Read the counts with these limits in mind:

- Search sees public repos only, plus the few private repos my account can read. A bot sold mostly to companies may have much more private use than this shows. **Inference.**
- A count is pull requests, not repos or users. One busy repo that reviews every push counts once per PR, not once per review.
- `cursor[bot]`, `claude[bot]`, and `chatgpt-codex-connector[bot]` also do agent work, such as opening PRs and answering mentions, so their comment counts cover more than reviews. On 25 PRs that `claude[bot]` reviewed, only 3 carried the `Claude Code Review` check run that the managed review posts. **Observed.** The other 22 reviews came from something else, most likely the Claude Code GitHub Action. **Inference.**
- `commenter:` counts every PR where the bot left a comment. CodeRabbit's walkthrough comment, and SonarQube Cloud's quality-gate comment, land on PRs the bot never reviewed.
- Qodo's older login, `qodo-merge-pro[bot]`, can't be searched. GitHub rejects the query with HTTP 422.
- CodeRabbit's own count of 1,049,817 open source reviews in September 2026 fits the search counts. One PR gets several reviews, so 333,000 PRs reviewed and 1.1 million PRs commented on is the right size. **Inference.**
- Marketplace counts are installs of the app, with no date range. What GitHub counts as an install, and whether uninstalls come off, is **Unconfirmed**.

## How each bot signals it is done

This table covers the bots ranked above. The sections after it give the detail and the evidence.

| Bot | Drafts | New pushes | Done on the head commit | While it works | Cheapest plan that reviews a solo developer's private repo |
|---|---|---|---|---|---|
| Copilot code review | Only with the ruleset option **Review draft pull requests** | Only with **Review new pushes**. No cap documented. | A `COMMENTED` review from `copilot-pull-request-reviewer[bot]` whose `commit_id` is the head SHA | Listed in GraphQL `reviewRequests`. Check run `copilot-pull-request-reviewer` is `in_progress`. | Copilot Pro, $10 a month |
| Codex | Skipped until marked ready, per the bot's own comment | Set by **Review trigger**. GitHub's options are **Unconfirmed**. | Summary comment state `"status":"completed"` with `commit_sha` equal to the head. A review if it found something, a 👍 on the PR if not. | 👀 on the PR. State `"status":"running"`. | ChatGPT Plus, $20 a month |
| CodeRabbit | Skipped unless `reviews.auto_review.drafts: true` | Yes. Pauses after 5 reviewed commits. | Commit status `CodeRabbit` is `success` with "Review completed" | Commit status `CodeRabbit` is `pending` with "Review in progress" | Essentials, $24 a month billed yearly |
| Greptile | Skipped unless `triggerOnDrafts` or **Review draft pull requests** is on | Only if `autoReview` includes `push`. The default is `["open"]`. | Check run `Greptile Review` from app `greptile-apps` is `completed` | Check run `Greptile Review` is `in_progress`. 👀 on the PR, usually. | Starter is free: 50 credits a month for 1 developer |
| Sourcery | Skipped unless **Review draft pull requests** is on | Yes. Capped at 5 automatic re-reviews per PR. | Check run `Sourcery review` is `completed` | Check run `Sourcery review` is `in_progress` | Pro, $12 a month billed yearly |
| Cursor Bugbot | Skipped unless `triggers.drafts` is `true`, or **Enable reviews on draft PRs** on Teams and Enterprise | Yes. **Run only once per PR** turns it off. | Check run `Cursor Bugbot` from app `cursor` is `completed` | Check run `Cursor Bugbot` is `in_progress` | Cursor Premium, $30 a month, plus usage past what it includes |
| Claude Code Review | Skipped. `@claude review` still works on a draft. | Only with **After every push**, or after `@claude review always` | Check run `Claude Code Review` is `completed` with `neutral`, or `skipped` when a push changed no files | Check run title "Code review queued..." or "Code review in progress..." | Claude Team or Enterprise, plus usage credits |
| Gemini Code Assist | Reviewed. `include_drafts` defaults to `true`. | No. Only on open, then on `/gemini review`. | A `COMMENTED` review whose `commit_id` is the head SHA. No check run or status. | 👀 on the PR, which stays after the review | **Unconfirmed** |
| Qodo | Skipped by default | Docs disagree on the default | A comment: "Code review by qodo was updated up to the latest commit" with the full SHA | A temporary "Qodo is busy working" comment | Pro Team, $30 a month for about 18 reviews |
| Graphite | Reviewed. Docs say nothing. | Yes | Check run `Graphite / AI Reviews` is `completed` | None seen. The run appeared already completed. | Hobby is free with "Limited AI Reviews", on repos the developer owns personally |
| Codacy | Analyzed. Docs say nothing. | Yes, for static analysis. The AI Reviewer is manual by default. | Newest check run `Codacy Static Code Analysis` is `completed` | An `in_progress` run that Codacy never closes | Team, $18 a month billed yearly |
| SonarQube Cloud | Analyzed. Docs say nothing. | Yes | Check run `SonarCloud Code Analysis` from app `sonarqubecloud` is `completed` | Nothing. The run appears already completed. | Free covers private repos under 50k lines, for PRs into the main branch |

## GitHub Copilot code review

**Drafts and pushes.** By default Copilot reviews a pull request only when someone requests it, and then only once [S15][S16]. A repository or organization ruleset turns on **Automatically request Copilot code review**, with two optional settings [S17]:

- **Review new pushes** reviews each new push to a PR Copilot is already reviewing. The docs give no cap.
- **Review draft pull requests** reviews drafts too.

A user can turn on the same options for their own PRs, but a ruleset overrides user settings, and Copilot posts one review even when several sources ask for it [S17].

**How it runs.** Since 2026-03-05 the review runs on GitHub Actions [S18]. Since 2026-06-01 it uses Actions minutes in private repos. Public repos stay free [S19]. The run shows up on the head commit. **Observed** on [microsoft/vscode#342224](https://github.com/microsoft/vscode/pull/342224), [microsoft/foundry-local#1213](https://github.com/microsoft/foundry-local/pull/1213), and [shuizhongyueming/canvas2d-webgl#29](https://github.com/shuizhongyueming/canvas2d-webgl/pull/29):

- A workflow run named "Running Copilot Code Review", with event `dynamic` and path `dynamic/agents/copilot-pull-request-reviewer`.
- A check run named `copilot-pull-request-reviewer` from the `github-actions` app, `in_progress` while Copilot works and `success` when it ends.
- A timeline event `copilot_work_started`, about 35 seconds after the `review_requested` event.

**What it posts.** A `COMMENTED` review by default. Copilot approves only where an admin has turned approvals on, and it never requests changes [S16]. The review's `commit_id` is the commit it reviewed. **Observed** on every PR above.

**How a script knows it is done.**

1. Read the PR's head SHA.
2. Wait until Copilot leaves GraphQL `reviewRequests` [S20]. REST's `GET /pulls/{n}/requested_reviewers` [S21] returned an empty list while Copilot was pending on 5 PRs, and GraphQL listed it as a `Bot` on 4 of them. **Observed**, on canvas2d-webgl#29, [styled-components/typescript-styled-plugin#41](https://github.com/styled-components/typescript-styled-plugin/pull/41), [software-mansion/react-native-enriched-html#820](https://github.com/software-mansion/react-native-enriched-html/pull/820), and [egym/react-native-mwa-reference#3](https://github.com/egym/react-native-mwa-reference/pull/3).
3. Find a review from `copilot-pull-request-reviewer[bot]` whose `commit_id` equals the head SHA.

Don't stop at the check run. It completed 2 seconds before the review on vscode#342224 and 8 seconds before it on foundry-local#1213. **Observed.**

**Traps.**

- A review can mean nothing was reviewed. On 3 PRs the review body read "Copilot was unable to review this pull request because the user who requested the review has reached their quota limit." On another it read "Copilot wasn't able to review any files in this pull request." Each was a `COMMENTED` review on the head commit, and no Actions run happened. **Observed** on [ArmourPiercer1/dsh-agent-team#276](https://github.com/ArmourPiercer1/dsh-agent-team/pull/276), [patricioespinozaa/AWS-G12#9](https://github.com/patricioespinozaa/AWS-G12/pull/9), [e1062240241-a11y/Brahmand-main#624](https://github.com/e1062240241-a11y/Brahmand-main/pull/624), and [mrboggyman16/mrboggyman16.github.io#12](https://github.com/mrboggyman16/mrboggyman16.github.io/pull/12).
- A review can land on an old commit. On [microsoft/vscode#342180](https://github.com/microsoft/vscode/pull/342180), commit `1d66b41` arrived while Copilot reviewed `cbd8d58`. The review landed on `cbd8d58`, and no review followed for `1d66b41`. **Observed.**
- Each review, first or repeat, starts with its own `review_requested` event. On 20 vscode PRs the number of Copilot reviews equaled the number of requests. **Observed.**

**Plan.** Copilot Free has no PR review, only **Review selection** in VS Code. Copilot Pro costs $10 a month and includes it [S22]. Automatic review needs Copilot Pro, Pro+, Max, Business, or Enterprise [S17]. A review costs AI credits, estimated at $0.05 to $1 at the "Lite" effort level [S15], and Actions minutes in a private repo [S19].

## Codex code review

**Drafts and pushes.** Reviews start on `@codex review`, or automatically once **Automatic review** is on. A setting named **Review trigger** picks when automatic reviews run [S23]. The GitHub page doesn't list its options. The GitLab page lists **On MR open**, **On every push**, and **Smart Trigger (Experimental)** [S24]. Whether GitHub offers the same three is **Unconfirmed**.

The bot's own summary comment says reviews run when you "Open a pull request for review", "Mark a draft as ready", or comment `@codex review`. **Observed** on [openclaw/fs-safe#1001](https://github.com/openclaw/fs-safe/pull/1001). A draft PR in a repo where Codex reviewed every other PR had no Codex activity. **Observed** on [openclaw/openclaw#175005](https://github.com/openclaw/openclaw/pull/175005). On [openclaw/openclaw#174744](https://github.com/openclaw/openclaw/pull/174744), Codex reviewed 7 commits of 10, and its summary listed the trigger as "New commits". **Observed.** So a repo can set Codex to review pushes.

**What it posts.** Docs say only that Codex reacts 👀 and then posts a review [S23]. Real PRs show more. **Observed** on openclaw/fs-safe#1001, [Vondada/chey-app#319](https://github.com/Vondada/chey-app/pull/319), [Larry-kang/larry-lab#6](https://github.com/Larry-kang/larry-lab/pull/6), and openclaw/openclaw PRs #174974, #174987, and #174491:

- A summary comment, edited in place. It opens with a hidden block such as `<!-- codex-review-state:v1 {"code_review":{"commit_sha":"2921851b...","has_any_findings":true,"has_unresolved_findings":true,"status":"completed"}, ...} -->`. Its table shows the status, the commit, and the trigger.
- With findings, a `COMMENTED` review whose `commit_id` is the head SHA. Its body includes "**Reviewed commit:**".
- With no findings, no review at all and a 👍 reaction on the PR. The summary state reads `"has_any_findings":false`.

**How a script knows it is done.** Parse the hidden state in the summary comment from `chatgpt-codex-connector[bot]`. The review is done when `code_review.status` is `completed` and `code_review.commit_sha` equals the head SHA. While it runs, the state reads `"status":"running"`. The block's format is not documented, so it could change without notice.

**Plan.** ChatGPT Plus, at $20 a month, is the cheapest plan that lists "GitHub code review and automatic PR reviews" [S25]. An API key gets "No cloud-based features (GitHub code review, Slack, etc.)" [S25]. The Free and Go plans don't list it. The pricing page counts reviews that run through GitHub as Code Review usage, apart from local reviews [S25].

## CodeRabbit

**Drafts and pushes.** CodeRabbit skips drafts unless `reviews.auto_review.drafts` is `true`. It re-reviews each push while `reviews.auto_review.auto_incremental_review` is `true`, the default [S26][S27]. It pauses after `reviews.auto_review.auto_pause_after_reviewed_commits` reviewed commits, 5 by default, and `0` turns the pause off [S27]. Any change to the branch counts as a push, including a force-push or a rebase [S28]. `@coderabbitai review` runs an incremental review at any time, and `@coderabbitai full review` starts over [S27].

**The check run the docs describe.** The GitHub setup page says CodeRabbit needs write access to checks "so that it can publish the `CodeRabbit` check run that reports review status" [S29]. The configuration reference says `reviews.review_progress` covers "GitHub progress reports/check runs today". It calls `reviews.commit_status` a "legacy" mirror for when `review_progress` is off "or the newer surface is unavailable" [S26].

**What it does instead.** None of 107 PRs had a check run from the `coderabbitai` app. On 102 of them the head commit had a commit status named `CodeRabbit`, and the other 5 had neither. All 107 were opened or updated in October 2026. **Observed** on [Comfy-Org/ComfyUI_frontend#21211](https://github.com/Comfy-Org/ComfyUI_frontend/pull/21211), [pennlabs/penn-courses#809](https://github.com/pennlabs/penn-courses/pull/809), [bitty-terminal/bitty#2186](https://github.com/bitty-terminal/bitty/pull/2186), [pingdotgg/t3code#20577](https://github.com/pingdotgg/t3code/pull/20577), and 103 more. The status went like this:

- `pending`, "Review in progress", when the review started.
- `success`, "Review completed", about 6 seconds after the review object landed.
- `success`, "Review rate limited", when the developer's allowance ran out. **Observed** on [gamaware/system-design-course#85](https://github.com/gamaware/system-design-course/pull/85) and [martinkrakowski/fleet-v2#108](https://github.com/martinkrakowski/fleet-v2/pull/108). The docs confirm this check "passes by design so it never blocks merging" and call the rate-limit comment "the authoritative signal that no review ran" [S30].
- `success`, "Review skipped: incremental reviews are disabled". **Observed** on [devswha/herdr-web-ui#1248](https://github.com/devswha/herdr-web-ui/pull/1248) and [oneiron-dev/oneiron#1991](https://github.com/oneiron-dev/oneiron/pull/1991).

So the open question from FLD-9, what conclusion the `CodeRabbit` check run reports, has no answer yet. No observed PR had that check run. **Unconfirmed.** Why installs use the legacy status is also **Unconfirmed**. One guess is that older installs never accepted the checks permission. **Inference.**

**How a script knows it is done.** Read the `CodeRabbit` commit status on the head SHA. It is done when the state is `success` and the description is "Review completed". Then confirm a review from `coderabbitai[bot]` whose `commit_id` is the head SHA. A rate-limited or skipped run leaves the last review on an older commit. **Observed** on gamaware/system-design-course#85 and devswha/herdr-web-ui#1248. To cover both surfaces, also accept a `CodeRabbit` check run from the `coderabbitai` app if one appears.

CodeRabbit sells a separate **CodeRabbit Security** check run on its Advanced plan. It reports **Failure**, **Success**, or **Neutral** [S31].

**Plan.** The Free plan gives PR summaries only. Code reviews on Free run through the VS Code extension and CLI, not on PRs [S32]. Open source projects get Team features free, and public repos with fewer than 10 stars need a manual trigger [S32]. Essentials costs $24 per developer a month billed yearly, or $30 month to month [S32]. PR reviews are rate limited per developer per hour: 5 on Essentials, 8 on Team, 10 on Advanced, and 1 to 10 for open source, by star count [S32]. The Marketplace listing calls its free tier "Open Source Advanced" [S3], and the docs say open source gets Team features [S32]. The two disagree.

## Greptile

The observations in this section come from a sub-agent that read the sources and the PRs listed. I read the docs on triggers and pricing myself.

**Drafts and pushes.** Greptile skips drafts unless `triggerOnDrafts` is `true` in `greptile.json`, or **Review draft pull requests** is on in the dashboard [S33][S34]. `@greptileai review this draft` reviews one on request [S35]. `autoReview` sets which events start a review, and its default is `["open"]`, so pushes don't start one [S33]. `open` also covers a PR that is reopened or marked ready. `push` adds pushes with new commits, and `rebase` adds force-pushes [S34]. Commenting `@greptileai` starts a review at any time [S35].

**How a script knows it is done.** The `.greptile/config.json` reference says `statusCheck` defaults to `true` and posts "a review status check on GitHub" [S36]. The docs don't name the check. On real PRs it is a check run named `Greptile Review` from the `greptile-apps` app. **Observed** on [nesquena/hermes-webui#8321](https://github.com/nesquena/hermes-webui/pull/8321), [omacom/omarchy#15095](https://github.com/omacom/omarchy/pull/15095), and [simstudioai/sim#9161](https://github.com/simstudioai/sim/pull/9161):

- `in_progress`, titled "Base review", while it works.
- `success`, "Greptile has reviewed the Pull Request. N files reviewed, M comments added."
- `failure`, with a title that starts "Base review: Confidence 1/5" and says the score is below the repo's required 5/5. **Observed** on [paperclipai/paperclip#16506](https://github.com/paperclipai/paperclip/pull/16506). The docs don't describe this.
- `neutral`, "Review was cancelled", on a commit that a newer push replaced. **Observed** on [DansiDanutz/Claude-Youtube#20](https://github.com/DansiDanutz/Claude-Youtube/pull/20).

On hermes-webui#8321 the review landed 3 seconds before the check completed. **Observed.** A run with no comments posts no review. **Observed** on [nesquena/hermes-webui#8322](https://github.com/nesquena/hermes-webui/pull/8322). The docs say Greptile reacts 👀 while it works and 👍 when done [S37]. Don't rely on the reactions. A re-review added no new 👍, and 👀 never appeared on sim#9161. **Observed.** The summary comment's footer, "Last reviewed commit", moved to the head even after a review with no comments. **Observed** on [nesquena/hermes-webui#8304](https://github.com/nesquena/hermes-webui/pull/8304).

**Plan.** The free Starter plan covers unlimited repos, 1 active developer, and 50 credits a month. A base review costs 1 credit [S38]. The Marketplace listing doesn't limit it to public repos [S5]. Pro costs $30 per seat a month with 50 credits per seat, and $1 for each extra credit [S38].

## Sourcery

The detail in this section comes from a sub-agent that read the sources and the PRs listed.

**Drafts and pushes.** Sourcery skips drafts unless **Review draft pull requests** is on. That setting lives in the dashboard, not in a config file [S39]. While a PR was a draft, Sourcery still posted its "Reviewer's Guide" comment, but no review and no check. The check started about 5 seconds after `ready_for_review`. **Observed** on [GlacierEQ/apex-control-plane#332](https://github.com/GlacierEQ/apex-control-plane/pull/332) and [KingInYellows/yellow-plugins#1241](https://github.com/KingInYellows/yellow-plugins/pull/1241). It re-reviews after every commit, up to 5 automatic re-reviews per PR. `@sourcery-ai review` resets the count [S40][S41]. Plans also cap the size of the diff, per PR and per rolling 7 days [S42].

**How a script knows it is done.** Wait for a check run named `Sourcery review` with `status` `completed` on the head SHA. Its documented states are In progress, Success, Failure for blocking security findings, and Skipped. "The check posts even when Sourcery skips the review" [S40]. `in_progress` turning into `success` was **Observed** on [AstrBotDevs/AstrBot#10215](https://github.com/AstrBotDevs/AstrBot/pull/10215) and [pulp/pulp-service#1388](https://github.com/pulp/pulp-service/pull/1388). `skipped` with "⏭️ Auto re-review limit reached" was **Observed** on [Arbuzov/home_assistant_delonghi_primadonna#249](https://github.com/Arbuzov/home_assistant_delonghi_primadonna/pull/249).

Don't use the review's `commit_id`. On [mindroom-ai/mindroom#2878](https://github.com/mindroom-ai/mindroom/pull/2878) the last review is on `e0babb5`, the head is `b29f13a`, and the check reads `success`. **Observed.** A `skipped` check means Sourcery did not review that commit.

**Plan.** Public repos are free on the Open Source plan. Private repos need Pro at $12 per seat a month billed yearly, or $15 month to month [S42].

## Cursor Bugbot

The observations in this section come from a sub-agent that read the sources and the PRs listed, except where I say I read the PR myself. I read the Bugbot docs and Cursor's pricing myself.

**Drafts and pushes.** Bugbot runs "automatic reviews on every PR update" [S43]. The repo config file sets `triggers.drafts`, which defaults to `false`. Teams and Enterprise users can also turn on **Enable reviews on draft PRs** [S43]. **Run only once per PR** skips later commits, and a personal setting runs Bugbot only when someone comments `cursor review` or `bugbot run` [S43]. Incremental review is on by default, so a re-review covers only changes since the last one [S43]. The docs give no per-PR cap. Pushes that land close together got one run, on the latest head. **Observed** on [BerriAI/litellm#47013](https://github.com/BerriAI/litellm/pull/47013).

**How a script knows it is done.** Bugbot posts a check named `Cursor Bugbot` [S43]. Its conclusions are [S43]:

- `success`, for no issues and no unresolved comments from earlier runs.
- `neutral`, for findings, a run cancelled by a newer commit, or an internal error. Findings default to `neutral`.
- `failure`, only when the repo sets Bugbot to fail on unresolved issues.

"Bugbot does not emit a `skipped` conclusion" [S43]. The check was `in_progress` while Bugbot worked, with a summary such as "Bugbot Analysis Progress (21s elapsed)". **Observed** on BerriAI/litellm#47013 and [kentcdodds/kody#3950](https://github.com/kentcdodds/kody/pull/3950). On litellm#47013 the review landed 4 seconds before the check completed. **Observed.**

`neutral` does not prove a review happened. On [Canzeco/mesita-monorepo#2270](https://github.com/Canzeco/mesita-monorepo/pull/2270), the check was `neutral` with the title "Error", and Bugbot commented "Bugbot couldn't run - usage limit reached". **Observed**, and I read this PR myself. Read the check's title and summary. A finished review's summary says "Bugbot completed review" or "found 1 potential issue". **Observed** on litellm#47013.

The review object is not a safe signal. A clean run sometimes posts no review. **Observed** on [kentcdodds/kody#3802](https://github.com/kentcdodds/kody/pull/3802). The `cursor[bot]` login also posts `APPROVED` reviews and checks from other Cursor agents, such as "Cursor Approval Agent: Pull Request Router and Approver". **Observed**, by me, on [DekuWorks/DayPilot#31](https://github.com/DekuWorks/DayPilot/pull/31) and [kinopeee/interpreter-openai#168](https://github.com/kinopeee/interpreter-openai/pull/168). Filter checks by both the app slug `cursor` and the name `Cursor Bugbot`.

**Plan.** Cursor's Free and Plus plans don't include Bugbot. Premium, at $30 a month, is the cheapest plan that does [S44]. Since a May 2026 pricing change, Bugbot bills reviews against the plan's included usage first, then against prepaid credit [S43]. Cursor says the average review costs $1.00 to $1.50 [S8].

## Claude Code Review

**Drafts and pushes.** Each repository has a setting for when reviews run: **Once after PR creation**, **After every push**, or manual only [S45][S46]. Automatic reviews skip drafts and forks. `@claude review` runs one review, even on a draft, and `@claude review always` subscribes the PR to a review on each push [S46]. Pushes to a draft never start a review [S46].

**How a script knows it is done.** Each review posts a check run named `Claude Code Review` [S45]. Its title tracks progress [S46][S47]:

- "Code review queued..." and then "Code review in progress..." while it runs.
- A title that counts findings when it ends, such as "Code review found no issues".
- A title that starts "Code review skipped", or reads "Code review failed", "Code review timed out", or "Code review declined", when no review happened.

The check run "concludes as neutral, or as skipped when an automatic review didn't run because a push changed no files. It never concludes as a failure" [S46]. Its details text ends in a machine-readable `bughunter-severity` comment with the finding counts. If that line is missing, "treat it as no verdict rather than as zero findings" [S46]. `completed` with `neutral` and titles such as "Code review found 2 important issues" was **Observed** on [tempoxyz/accounts#892](https://github.com/tempoxyz/accounts/pull/892), [tempoxyz/wallet-cli#264](https://github.com/tempoxyz/wallet-cli/pull/264), and [oven-sh/bun#45651](https://github.com/oven-sh/bun/pull/45651).

Don't wait on 👀. Claude may react to a comment "when no review starts, so look for the check run instead" [S46].

**Plan.** Code Review needs a Claude Team or Enterprise plan, and it bills token use to usage credits, apart from the plan's included usage [S45][S48]. On any plan, `/code-review` runs a review inside a local Claude Code session instead [S45].

## Gemini Code Assist

**Drafts and pushes.** Gemini reviews when a PR opens [S49]. `code_review.pull_request_opened.include_drafts` defaults to `true`, so it acts on drafts too [S50]. The docs don't say whether a push starts another review. On 12 `vllm-project/vllm-ascend` PRs with 1 to 101 commits, each had exactly one Gemini review. **Observed.** A new review needs `/gemini review` [S49].

**How a script knows it is done.** Gemini reacted 👀 to the PR within seconds and later posted a `COMMENTED` review whose `commit_id` was the head SHA. The 👀 stayed after the review. **Observed** on [vllm-project/vllm-ascend#19055](https://github.com/vllm-project/vllm-ascend/pull/19055) and [AI-Hypercomputer/maxtext#5812](https://github.com/AI-Hypercomputer/maxtext/pull/5812). The `gemini-code-assist` app has no permission to write checks or commit statuses, so a review is the only possible done mark [S51]. **Inference** from the app's permissions.

**Plan.** Google's docs say "there are no charges for using Gemini Code Assist on GitHub during Preview" for the enterprise version [S49]. Whether the consumer version is free, and its daily limits, are **Unconfirmed**.

## Qodo

The detail in this section comes from a sub-agent that read the sources and the PRs listed.

Qodo Merge is now called Qodo, and its login is `qodo-code-review[bot]` [S52]. It skips drafts by default. The **Code review trigger** setting offers "Published PRs", "Draft and published PRs", and "Manual only" [S53][S54]. Whether it reviews each push by default is unclear. The TOML reference says `handle_push_trigger` defaults to `false`, and the portal page says **Review every push** is on by default [S55][S54].

Hosted Qodo posts no check run or commit status. Its app can only read checks [S51]. It posts a review only when it has new inline comments. The reliable done mark is a comment reading "Code review by qodo was updated up to the latest commit" followed by the full commit URL [S56]. **Observed** on [sayed710/rocky#114](https://github.com/sayed710/rocky/pull/114) and [BigSimmo/PsychSift#3590](https://github.com/BigSimmo/PsychSift/pull/3590). While it works, it posts a "Qodo is busy working" comment and deletes it when done. **Observed** on BigSimmo/PsychSift#3590.

Qodo has no permanent free tier. Pro Team starts at $30 a month for 2,500 credits, about 18 reviews [S57]. Public repos with 200 or more stars can join an open source program [S58].

## Graphite

The detail in this section comes from a sub-agent that read the sources and the PRs listed.

Graphite's AI reviewer was called Diamond and is now Graphite Agent [S59]. Its docs say "AI reviews will only run on new and updated pull requests" [S60], and a new run followed each push. **Observed** on [friggframework/frigg#688](https://github.com/friggframework/frigg/pull/688). The docs don't mention drafts, and it reviewed PRs that were still drafts. **Observed** on friggframework/frigg#688. It doesn't review a PR over 200,000 characters [S61].

It posts a check run named `Graphite / AI Reviews`. The check read `success` with "AI review ran and left N comment(s)" whatever it found, on 44 of 44 runs sampled. It read `skipped` when the PR was too large. **Observed** on [EffortlessMetrics/ripr-swarm#8325](https://github.com/EffortlessMetrics/ripr-swarm/pull/8325). No in-progress state was ever seen, even when polling every 3 to 5 seconds. Whether the check exists before it completes is **Unconfirmed**. Don't use the review. It appears only when there are comments, and on frigg#688 its `commit_id` was an older commit than the one its own comment was on. **Observed.**

The free Hobby plan has "Limited AI Reviews" and works only on repos the developer owns personally. Team, at $40 per user a month billed yearly, has unlimited AI reviews [S62][S63].

## Codacy

The detail in this section comes from a sub-agent that read the sources and the PRs listed.

Codacy runs static analysis on every push and posts a check run named `Codacy Static Code Analysis` [S64]. The docs don't say how it treats drafts, and drafts were analyzed in practice. **Observed** on [ls1intum/Helios#1186](https://github.com/ls1intum/Helios/pull/1186). Its AI Reviewer is separate and runs manually by default [S65].

Codacy posts an `in_progress` check run, then a second completed run, and never closes the first. On Helios#1186 the first run has been `in_progress` since 2026-10-15. **Observed.** So a script must take the newest run by id. Completed runs read `success` ("Your pull request is up to standards!") or `action_required` ("5 new issues (0 max.)..."). **Observed** on [SamErde/DLLPickle#303](https://github.com/SamErde/DLLPickle/pull/303) and KingInYellows/yellow-plugins#1241.

Public repos are free. Private repos need Team, from $18 per developer a month billed yearly [S66]. The AI Reviewer is on Team and Business plans [S67].

## SonarQube Cloud

The detail in this section comes from a sub-agent that read the sources and the PRs listed.

SonarQube Cloud is a static analyzer, not an AI reviewer, but it gates PRs the same way. Automatic analysis runs "on pull request creation and on every push to the pull request branch" [S68]. The docs don't mention drafts, and drafts were analyzed. **Observed** on [victron-venus/inverter-dashboard#299](https://github.com/victron-venus/inverter-dashboard/pull/299).

It posts a check run named `SonarCloud Code Analysis` [S69], with `success` for "Quality Gate passed" and `failure` for "Quality Gate failed". **Observed** on [flext-sh/flext-infra#2056](https://github.com/flext-sh/flext-infra/pull/2056) and [cdk/cdk#1345](https://github.com/cdk/cdk/pull/1345). It posts no review. It posts no in-progress run either. The check suite sits `queued` with no runs, and then a completed run appears. **Observed** on [KarmaCummunity/KC#955](https://github.com/KarmaCummunity/KC/pull/955). A script has to know the repo uses Sonar, and it needs a timeout. Filter by the app slug `sonarqubecloud`, because other apps post checks named "SonarCloud" too. **Observed** on [unknowIfGuestInDream/javafxTool#2833](https://github.com/unknowIfGuestInDream/javafxTool/pull/2833).

The Free plan covers public projects and private projects up to 50k lines of code. On Free, a private repo's PR is analyzed only if it targets the main branch [S70].

## Unconfirmed

- What conclusion CodeRabbit's `CodeRabbit` check run reports. The docs describe the check run, but 107 public PRs showed only the `CodeRabbit` commit status.
- Why CodeRabbit installs use the legacy commit status, and whether a new install gets the check run instead.
- Which **Review trigger** options Codex offers on GitHub. Only the GitLab page lists them.
- The format of Codex's `codex-review-state:v1` block. It is not documented and may change.
- Whether Codex's Free or Go plans can review PRs on GitHub. The pricing page lists the feature from Plus up.
- Whether the consumer version of Gemini Code Assist is free, and its daily limits.
- Whether Copilot's **Review new pushes** has any cap.
- Qodo's default for reviewing each push. Two of its pages disagree.
- How Codacy and SonarQube Cloud treat drafts. Neither documents it, and both analyzed drafts in practice.
- How much of each count comes from private repos, which search can't see.
- What GitHub Marketplace counts as an install.
- The name of Greptile's check run. The docs promise a status check but don't name it. `Greptile Review` is what real PRs show.
- What Bugbot charges per review. Cursor gives only an average of $1.00 to $1.50.
- Whether Graphite's check run is ever `in_progress`, and how many reviews its "Limited" free plan allows.

## What this means for Flight Deck

These facts constrain how check waits for bots. They don't settle the design.

- Check can't use one rule for all bots. It needs a small table keyed by bot login or app slug, with the done mark for each.
- Check has to learn which bots a repo uses before it waits. Copilot leaves no trace on a PR nobody asked it to review, and SonarQube Cloud posts nothing until it has finished. The time limit in [FLD-9](https://linear.app/campdotdev/issue/FLD-9) covers both cases.
- Every rule has to compare against the head SHA. Copilot, Sourcery, Codacy, Graphite, and CodeRabbit have all left their latest review on a commit older than the head. Sourcery, Graphite, and CodeRabbit reported done on the head anyway.
- "Done" and "reviewed" differ. CodeRabbit's `success` can mean rate limited or skipped. Bugbot's `neutral` can mean it hit a usage limit. Copilot's review can say it reviewed nothing. Claude's check run can say declined. Check should record which bots reviewed the head and which only finished, and say so in its verdict.
- FLD-9 has build open the PR as a draft, and check marks it ready only on a pass. By default CodeRabbit, Greptile, Sourcery, Bugbot, Qodo, Codex, Claude, and Copilot's automatic review all skip drafts, so check would wait for reviews that never start. Most bots have a setting or a command that covers drafts: `reviews.auto_review.drafts: true` for CodeRabbit, `triggerOnDrafts` for Greptile, `triggers.drafts` for Bugbot, **Review draft pull requests** for Sourcery and Copilot, "Draft and published PRs" for Qodo, and `@claude review` for Claude. Codex documents no draft setting, and whether `@codex review` runs on a draft is **Unconfirmed**. Gemini and Graphite review drafts.
- Each trip back to build adds pushes. A bot that reviews every push can run out of re-reviews before the final head. CodeRabbit pauses after 5 reviewed commits, and Sourcery stops after 5 automatic re-reviews. **Inference.** A comment command such as `@coderabbitai review` or `@sourcery-ai review` restarts them.
- For a solo developer with a private repo, each of the top three costs money. Greptile's Starter plan reviews private repos free, up to about 50 reviews a month. Graphite's Hobby plan is free with an unstated limit, on personal repos only. On public repos, CodeRabbit, Sourcery, Codacy, and SonarQube Cloud review free, and CodeRabbit wants 10 stars before it reviews on its own.
- Polling fits. Every signal here is readable with `gh api`: reviews, check runs, commit statuses, issue comments, reactions, and GraphQL `reviewRequests`.

## Sources

- [S1] GitHub REST, [Search issues and pull requests](https://docs.github.com/en/rest/search/search#search-issues-and-pull-requests), called with `gh api -X GET search/issues` on 2026-10-17 UTC.
- [S2] The GitHub Blog, [60 million Copilot code reviews and counting](https://github.blog/ai-and-ml/github-copilot/60-million-copilot-code-reviews-and-counting/), 2026-03-05.
- [S3] GitHub Marketplace, [CodeRabbit](https://github.com/marketplace/coderabbitai).
- [S4] CodeRabbit, [Open-source reviews on CodeRabbit topped 1 million in a single month](https://www.coderabbit.ai/blog/one-million-open-source-reviews-september-2026), 2026-10-08.
- [S5] GitHub Marketplace, [Greptile](https://github.com/marketplace/greptile-apps).
- [S6] Greptile, [home page](https://www.greptile.com/).
- [S7] GitHub Marketplace, [Sourcery](https://github.com/marketplace/sourcery-ai).
- [S8] Cursor, [Bugbot product page](https://cursor.com/bugbot).
- [S9] GitHub Marketplace, [Qodo Merge Pro](https://github.com/marketplace/qodo-merge-pro) and [Qodo Merge Pro for open source](https://github.com/marketplace/qodo-merge-pro-for-open-source).
- [S10] GitHub Marketplace, [Graphite](https://github.com/marketplace/graphite-dev).
- [S11] GitHub Marketplace, [Codacy](https://github.com/marketplace/codacy).
- [S12] Codacy, [home page](https://www.codacy.com/).
- [S13] GitHub Marketplace, [SonarQube Cloud](https://github.com/marketplace/sonarcloud).
- [S14] Sonar, [SonarQube Cloud plans and pricing](https://www.sonarsource.com/plans-and-pricing/sonarcloud/).
- [S15] GitHub Docs, [About GitHub Copilot code review](https://docs.github.com/en/copilot/concepts/agents/code-review): defaults, AI credit estimates, GitHub Actions runners.
- [S16] GitHub Docs, [Using GitHub Copilot code review](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/use-code-review): requesting and re-requesting, review types.
- [S17] GitHub Docs, [Configuring automatic code review by GitHub Copilot](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/request-a-code-review/configure-automatic-review): the ruleset and user settings, and the plans for automatic review.
- [S18] GitHub Changelog, [Copilot code review now runs on an agentic architecture](https://github.blog/changelog/2026-03-05-copilot-code-review-now-runs-on-an-agentic-architecture/), 2026-03-05.
- [S19] GitHub Changelog, [GitHub Copilot code review will start consuming GitHub Actions minutes on June 1, 2026](https://github.blog/changelog/2026-04-27-github-copilot-code-review-will-start-consuming-github-actions-minutes-on-june-1-2026/), 2026-04-27.
- [S20] GitHub GraphQL, [`PullRequest.reviewRequests`](https://docs.github.com/en/graphql/reference/objects#pullrequest), queried with `gh api graphql`.
- [S21] GitHub REST, [Get all requested reviewers for a pull request](https://docs.github.com/en/rest/pulls/review-requests#get-all-requested-reviewers-for-a-pull-request).
- [S22] GitHub Docs, [Plans for GitHub Copilot](https://docs.github.com/en/copilot/get-started/plans): prices and what Free includes.
- [S23] OpenAI, [Review GitHub pull requests with Codex](https://learn.chatgpt.com/docs/third-party/github).
- [S24] OpenAI, [Review GitLab merge requests with Codex](https://learn.chatgpt.com/docs/third-party/gitlab).
- [S25] OpenAI, [Codex pricing](https://developers.openai.com/codex/pricing).
- [S26] CodeRabbit Docs, [Configuration reference](https://docs.coderabbit.ai/reference/configuration), last updated 2026-10-15.
- [S27] CodeRabbit Docs, [Automatic review controls](https://docs.coderabbit.ai/configuration/auto-review).
- [S28] CodeRabbit Docs, [FAQs](https://docs.coderabbit.ai/faq).
- [S29] CodeRabbit Docs, [GitHub](https://docs.coderabbit.ai/platforms/github-com): app permissions and the `CodeRabbit` check run.
- [S30] CodeRabbit Docs, [Review rate limits](https://docs.coderabbit.ai/management/rate-limits).
- [S31] CodeRabbit Docs, [CodeRabbit Security check](https://docs.coderabbit.ai/security/pull-request-check).
- [S32] CodeRabbit Docs, [Plans and pricing](https://docs.coderabbit.ai/management/plans).
- [S33] Greptile Docs, [greptile.json reference](https://www.greptile.com/docs/code-review/greptile-json-reference).
- [S34] Greptile Docs, [Controlling nitpickiness](https://www.greptile.com/docs/code-review/controlling-nitpickiness): trigger configuration.
- [S35] Greptile Docs, [Developer essentials](https://www.greptile.com/docs/code-review/developer-essentials).
- [S36] Greptile Docs, [.greptile/ file reference](https://www.greptile.com/docs/code-review/greptile-config-reference).
- [S37] Greptile Docs, [Anatomy of a review](https://www.greptile.com/docs/code-review/first-pr-review).
- [S38] Greptile, [Pricing](https://www.greptile.com/pricing).
- [S39] Sourcery Docs, [Configure reviews](https://docs.sourcery.ai/reviews/configure/).
- [S40] Sourcery Docs, [Anatomy of a review](https://docs.sourcery.ai/reviews/anatomy-of-a-review/).
- [S41] Sourcery Docs, [Commands](https://docs.sourcery.ai/reviews/commands/).
- [S42] Sourcery Docs, [Plans](https://docs.sourcery.ai/admin/plans/), and Sourcery, [Pricing](https://sourcery.ai/pricing).
- [S43] Cursor Docs, [Bugbot](https://cursor.com/docs/bugbot).
- [S44] Cursor, [Pricing](https://cursor.com/pricing), and Cursor Docs, [Models and pricing](https://cursor.com/docs/models-and-pricing).
- [S45] Claude Code Docs, [Code Review](https://code.claude.com/docs/en/code-review).
- [S46] Claude Code Docs, [Read and request reviews on a pull request](https://code.claude.com/docs/en/code-review-pull-requests).
- [S47] Claude Code Docs, [Troubleshoot Code Review](https://code.claude.com/docs/en/code-review-troubleshooting).
- [S48] Claude Code Docs, [Code Review costs and usage](https://code.claude.com/docs/en/code-review-costs).
- [S49] Google Cloud Docs, [Use Gemini Code Assist on GitHub](https://docs.cloud.google.com/gemini/docs/code-review/use-code-assist-github), last updated 2026-10-13.
- [S50] Google Cloud Docs, [Customize Gemini Code Assist behavior in GitHub](https://docs.cloud.google.com/gemini/docs/code-review/customize-repo-review), last updated 2026-10-13.
- [S51] GitHub REST, [Get an app](https://docs.github.com/en/rest/apps/apps#get-an-app), called with `gh api apps/<slug>` for each bot's app to read its permissions.
- [S52] Qodo Docs, [Changelog](https://docs.qodo.ai/changelog) and [llms.txt](https://docs.qodo.ai/llms.txt), for the product's former names.
- [S53] Qodo Docs, [Review comments not appearing](https://docs.qodo.ai/code-review/troubleshooting/review-comments-not-appearing).
- [S54] Qodo Docs, [Workflow](https://docs.qodo.ai/configuration/workflow).
- [S55] Qodo Docs, [Configuration and command reference](https://docs.qodo.ai/configuration/configuration-and-command-reference).
- [S56] Qodo Docs, [Persistent review comments](https://docs.qodo.ai/code-review/persistent-review-comments).
- [S57] Qodo, [Pricing](https://www.qodo.ai/pricing/).
- [S58] Qodo Docs, [Open source program](https://docs.qodo.ai/open-source-program).
- [S59] Graphite, [Meet Graphite Agent](https://graphite.com/blog/introducing-graphite-agent-and-pricing).
- [S60] Graphite Docs, [AI review customization](https://graphite.com/docs/ai-review-customization).
- [S61] Graphite Docs, [AI review comments](https://graphite.com/docs/ai-review-comments).
- [S62] Graphite, [Pricing](https://graphite.com/pricing), and Graphite Docs, [Billing plans](https://graphite.com/docs/billing-plans).
- [S63] Graphite Docs, [AI reviews setup](https://graphite.com/docs/ai-reviews-setup).
- [S64] Codacy Docs, [GitHub integration](https://docs.codacy.com/repositories-configure/integrations/github-integration/), updated 2026-10-16.
- [S65] Codacy Docs, [GitHub integration settings changes](https://docs.codacy.com/release-notes/cloud/cloud-2026-03-github-integration-settings-changes/), 2026-03-03.
- [S66] Codacy, [Pricing](https://www.codacy.com/pricing).
- [S67] Codacy Docs, [Codacy AI](https://docs.codacy.com/codacy-ai/codacy-ai/), updated 2026-10-16.
- [S68] SonarQube Cloud Docs, [Pull request analysis](https://docs.sonarsource.com/sonarqube-cloud/analyzing-source-code/pull-request-analysis).
- [S69] SonarQube Cloud Docs, [GitHub integration](https://docs.sonarsource.com/sonarqube-cloud/managing-your-projects/administering-your-projects/devops-platform-integration/github).
- [S70] SonarQube Cloud Docs, [Subscription plans](https://docs.sonarsource.com/sonarqube-cloud/administering-sonarcloud/managing-subscription/subscription-plans).

Every **Observed** claim comes from `gh api` reads with `gh` 2.96.0 between 02:15 and 03:00 UTC on 2026-10-17. The reads covered each PR's head SHA, reviews, issue comments, reactions, timeline events, the head commit's check runs and commit statuses, its Actions workflow runs, and GraphQL `reviewRequests`. Two sub-agents gathered the Greptile, Bugbot, Graphite, Qodo, Sourcery, Codacy, and SonarQube Cloud evidence the same way and reported each PR they used.
