// Each trouble cause's text, fixed in the runner's code with no model call (spec 1, "Trouble issues", ADR 0019):
// the trouble issue's title and body, the cleared comment, and the macOS notification. The title is plain text
// shaped "<what broke>: <the fix>", because the phone shows "assigned to you" and the title. A long workspace or
// status name may push it past 79 characters, and it stays whole.
import { codeBlock, runnerFooter } from "../../outbox/runner-comments/frame.ts";
import type { TroubleCause, TroubleEntry, TroubleFacts } from "../../state/index.ts";
import { duration } from "../../outbox/runner-comments/stale-take.ts";
import { fold } from "../../tracker/index.ts";

export interface TroubleText {
  /** The trouble issue's title. A cause that files no issue has one too, for `status.json`. */
  title: string;
  /** The trouble issue's description, or `null` for a cause the runner can't file and only notifies. */
  body: string | null;
  /** The macOS notification's text, under the title "Flight Deck". */
  notification: string;
}

/** The cleared comment: "🟢 Fixed: " and what works again, then what restarts. */
export interface ClearedText {
  statusLine: string;
  sentence: string;
}

/** How the maintainer signs Claude Code in again. Flight Deck never touches the login itself (ADR 0005). */
const LOGIN_STEPS = ["In a terminal on the Mac, run `claude`.", "Type `/login`, and sign in with the account Flight Deck's sessions use."];

const CLOSING = "Flight Deck comments here once it works again. Close the issue then.";

/** What a cause's texts read: its facts, and when it opened. */
type Opened = Pick<TroubleEntry, "since" | "facts">;

/** How the texts treat what the runner saw. */
export interface TextOptions {
  /** The facts' error matched the secret scan, or the scan couldn't run, so the body leaves it out. */
  errorLeftOut?: boolean;
}

/** One cause's texts. */
interface CauseTexts {
  /** The trouble issue's title and body, and the notification, when the cause opens. */
  opening(entry: Opened, version: string, options: TextOptions): TroubleText;
  /** The comment once the cause clears, or `null` for a cause whose issue gets none. `now` holds what the clearing poll saw. */
  cleared: ((entry: Opened, now: TroubleFacts) => ClearedText) | null;
}

const AGAIN = "Sessions start again at the next poll.";

