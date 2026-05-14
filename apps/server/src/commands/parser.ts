export interface ParsedInput {
  /** lowercased command word, no leading slash; null when input is plain chat */
  command: string | null;
  /** raw argument text (everything after the command word, original casing) */
  argsText: string;
  /** whitespace-split args (best-effort, single quoted strings preserved) */
  args: string[];
}

/**
 * Word/whitespace primitives that DELIBERATELY exclude NBSP (U+00A0).
 *
 * Master usernames are allowed to contain NBSP (the "Alt+0160" invisible
 * separator users use to fake spaces in names). JavaScript's default `\s`
 * and `\S` shortcuts include NBSP in the whitespace class — using them
 * would split `The[NBSP]Watcher` into two tokens, breaking /whisper,
 * /char, and every other command that takes a name as its first arg.
 *
 * `WS` is the ASCII whitespace set (space, tab, vertical-tab, formfeed,
 * carriage-return, newline). `NON_WS` is the negation; both are used
 * across the command parser and individual builtins.
 */
const WS = " \\t\\n\\r\\f\\v";
export const NBSP_AWARE_WS_RX = new RegExp(`[${WS}]+`);
const COMMAND_RX = new RegExp(`^\\/([^${WS}]+)[${WS}]*(.*)$`, "s");
const TOKEN_RX = new RegExp(`"([^"]*)"|'([^']*)'|([^${WS}]+)`, "g");

/**
 * Strip the first whitespace-delimited token (and its trailing
 * whitespace) from a string. Used by /whisper, /reply, /go, etc. to
 * recover the body text after the first positional argument. NBSP is
 * treated as a normal word character — same rationale as the
 * tokenizer above.
 */
export function stripFirstToken(argsText: string): string {
  return argsText.replace(new RegExp(`^[^${WS}]+[${WS}]*`), "");
}

/** Split a string on whitespace while keeping "quoted strings" together. */
function tokenize(s: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  // Reset lastIndex so a previous caller's match state doesn't bleed in.
  TOKEN_RX.lastIndex = 0;
  while ((m = TOKEN_RX.exec(s)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return out;
}

export function parseInput(raw: string): ParsedInput {
  // No `trimStart` here on purpose. A leading space is the user's
  // explicit escape hatch for "don't parse this as a command": typing
  // " :O" gets sent as a literal smiley instead of dispatching the
  // `:` action shortcut, and " /foo" gets sent as literal text
  // instead of routing to /foo. The existing `//` and `::` escapes
  // still work for users who don't want a leading space in the body,
  // and the dispatch layer preserves the leading space in the sent
  // body via `trimEnd()` (vs. `trim()`) so the space survives all
  // the way to the recipient's screen.
  const text = raw;

  /**
   * `:` action shortcut. ":walks in casually" is parsed as if the user
   * had typed "/me walks in casually" — no space required after the
   * colon, the action body is everything after it. Mirrors the muscle-
   * memory shortcut from older RP clients (IRC's `/me`, MUD `:`) so
   * pose-heavy users don't need a 3-character prefix per line.
   *
   * "::text" escapes to a literal say starting with a single colon —
   * same posture as "//foo" escaping a literal slash. " :text" (with
   * a leading space) is ALSO a literal say, since the parser only
   * triggers shortcuts when the very first character is `:` or `/`.
   */
  if (text.startsWith(":")) {
    if (text.startsWith("::")) {
      return { command: null, argsText: text.slice(1), args: [] };
    }
    const body = text.slice(1);
    return { command: "me", argsText: body, args: tokenize(body) };
  }

  if (!text.startsWith("/")) {
    return { command: null, argsText: raw, args: [] };
  }
  // escape literal slash: "//foo bar" → say "/foo bar"
  if (text.startsWith("//")) {
    return { command: null, argsText: text.slice(1), args: [] };
  }
  const m = COMMAND_RX.exec(text);
  if (!m) return { command: null, argsText: raw, args: [] };
  const command = (m[1] ?? "").toLowerCase();
  const argsText = m[2] ?? "";
  return { command, argsText, args: tokenize(argsText) };
}
