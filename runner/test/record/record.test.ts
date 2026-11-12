import { describe, expect, test } from "bun:test";
import { readRecord } from "../../src/record/index.ts";

const shaders = await Bun.file(new URL("fixtures/shaders.toml", import.meta.url)).text();

/** Shaders' record with one exact piece of text replaced. Fails when the piece isn't there. */
function edit(from: string, to: string, text = shaders): string {
  if (!text.includes(from)) throw new Error(`not in the record: ${from}`);
  return text.replace(from, to);
}

function errorsOf(text: string): string[] {
  const result = readRecord(text);
  if (result.ok) throw new Error("expected the record to be invalid");
  return result.errors;
}

describe("parse errors", () => {
  test.each([
    ["a value missing after =", edit('team = "SHA"', "team ="), ["line 11: Missing value after '='; values must be on the same line"]],
    ["a table defined twice", edit("[app]\n", "[tracker]\n"), ["line 102: Cannot redefine table 'tracker'"]],
    ["a key defined twice", edit('team = "SHA"', 'team = "SHA"\nteam = "SHA"'), ["line 12: Cannot redefine key 'team'"]],
    ["after a multi-line value", edit('folders = ["node_modules"]', 'folders = [\n  "node_modules",\n]\nfolders = []'), ["line 35: Cannot redefine key 'folders'"]],
    ["an unterminated string", edit('team = "SHA"', 'team = "SHA'), ["line 11: Unterminated string; newlines must be escaped in basic strings"]],
    ["an unterminated string after a multi-line one", edit('team = "SHA"', 'team = """\nSHA"""\nnote = """\nSHA'), ["line 13: Unterminated string"]],
  ])("%s names its line", (_, text, expected) => {
    expect(errorsOf(text)).toEqual(expected);
  });
});

describe("the schema key", () => {
  test("a newer schema returns only the error that asks for flight-deck update", () => {
    let text = edit("schema = 1", "schema = 2");
    text = edit('team = "SHA"\n', "", text);
    text = `${text}\n[[review_bots]]\nname = "Copilot"\n`;
    const result = readRecord(text);
    expect(result).toEqual({
      ok: false,
      reason: "newer",
      schema: 2,
      errors: ["schema: is 2, newer than the schema 1 this runner reads. Run flight-deck update."],
    });
  });

  test.each([
    ["an older schema", edit("schema = 1", "schema = 0"), ["schema: must be 1"]],
    ["a schema that isn't a number", edit("schema = 1", 'schema = "2"'), ["schema: must be 1"]],
    ["FLD-42's version key", edit("schema = 1", "version = 1"), ["schema: is missing", "version: is not a schema-1 field"]],
    ["a schema that isn't the first key", edit("schema = 1\n\ncopy_files = []\n", "copy_files = []\nschema = 1\n"), ["schema: must be the first key"]],
  ])("%s is invalid", (_, text, expected) => {
    expect(errorsOf(text)).toEqual(expected);
  });

  test("comments may come before schema", () => {
    expect(shaders.startsWith("# Flight Deck repo record")).toBe(true);
    expect(readRecord(`\n# another comment\n${shaders}`).ok).toBe(true);
  });
});

