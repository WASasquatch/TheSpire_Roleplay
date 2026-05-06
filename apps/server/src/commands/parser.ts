export interface ParsedInput {
  /** lowercased command word, no leading slash; null when input is plain chat */
  command: string | null;
  /** raw argument text (everything after the command word, original casing) */
  argsText: string;
  /** whitespace-split args (best-effort, single quoted strings preserved) */
  args: string[];
}

const COMMAND_RX = /^\/(\S+)\s*(.*)$/s;

/** Split a string on whitespace while keeping "quoted strings" together. */
function tokenize(s: string): string[] {
  const out: string[] = [];
  const rx = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(s)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return out;
}

export function parseInput(raw: string): ParsedInput {
  const text = raw.trimStart();
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
