/* ============================================================================
   Mentions: which "@handle"s in a comment are addressed to someone.
   ----------------------------------------------------------------------------
   A mention is "@handle" or "@owner/agent". A handle inside code or a quote
   is talking about someone, not to them, so these are skipped:
     - inline code spans (`like this`, or ``with `ticks` inside``)
     - fenced code blocks (``` or ~~~, up to the closing fence or the end)
     - quoted lines (the first thing on the line is ">")

   Shared by the Worker, which decides who is notified (repo/inbox.ts), and
   the browser, which highlights who heard (Mentions.tsx). Both read the same
   matches from here, so the highlight never claims someone heard who didn't.
   ========================================================================== */

/* A person's handle, optionally followed by "/agent". Not after a letter or
   digit, so "me@example.com" is not a mention of "example". */
const MENTION = /(?<![a-z0-9])@([a-z0-9][a-z0-9-]*[a-z0-9](?:\/[a-z0-9][a-z0-9-]*[a-z0-9])?)/gi;

/* A run of backticks, closed by a run of exactly the same length, not across
   a blank line (that would be a new paragraph). */
const CODE_SPAN = /(?<!`)(`+)(?!`)((?:(?!\n[ \t]*\n)[\s\S])*?)(?<!`)\1(?!`)/g;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** The text with code and quotes blanked to spaces, same length, so indexes still line up. */
function blankIgnored(text: string): string {
  let fence: string | null = null;
  const lines = text.split("\n").map((line) => {
    const open = FENCE.exec(line);
    if (fence) {
      const closes = open && open[1][0] === fence[0] && open[1].length >= fence.length && line.trim() === open[1];
      if (closes) fence = null;
      return " ".repeat(line.length);
    }
    if (open) {
      fence = open[1];
      return " ".repeat(line.length);
    }
    if (/^\s*>/.test(line)) return " ".repeat(line.length);
    return line;
  });
  return lines.join("\n").replace(CODE_SPAN, (span) => span.replace(/[^\n]/g, " "));
}

export interface MentionMatch {
  /** The handle as written, without the "@". */
  handle: string;
  /** Where the "@" is in the text. */
  index: number;
  /** "@handle" exactly as it appears in the text. */
  text: string;
}

/** Every "@handle" in the text outside code and quotes, in order. */
export function mentionMatches(text: string): MentionMatch[] {
  return [...blankIgnored(text).matchAll(MENTION)].map((m) => ({
    handle: m[1],
    index: m.index ?? 0,
    text: m[0],
  }));
}