describe("schema errors", () => {
  test.each([
    ["a missing key", edit('team = "SHA"\n', ""), ["tracker.team: is missing"]],
    ["a missing table", edit('[time_limits]\nplan = "30m"\nbuild = "90m"\ncheck = "45m"\n', ""), ["time_limits: is missing"]],
    ["a missing status", edit('canceled = "Canceled"\n', ""), ["tracker.statuses.canceled: is missing"]],
    ["an unknown top-level key", edit("copy_files = []\n", 'copy_files = []\nci = "20m"\n'), ["ci: is not a schema-1 field"]],
    ["an unknown key in a table", edit('check = "45m"\n', 'check = "45m"\nci = "20m"\n'), ["time_limits.ci: is not a schema-1 field"]],
    [
      "a bad category, counting from 1",
      edit('category = "lint"', 'category = "style"'),
      ["commands[2].category: must be one of types, lint, format, unit, integration, e2e"],
    ],
    ["a wrong type", edit("default_port = 3000", 'default_port = "3000"'), ["app.default_port: must be an integer"]],
    ["a wrong const", edit('kind = "linear"', 'kind = "jira"'), ['tracker.kind: must be "linear"']],
    ["a list that isn't one", edit("copy_files = []", 'copy_files = ".env"'), ["copy_files: must be a list"]],
    ["a table that isn't one", edit('plan = { reproduce = ["reproducing-bugs"], design = [] }', 'plan = "reproducing-bugs"'), ["slots.plan: must be a table"]],
    ["an empty string", edit('team = "SHA"', 'team = ""'), ["tracker.team: must not be empty"]],
    ["a port out of range", edit("default_port = 3000", "default_port = 70000"), ["app.default_port: must be between 1 and 65535"]],
    ["a boolean that isn't one", edit("single_instance = false", 'single_instance = "no"'), ["app.single_instance: must be true or false"]],
    ["a start command with no {port}", edit("next dev -p {port}", "next dev -p 3000"), ['app.start: must hold "{port}"']],
    ["a local extra with no run", edit('where = "local"\nrun = "pnpm build"\n', 'where = "local"\n'), ["extras[1].run: is missing"]],
  ])("%s", (_, text, expected) => {
    expect(errorsOf(text)).toEqual(expected);
  });

  test("sort by the line of the offending key, or of a missing key's table header, with top-level keys at line 0", () => {
    let text = shaders;
    text = edit('plan = "30m"', 'plan = "half an hour"', text); // near the end
    text = edit('team = "SHA"\n', "", text); // missing from [tracker]
    text = edit('category = "unit"', 'category = "tests"', text); // commands[4]
    text = edit("schema = 1\n", "schema = 1\nversion = 1\n", text); // right after schema
    text = edit("copy_files = []", 'copy_files = ["/etc/hosts"]', text); // top level, before [tracker]
    text = edit('name = "Fallow audit"\nwhere = "ci"\n', 'name = "Fallow audit"\n', text); // extras[5], its header
    text = edit("check = { review = [] }", "check = {}", text); // missing from an inline table, its key's line
    text = text.slice(0, text.indexOf("[[conflicts]]")); // a missing top-level key, line 0
    expect(errorsOf(text)).toEqual([
      "conflicts: is missing",
      "version: is not a schema-1 field",
      'copy_files[1]: must be a path relative to the checkout, with no leading "/" and no ".." part',
      "tracker.team: is missing",
      'commands[4].category: must be one of types, lint, format, unit, integration, e2e',
      "extras[5].where: is missing",
      "slots.check.review: is missing",
      'time_limits.plan: must be a duration such as "30m" or "1h30m"',
    ]);
  });

  test("a missing key sorts by its table's own header, even when a child table's header comes first", () => {
    let text = edit('[tracker]\nkind = "linear"\nworkspace = "campdotdev"\nteam = "SHA"\n\n', "");
    text = edit('folders = ["node_modules"]\n', 'folders = "node_modules"\n\n[tracker]\nkind = "linear"\nworkspace = "campdotdev"\n', text);
    expect(errorsOf(text)).toEqual(["dependencies.folders: must be a list", "tracker.team: is missing"]);
  });

  test("a CI-only extra may leave out run", () => {
    expect(readRecord(shaders).ok).toBe(true);
    expect(shaders).toContain('[[extras]]\nname = "Fallow audit"\nwhere = "ci"\n');
  });
});

/** The errors with one of Shaders' lines, given whole, set to another TOML value, or `[]` when the record is valid. */
function errorsFor(line: string, value: string): string[] {
  const key = line.slice(0, line.indexOf(" = "));
  const result = readRecord(edit(`\n${line}\n`, `\n${key} = ${value}\n`));
  return result.ok ? [] : result.errors;
}

const PLAN = 'plan = "30m"';
const HOSTS = 'hosts = ["registry.npmjs.org", "nodejs.org", "fonts.googleapis.com", "fonts.gstatic.com"]';
const STATUS: Record<string, string> = { planning: "Planning", ready_to_plan: "Ready to plan", duplicate: "Duplicate" };
const DURATION = 'must be a duration such as "30m" or "1h30m"';

describe("durations", () => {
  test.each(["30m", "1h30m", "45s", "2h", "1h1m1s", "180s"])("%s is a duration", (value) => {
    expect(errorsFor(PLAN, JSON.stringify(value))).toEqual([]);
  });

  test.each(["", "30", "m", "30 m", "1.5h", "30min", "-5m", "1d"])('"%s" is not', (value) => {
    expect(errorsFor(PLAN, JSON.stringify(value))).toEqual([`time_limits.plan: ${DURATION}`]);
  });

  test("a number is not", () => {
    expect(errorsFor(PLAN, "30")).toEqual(["time_limits.plan: must be a string"]);
  });

  test("ready_timeout is a duration too", () => {
    expect(errorsFor('ready_timeout = "180s"', '"3 minutes"')).toEqual([`app.ready_timeout: ${DURATION}`]);
  });
});

