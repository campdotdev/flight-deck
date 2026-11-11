// Linear's fold syntax, which every Tracker adapter writes the same way (ADR 0019). A fold opens with
// `+++ <title>` and closes with a `+++` line. `>>>` is the older spelling of the same lines.

const FOLD_LINE = /^(?:\+\+\+|>>>)(?:[ \t]+(.*?))?[ \t]*$/;
/** A Markdown code fence: up to three spaces, then three or more backticks or tildes. */
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** The fold's title for an opening line, `""` for a closing line, or `null` for any other line. */
function foldTitle(line: string): string | null {
  const match = FOLD_LINE.exec(line);
  if (match === null) return null;
  return match[1] ?? "";
}

/**
 * Each line's fold title, as `foldTitle` reads it, or `null` inside a fenced code block, so a `>>>` prompt in a
 * pasted reproduction stays code.
 */
function foldTitles(lines: readonly string[]): (string | null)[] {
  let fence: string | null = null;
  return lines.map((line) => {
    const match = FENCE_LINE.exec(line);
    if (fence === null) {
      // A backtick fence's info string has no backtick.
      if (match !== null && !(match[1]!.startsWith("`") && match[2]!.includes("`"))) {
        fence = match[1]!;
        return null;
      }
      return foldTitle(line);
    }
    // The closing fence is the same character, at least as long, with nothing after it.
    if (match !== null && match[1]![0] === fence[0] && match[1]!.length >= fence.length && match[2]!.trim() === "") fence = null;
    return null;
  });
}

/** Writes every `>>>` fold line as `+++`. */
export function plusFolds(text: string): string {
  const lines = text.split("\n");
  const titles = foldTitles(lines);
  return lines
    .map((line, index) => {
      const title = titles[index] ?? null;
      if (title === null) return line;
      return title === "" ? "+++" : `+++ ${title}`;
    })
    .join("\n");
}

/**
 * Linear folds don't nest, so text that goes inside a fold turns each opening line into `#### <title>` and
 * drops each closing line, with the blank line it leaves.
 */
export function flattenFolds(text: string): string {
  const out: string[] = [];
  let dropped = false;
  const lines = text.split("\n");
  const titles = foldTitles(lines);
  for (const [index, line] of lines.entries()) {
    const title = titles[index] ?? null;
    if (title === "") {
      dropped = true;
      continue;
    }
    // The blank line after a dropped closing line would double the one before it.
    if (dropped && line.trim() === "" && (out.at(-1) ?? "").trim() === "") continue;
    dropped = false;
    out.push(title === null ? line : `#### ${title}`);
  }
  return out.join("\n").trim();
}

/** A fold of text, written the way every adapter writes one. */
export function fold(title: string, body: string): string {
  return `+++ ${title}\n\n${body}\n\n+++`;
}

/** The text inside the description's last fold when that fold is `+++ Report` and ends the description, else `null`. */
function trailingReport(description: string): string | null {
  const lines = description.trimEnd().split("\n");
  const titles = foldTitles(lines);
  const close = lines.length - 1;
  if (titles[close] !== "") return null;
  for (let open = close - 1; open >= 0; open--) {
    const title = titles[open] ?? null;
    if (title === null) continue;
    if (title !== "Report") return null;
    return lines.slice(open + 1, close).join("\n").trim();
  }
  return null;
}

/**
 * The report to keep beneath a new brief (ADR 0026). The description is a brief when it ends with a
 * `+++ Report` fold, and either the runner wrote a brief for the issue or the description opens with the
 * template's first heading. Then the report is that fold's text. Otherwise the whole description is the report.
 */
export function reportOf(description: string, runnerWroteBrief: boolean): string {
  const inFold = trailingReport(description);
  const isBrief = inFold !== null && (runnerWroteBrief || description.trimStart().startsWith("## Summary"));
  return isBrief ? inFold : flattenFolds(description.trim());
}

/** The description `writeBrief` writes: the brief, then a `+++ Report` fold that holds the report. */
export function briefDescription(brief: string, description: string, runnerWroteBrief: boolean): string {
  return `${briefText(brief)}\n\n${fold("Report", reportOf(description, runnerWroteBrief))}`;
}

/**
 * The brief as `writeBrief` writes it above the report fold: trimmed, with `+++` folds and unsigned URLs. Issue
 * memory keeps this, so a re-plan's `previous-brief.md` compares with the description's brief (ADR 0026).
 */
export function briefText(brief: string): string {
  return unsigned(plusFolds(brief.trim()));
}

/**
 * Text with every `signature` query parameter taken out of its URLs, because the Linear MCP server signs each
 * upload URL as it returns it, with a 5-minute expiry (ADR 0019).
 */
export function unsigned(text: string): string {
  return text.replace(/([?&])signature=[^&\s)"'>]*(&?)/g, (_, lead: string, tail: string) => (tail === "" ? "" : lead));
}