/** Each cause's texts, by cause. */
const TEXTS: Record<TroubleCause, CauseTexts> = {
  missing_status: {
    opening: (entry, version) => {
      const { facts } = entry;
      const missing = facts.missing ?? [];
      const first = missing[0]?.name ?? "";
      const title = `Linear status ${first} is missing: rename it back or rerun setup`;
      // The trouble issue goes in the `intake` role's status, so a missing `intake` status can only notify.
      if (missing[0]?.role === "intake") return { title, body: null, notification: title };
      const body = issueBody({
        what: `Flight Deck stopped starting sessions for ${facts.repo} at ${when(entry.since)}. The repo's record names Linear statuses that team ${facts.team} doesn't have:\n\n${missing.map((each) => `- ${each.name}, for the \`${each.role}\` role`).join("\n")}`,
        steps: [
          `In Linear, open team ${facts.team}'s settings, then its issue statuses.`,
          "Give each status above its old name again, or add it back.",
          "If you renamed a status on purpose, rerun setup, so the record names the new name.",
        ],
        details: [`- Repo: \`${facts.repo}\``, `- Team: \`${facts.team}\``, `- Missing roles: ${missing.map((each) => `\`${each.role}\``).join(", ")}`],
        cause: "missing_status",
        version,
      });
      return { title, body, notification: title };
    },
    cleared: (entry) => ({ statusLine: `🟢 Fixed: Linear status ${entry.facts.missing?.[0]?.name} is back.`, sentence: "This repo's sessions start again at the next poll." }),
  },
  claude_code_version: {
    opening: (entry, version) => {
      const { facts } = entry;
      const title = `Claude Code ${facts.version} is too old for Flight Deck: run claude update`;
      const body = issueBody({
        what: `Flight Deck stopped starting sessions on this Mac at ${when(entry.since)}. It needs Claude Code ${facts.minVersion} or later, and the Mac has ${facts.version}.`,
        steps: ["In a terminal on the Mac, run `claude update`.", `Run \`claude --version\`, and check that it prints ${facts.minVersion} or later.`],
        details: [`- Installed: \`${facts.version}\``, `- Needed: \`${facts.minVersion}\` or later`],
        cause: "claude_code_version",
        version,
      });
      return { title, body, notification: title };
    },
    cleared: (entry, now) => ({ statusLine: `🟢 Fixed: Claude Code ${now.version ?? entry.facts.version} works with Flight Deck.`, sentence: AGAIN }),
  },
  github_token: {
    opening: (entry, version, options) => {
      const { facts } = entry;
      const title = "Flight Deck can't sign in to GitHub: run flight-deck login github";
      const body = issueBody({
        what: `Flight Deck stopped starting sessions on this Mac at ${when(entry.since)}. GitHub refused the machine user's login when Flight Deck fetched ${facts.repo}.`,
        steps: ["In a terminal on the Mac, run `flight-deck login github`.", "Sign in as the machine user, not as yourself."],
        details: [`- Repo: \`${facts.repo}\``, ...errorPart(facts.error, "The fetch failed with:", options)],
        cause: "github_token",
        version,
      });
      return { title, body, notification: title };
    },
    cleared: () => ({ statusLine: "🟢 Fixed: Flight Deck can sign in to GitHub again.", sentence: AGAIN }),
  },
  linear_login: {
    opening: ({ facts }) => notifyOnly(`No Linear login for ${facts.workspace}: run flight-deck login linear ${facts.workspace}`),
    cleared: null,
  },
  team_unreadable: {
    opening: ({ facts }) => notifyOnly(`Flight Deck can't read Linear team ${facts.team}: check the team and both apps' access`),
    cleared: null,
  },
  shared_team: {
    opening: ({ facts }) => notifyOnly(`Two repos use Linear team ${facts.team}: run flight-deck register for one team per repo`),
    cleared: null,
  },
  credentials: {
    opening: () => notifyOnly("Flight Deck stopped: others can read credentials.env. Run chmod 600 on it."),
    cleared: null,
  },
  claude_login: {
    opening: (entry, version, options) => {
      const { facts } = entry;
      const title = "Claude Code's login expired: run claude, then /login";
      const body = issueBody({
        what: `Flight Deck stopped starting sessions on this Mac at ${when(entry.since)}. Claude Code's login expired, so a session ended without finishing. Flight Deck starts a trial run every 15 minutes, and sessions start again once one passes.`,
        steps: LOGIN_STEPS,
        details: [`- Session: \`${facts.session}\``, ...errorPart(facts.error, "The session ended with:", options)],
        cause: "claude_login",
        version,
      });
      return { title, body, notification: title };
    },
    cleared: () => ({ statusLine: "🟢 Fixed: Claude Code is signed in again.", sentence: AGAIN }),
  },
  claude_login_soon: {
    opening: (entry, version) => {
      const { facts } = entry;
      const title = "Claude Code's login expires soon: run claude, then /login";
      const body = issueBody({
        what: `Claude Code warned at ${when(entry.since)} that its login expires soon. Nothing has stopped yet. Once the login expires, Flight Deck stops starting sessions on this Mac.`,
        steps: LOGIN_STEPS,
        details: [`- Session: \`${facts.session}\``, ...(facts.warning === undefined ? [] : ["", `Claude Code's warning:\n\n${codeBlock(facts.warning)}`])],
        cause: "claude_login_soon",
        version,
      });
      return { title, body, notification: title };
    },
    cleared: () => ({ statusLine: "🟢 Fixed: Claude Code's login was renewed.", sentence: "Nothing had stopped." }),
  },
  // Its issue is filed once a mint works again, so it gets no cleared comment.
  linear_token: { opening: linearToken, cleared: null },
};

/** The cause's opening texts. The caller runs the facts' error through the secret scan first (ADR 0007). */
export function troubleText(entry: Pick<TroubleEntry, "cause" | "since" | "facts">, version: string, options: TextOptions = {}): TroubleText {
  return TEXTS[entry.cause].opening(entry, version, options);
}