const HOST_FORM = 'must be a full host name such as "registry.npmjs.org", or a wildcard such as "*.example.com"';

describe("hosts", () => {
  test.each(["registry.npmjs.org", "nodejs.org", "*.example.com", "fonts.gstatic.com", "*.githubusercontent.com"])(
    "%s may be reached",
    (host) => {
      expect(errorsFor(HOSTS, JSON.stringify([host]))).toEqual([]);
    },
  );

  test.each(["https://registry.npmjs.org", "registry.npmjs.org/path", "registry.npmjs.org:443", "localhost", "*", "*.", "**.example.com", "example.*.com", ""])(
    '"%s" is not a host',
    (host) => {
      expect(errorsFor(HOSTS, JSON.stringify([host]))).toEqual([`sandbox.hosts[1]: ${HOST_FORM}`]);
    },
  );

  test.each([
    ["github.com", "is GitHub, and no session may reach GitHub"],
    ["api.github.com", "is GitHub, and no session may reach GitHub"],
    ["uploads.github.com", "is GitHub, and no session may reach GitHub"],
    ["GitHub.com", "is GitHub, and no session may reach GitHub"],
    ["*.github.com", "matches api.github.com, and no session may reach GitHub"],
    ["*.com", "matches github.com, and no session may reach GitHub"],
    ["*.GITHUB.com", "matches api.github.com, and no session may reach GitHub"],
  ])("%s is an error", (host, message) => {
    expect(errorsFor(HOSTS, JSON.stringify(["nodejs.org", host]))).toEqual([`sandbox.hosts[2]: ${message}`]);
  });
});

const HOME_FORM = 'must be a path inside "~/", such as "~/.npm", with no "." or ".." part and no glob character';

describe("read_paths", () => {
  test.each(["~/.npm", "~/.cache/ms-playwright", "~/Library/Caches/pnpm", "~/.config/git", "~/.local/state/x", "~/.npm/"])(
    "%s may be read",
    (path) => {
      expect(errorsFor('read_paths = []', JSON.stringify([path]))).toEqual([]);
    },
  );

  test.each(["~/", "~", "/Users/maintainer/.npm", ".npm", "~/../etc", "~/./.ssh", "~//.ssh", "~/.npm/..", "~/.config/flight-*/**", "~/.ss?", "~/.[s]sh", "~/{.ssh,.npm}"])('"%s" is not a path inside ~/', (path) => {
    expect(errorsFor('read_paths = []', JSON.stringify([path]))).toEqual([`sandbox.read_paths[1]: ${HOME_FORM}`]);
  });

  test.each([
    ["~/.ssh", "~/.ssh"],
    ["~/.ssh/", "~/.ssh"],
    ["~/.ssh/known_hosts", "~/.ssh"],
    ["~/.SSH", "~/.ssh"],
    ["~/.config/flight-deck", "~/.config/flight-deck"],
    ["~/.config", "~/.config/flight-deck"],
    ["~/.config/gh/hosts.yml", "~/.config/gh"],
    ["~/.local", "~/.local/share/flight-deck"],
    ["~/.local/share/flight-deck/state", "~/.local/share/flight-deck"],
    ["~/.claude", "~/.claude"],
    ["~/.claude/skills", "~/.claude"],
    ["~/.gnupg", "~/.gnupg"],
    ["~/.aws/config", "~/.aws"],
    ["~/.npmrc", "~/.npmrc"],
    ["~/.NPMRC", "~/.npmrc"],
    ["~/.git-credentials", "~/.git-credentials"],
    ["~/Library", "~/Library/Keychains"],
    ["~/Library/Keychains/login.keychain-db", "~/Library/Keychains"],
  ])("%s is an error", (path, folder) => {
    expect(errorsFor('read_paths = []', JSON.stringify(["~/.npm", path]))).toEqual([
      `sandbox.read_paths[2]: reopens ${folder}, which no session may read`,
    ]);
  });

  test("a rule's error and the schema's in one list come out in the list's order", () => {
    expect(errorsFor("read_paths = []", '["~/.ssh", "~/.ss?"]')).toEqual([
      "sandbox.read_paths[1]: reopens ~/.ssh, which no session may read",
      `sandbox.read_paths[2]: ${HOME_FORM}`,
    ]);
    expect(errorsFor(HOSTS, '[\n  "github.com",\n  "not a host",\n]')).toEqual([
      "sandbox.hosts[1]: is GitHub, and no session may reach GitHub",
      `sandbox.hosts[2]: ${HOST_FORM}`,
    ]);
  });
});

