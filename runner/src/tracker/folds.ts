// Linear's fold syntax, which every Tracker adapter writes the same way (ADR 0019). A fold opens with
// `+++ <title>` and closes with a `+++` line. `>>>` is the older spelling of the same lines. A line inside a
// fenced code block is code, never a fold line, so a Python prompt such as `>>> import shaders` stays as it is.

const FOLD_LINE = /^(?:\+\+\+|>>>)(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** The fold's title for an opening line, `""` for a closing line, or `null` for any other line. */
function foldTitle(line: string): string | null {
  const match = FOLD_LINE.exec(line);
  if (match === null) return null;
  return match[1] ?? "";
}

/**
 * Each line with its fold title, or `null` for a line that isn't a fold line or sits in a fenced code block, and
 * the fence of a code block still open at the end of the text, or `null`.
 */
function scan(text: string): { lines: { line: string; title: string | null }[]; open: string | null } {
  let fence: string | null = null;
  const lines = text.split("\n").map((line) => {
    const marker = FENCE.exec(line)?.[1];
    if (fence === null) {
      if (marker !== undefined) fence = marker;
      return { line, title: marker === undefined ? foldTitle(line) : null };
    }
    // A closing fence is the opening fence's character, at least as many times, and nothing after.
    if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
    return { line, title: null };
  });
  return { lines, open: fence };
}

function foldLines(text: string): { line: string; title: string | null }[] {
  return scan(text).lines;
}

/** Closes a code block that runs to the end of the text, such as a pasted crash log, so the line after it isn't code. */
function closeFence(text: string): string {
  const { open } = scan(text);
  return open === null ? text : `${text}\n${open}`;
}

/** The titles of the text's opening fold lines, outside fenced code blocks. */
export function foldTitles(text: string): string[] {
  return foldLines(text).flatMap(({ title }) => (title === null || title === "" ? [] : [title]));
}

/** Writes every `>>>` fold line as `+++`. */
export function plusFolds(text: string): string {
  return foldLines(text)
    .map(({ line, title }) => {
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
  for (const { line, title } of foldLines(text)) {
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
  return `+++ ${title}\n\n${closeFence(body)}\n\n+++`;
}

/** The text inside the description's last fold when that fold is `+++ Report` and ends the description, else `null`. */
function trailingReport(description: string): string | null {
  const lines = foldLines(description.trimEnd());
  const close = lines.length - 1;
  if (lines[close]?.title !== "") return null;
  for (let open = close - 1; open >= 0; open--) {
    const title = lines[open]?.title ?? null;
    if (title === null) continue;
    if (title !== "Report") return null;
    return lines.slice(open + 1, close).map(({ line }) => line).join("\n").trim();
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
  const isBrief = inFold !== null && (runnerWroteBrief || /^## Summary[ \t]*(?:\n|$)/.test(description.trimStart()));
  return isBrief ? inFold : flattenFolds(description.trim());
}

/** The description `writeBrief` writes: the brief, then a `+++ Report` fold that holds the report. */
export function briefDescription(brief: string, description: string, runnerWroteBrief: boolean): string {
  return `${closeFence(plusFolds(brief.trim()))}\n\n${fold("Report", reportOf(description, runnerWroteBrief))}`;
}