/** The comment on the trouble issue once the cause clears. `now` holds what the runner sees at the clearing poll. */
export function clearedText(entry: Pick<TroubleEntry, "cause" | "since" | "facts">, now: TroubleFacts): ClearedText | null {
  return TEXTS[entry.cause].cleared?.(entry, now) ?? null;
}

/** The error the runner saw, in a code block under `intro`, or the line that says the scan left it out. */
function errorPart(error: string | undefined, intro: string, options: TextOptions): string[] {
  if (error === undefined) return [];
  return ["", options.errorLeftOut === true ? "Error message left out: it matched a secret rule." : `${intro}\n\n${codeBlock(error)}`];
}

/** A cause the runner can't file an issue for: its title is the notification. */
function notifyOnly(title: string): TroubleText {
  return { title, body: null, notification: title };
}

/**
 * `linear_token` notifies when a mint fails, and files only once a mint works again, so its title and body are
 * in the past tense, and its issue gets no cleared comment (ADR 0005). Before a mint works, its title is only for
 * the log. The body names the four causes that look alike from the Mac, and ends with its own last sentence.
 */
function linearToken(entry: Opened, version: string, options: TextOptions): TroubleText {
  const { workspace, app, ended } = entry.facts;
  const notification = `Flight Deck can't get a Linear token for ${workspace}. It keeps trying.`;
  if (ended === undefined) return { title: `Flight Deck can't get a Linear token for ${workspace}`, body: null, notification };
  const title = `Flight Deck couldn't get a Linear token for ${duration(Date.parse(ended) - Date.parse(entry.since))}`;
  const appName = app === "reader" ? "Flight Deck Reader" : "Flight Deck";
  const held =
    app === "reader"
      ? "Sessions in the workspace's repos waited to start, because each session reads Linear through that app's token."
      : "Flight Deck skipped every Linear step for the workspace's repos while it waited.";
  const login = `\`flight-deck login linear ${workspace}\``;
  // The end time leaves out the date when the failure ended on the day it began.
  const to = when(ended).slice(0, 10) === when(entry.since).slice(0, 10) ? when(ended).slice(11) : when(ended);
  const body = [
    `Flight Deck held new work in ${workspace} from ${when(entry.since)} to ${to}, because Linear refused to mint a token from the ${appName} app. ${held} A mint works again, so the factory runs as usual.`,
    "From the Mac, four causes look the same. If it happens again, check each one:",
    [
      "1. A full token pool. Linear holds at most 1,000 active tokens per app. A runner that crashes leaves its sessions' Reader tokens live until they expire after 30 days, so check `runner.log` for restarts.",
      `2. A rotated client secret. If someone rotated the app's secret in Linear, run ${login} and enter the new one.`,
      `3. A deleted app. If the app is gone from the workspace's settings in Linear, create it again, then run ${login}.`,
      "4. A Linear outage. Check Linear's status page. Flight Deck keeps trying on its own.",
    ].join("\n"),
    "Close the issue once you've read it.",
    fold(
      "Details",
      [
        "- Cause: `linear_token`",
        `- Workspace: \`${workspace}\``,
        `- App: ${appName}`,
        ...errorPart(entry.facts.error, "The last mint failed with:", options),
        "",
        runnerFooter(version),
      ].join("\n"),
    ),
  ].join("\n\n");
  return { title, body, notification };
}

/** The body's shape: what stopped, the numbered fix, the closing sentence, then the Details fold with the footer. */
function issueBody(input: { what: string; steps: string[]; details: string[]; cause: string; version: string }): string {
  const steps = input.steps.map((step, i) => `${i + 1}. ${step}`).join("\n");
  const details = [`- Cause: \`${input.cause}\``, ...input.details].join("\n");
  return [input.what, steps, CLOSING, fold("Details", `${details}\n\n${runnerFooter(input.version)}`)].join("\n\n");
}

/** An ISO time as `2026-11-10 09:01 UTC`. */
function when(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