const CHECKOUT_FORM = 'must be a path relative to the checkout, with no leading "/" and no ".." part';

describe("copy_files", () => {
  test.each([".env", "apps/docs/.env.local", "..env", "config/.secrets..json"])("%s may be copied", (path) => {
    expect(errorsFor('copy_files = []', JSON.stringify([path]))).toEqual([]);
  });

  test.each(["/etc/hosts", "../secrets", "apps/../../x", "apps/..", ".."])('"%s" is an error', (path) => {
    expect(errorsFor('copy_files = []', JSON.stringify([".env", path]))).toEqual([`copy_files[2]: ${CHECKOUT_FORM}`]);
  });

  test("dependency folders stay inside the worktree too", () => {
    expect(errorsFor('folders = ["node_modules"]', '["../node_modules"]')).toEqual([
      'dependencies.folders[1]: must be a path relative to the worktree, with no leading "/" and no ".." part',
    ]);
  });
});

const SLOT_FORM = 'must be a skill name, or a path ".claude/skills/<name>" naming one folder';

describe("slot entries", () => {
  test.each(["reproducing-bugs", "design-check", ".claude/skills/react-doctor", ".claude/skills/a.b"])("%s has the form of a skill", (entry) => {
    expect(errorsFor('build = { finish = [] }', `{ finish = ${JSON.stringify([entry])} }`)).toEqual([]);
  });

  test.each([".claude/skills/", ".claude/skills/a/b", "skills/foo", ".claude/foo", "..", ".", ".claude/skills/..", "", "/abs/skill"])(
    '"%s" is an error',
    (entry) => {
      expect(errorsFor('build = { finish = [] }', `{ finish = ${JSON.stringify(["changeset", entry])} }`)).toEqual([`slots.build.finish[2]: ${SLOT_FORM}`]);
    },
  );

  test("an unknown slot is an error", () => {
    expect(errorsFor('build = { finish = [] }', "{ finish = [], start = [] }")).toEqual(["slots.build.start: is not a schema-1 field"]);
  });
});

describe("duplicates", () => {
  test("two commands with one category", () => {
    const text = edit('name = "format"\ncategory = "format"', 'name = "format"\ncategory = "lint"');
    expect(errorsOf(text)).toEqual(['commands[3].category: "lint" is also commands[2]\'s category, and each category takes one command']);
  });

  test("a name shared across commands and extras", () => {
    const text = edit('name = "build"\nwhere = "local"', 'name = "unit"\nwhere = "local"');
    expect(errorsOf(text)).toEqual(['extras[1].name: "unit" is also the name of commands[4]']);
  });

  test("a name shared by two extras", () => {
    const text = edit('name = "Fallow audit"', 'name = "React Doctor"');
    expect(errorsOf(text)).toEqual(['extras[5].name: "React Doctor" is also the name of extras[4]']);
  });

  test("names compare exactly", () => {
    expect(shaders).toContain('name = "fallow-audit"');
    expect(shaders).toContain('name = "Fallow audit"');
    expect(readRecord(edit('name = "React Doctor"', 'name = "react-doctor "')).ok).toBe(true);
  });
});

describe("status names", () => {
  test("intake and backlog may share one", () => {
    expect(errorsFor('intake = "Triage"', '"Backlog"')).toEqual([]);
  });

  test.each([
    ["planning", '"Building"', 'tracker.statuses.building: "Building" is also planning\'s status, and only intake and backlog may share one'],
    ["ready_to_plan", '"Backlog"', 'tracker.statuses.ready_to_plan: "Backlog" is also backlog\'s status, and only intake and backlog may share one'],
    ["duplicate", '"Canceled"', 'tracker.statuses.duplicate: "Canceled" is also canceled\'s status, and only intake and backlog may share one'],
  ])("%s set to %s is an error", (role, value, error) => {
    expect(errorsFor(`${role} = ${JSON.stringify(STATUS[role])}`, value)).toEqual([error]);
  });
});

