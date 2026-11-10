import type { Mode, Stage } from "../state/index.ts";

/** `session.json`, which every flow reads first (overview, spec 1's "Workspace"). */
export interface SessionJson {
  version: string;
  session: string;
  stage: Stage;
  mode: Mode;
  repo: string;
  /** The issue's identifier. */
  issue: string;
  branch: string;
  base: string;
  commit: string;
  worktree: string;
  /** ISO time. */
  deadline: string;
  port: number | null;
  app_url: string | null;
  inbox: string;
  outbox: string;
  /** The version folder's `skills/`. */
  skills: string;
  /** Each of the stage's slots, by name, to its skills' `SKILL.md` paths. */
  slots: Record<string, string[]>;
  /** The Linear user whose words count (ADR 0026). */
  maintainer: { id: string; name: string } | null;
  /** The Flight Deck app user's Linear ID. */
  app_user: string;
  /** The record's team key. */
  team: string;
  /** The version folder's `plugin/`. */
  plugin: string;
  /** 1 for a stage's first session, 2 for its retry. */
  attempt: number;
  /** The root AGENTS.md when the Harness appended it, else `null`. */
  agents_md: string | null;
}
