// The typed repo record, schema 1. Field names are the record's own, as spec 1's field table gives them.

export const ROLES = [
  "intake",
  "backlog",
  "ready_to_plan",
  "planning",
  "ready_to_build",
  "building",
  "ready_to_check",
  "checking",
  "landed",
  "paused",
  "in_review",
  "done",
  "canceled",
  "duplicate",
] as const;

export type Role = (typeof ROLES)[number];

export type CommandCategory = "types" | "lint" | "format" | "unit" | "integration" | "e2e";

export type Where = "local" | "ci";

/** A string of `<n>h`, `<n>m`, and `<n>s` parts, such as `"1h30m"`. */
export type Duration = string;

/** A skill name, or a path `.claude/skills/<name>`. */
export type SlotEntry = string;

export interface RepoRecord {
  schema: 1;
  tracker: {
    kind: "linear";
    workspace: string;
    team: string;
    statuses: Record<Role, string>;
  };
  dependencies: {
    command: string;
    folders: string[];
  };
  commands: { name: string; category: CommandCategory; run: string; where: Where }[];
  extras: ({ name: string; where: "local"; run: string } | { name: string; where: "ci"; run?: string })[];
  app?: {
    start: string;
    url: string;
    default_port: number;
    ready_timeout: Duration;
    single_instance: boolean;
  };
  slots: {
    plan: { reproduce: SlotEntry[]; design: SlotEntry[] };
    build: { finish: SlotEntry[] };
    check: { review: SlotEntry[] };
  };
  sandbox: {
    hosts: string[];
    read_paths: string[];
  };
  copy_files: string[];
  time_limits: { plan: Duration; build: Duration; check: Duration };
  conflicts: { source: string; rule: string; answer: string }[];
}