describe("the [app] table", () => {
  test("may be absent", () => {
    const start = shaders.indexOf("[app]\n");
    const end = shaders.indexOf("# design and finish");
    const result = readRecord(shaders.slice(0, start) + shaders.slice(end));
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.record.app).toBeUndefined();
  });

  test("needs every key when present", () => {
    expect(errorsOf(edit('url = "http://localhost:{port}/"\n', ""))).toEqual(["app.url: is missing"]);
  });

  test("is the only optional table", () => {
    const tables = ["[tracker.statuses]", "[dependencies]", "[slots]", "[sandbox]", "[time_limits]"];
    for (const table of tables) {
      const start = shaders.indexOf(`${table}\n`);
      const end = shaders.indexOf("\n\n", start);
      const name = table.slice(1, -1);
      expect(errorsOf(shaders.slice(0, start) + shaders.slice(end))).toEqual([`${name}: is missing`]);
    }
  });

  test("empty lists stay written out", () => {
    expect(errorsOf(edit("copy_files = []\n", ""))).toEqual(["copy_files: is missing"]);
    expect(errorsOf(edit("read_paths = []\n", ""))).toEqual(["sandbox.read_paths: is missing"]);
  });
});

/** Every `key = value` line of Shaders' record, with the path an error names for it. */
function shadersKeys(): { path: string; line: string; index: number; value: string }[] {
  const keys: { path: string; line: string; index: number; value: string }[] = [];
  const counts = new Map<string, number>();
  let table = "";
  shaders.split("\n").forEach((line, index) => {
    const array = /^\[\[(\w+)\]\]$/.exec(line);
    const header = /^\[([\w.]+)\]$/.exec(line);
    const key = /^(\w+) = (.*)$/.exec(line);
    if (array?.[1]) {
      const n = (counts.get(array[1]) ?? 0) + 1;
      counts.set(array[1], n);
      table = `${array[1]}[${n}]`;
    } else if (header?.[1]) {
      table = header[1];
    } else if (key?.[1] && key[2]) {
      keys.push({ path: table ? `${table}.${key[1]}` : key[1], line, index, value: key[2] });
    }
  });
  return keys;
}

const WRONG_TYPE: Record<string, [string, string]> = {
  schema: ['"1"', "must be 1"],
  kind: ['"jira"', 'must be "linear"'],
  category: ['"tests"', "must be one of types, lint, format, unit, integration, e2e"],
  where: ['"both"', "must be one of local, ci"],
};

function wrongType(key: string, value: string): [string, string] {
  const named = WRONG_TYPE[key];
  if (named) return named;
  if (value.startsWith('"')) return ["1", "must be a string"];
  if (value.startsWith("[")) return ['"x"', "must be a list"];
  if (value.startsWith("{")) return ["1", "must be a table"];
  if (value === "true" || value === "false") return ['"x"', "must be true or false"];
  return ['"x"', "must be an integer"];
}

describe("every field in Shaders' record", () => {
  const keys = shadersKeys();
  const lines = shaders.split("\n");

  test("is found by the sweep", () => {
    expect(keys.length).toBe(76);
  });

  test.each(keys.filter((key) => !key.path.startsWith("app.")).map((key) => [key.path, key.index] as const))(
    "%s is required",
    (path, index) => {
      const text = lines.filter((_, i) => i !== index).join("\n");
      expect(errorsOf(text)).toEqual([`${path}: is missing`]);
    },
  );

  test.each(keys.map((key) => [key.path, key.index, key.value] as const))("%s has its type", (path, index, value) => {
    const key = path.slice(path.lastIndexOf(".") + 1);
    const [wrong, message] = wrongType(key, value);
    const text = lines.map((line, i) => (i === index ? `${key} = ${wrong}` : line)).join("\n");
    expect(errorsOf(text)).toEqual([`${path}: ${message}`]);
  });
});

describe("Shaders' record", () => {
  test("parses clean, word for word as spec 1 gives it", () => {
    const result = readRecord(shaders);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    expect(result.record.schema).toBe(1);
    expect(result.record.tracker.team).toBe("SHA");
    expect(result.record.tracker.statuses.ready_to_plan).toBe("Ready to plan");
    expect(result.record.commands.map((c) => c.category)).toEqual(["types", "lint", "format", "unit", "e2e"]);
    expect(result.record.extras).toHaveLength(5);
    expect(result.record.app?.default_port).toBe(3000);
    expect(result.record.slots.plan.reproduce).toEqual(["reproducing-bugs"]);
    expect(result.record.time_limits).toEqual({ plan: "30m", build: "90m", check: "45m" });
    expect(result.record.conflicts).toHaveLength(3);
  });
});
