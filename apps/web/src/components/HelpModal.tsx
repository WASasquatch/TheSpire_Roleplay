import { useEffect, useMemo, useRef, useState } from "react";
import type { CommandDoc } from "@thekeep/shared";
import { parseInline } from "../lib/markdown.js";
import { HelpGuides } from "./HelpGuides.js";
import { Modal } from "./Modal.js";
import { useChat } from "../state/store.js";

interface Props {
  /** Initial filter - pre-fills the search box (e.g. /help char). */
  initialFilter?: string;
  onClose: () => void;
}

type HelpTab = "guides" | "commands" | "formatting";

/**
 * Help modal - searchable command reference with subcommand details.
 *
 * Replaces the previous /help toast which auto-dismissed and had no detail.
 * Lists every built-in + every enabled custom command from GET /commands;
 * an active filter is matched against name, aliases, descriptions, and
 * subcommand verbs/usage so users can find by example.
 */
export function HelpModal({ initialFilter, onClose }: Props) {
  // /help <something> jumps straight to the Commands tab so the filter applies;
  // bare /help opens on Guides since most newcomers want concept walkthroughs
  // before they want to grep slash commands.
  const [tab, setTab] = useState<HelpTab>(initialFilter ? "commands" : "guides");
  const [commands, setCommands] = useState<CommandDoc[] | null>(null);
  const [filter, setFilter] = useState(initialFilter ?? "");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Keyed on `commandsVersion` so the App-level listener for the
  // server's `commands:updated` broadcast forces a refetch when an
  // admin edits a custom command while this modal is already open
  // (or about to open). Without the key, a freshly-added command
  // wouldn't show up in the help list until a full tab reload.
  const commandsVersion = useChat((s) => s.commandsVersion);
  useEffect(() => {
    let cancelled = false;
    fetch("/commands", { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
        return r.json() as Promise<{ commands: CommandDoc[] }>;
      })
      .then((j) => { if (!cancelled) setCommands(j.commands); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "load failed"); });
    return () => { cancelled = true; };
  }, [commandsVersion]);

  // Focus the search input on open so / typing into the modal just works.
  // Only fires on the Commands tab - the Formatting tab has no search box.
  useEffect(() => {
    if (tab === "commands") inputRef.current?.focus();
  }, [tab]);

  const filtered = useMemo(() => {
    if (!commands) return [];
    const q = filter.trim().toLowerCase().replace(/^\//, "");
    if (!q) return commands;
    return commands.filter((c) => {
      if (c.name.includes(q)) return true;
      if (c.aliases.some((a) => a.includes(q))) return true;
      if (c.description.toLowerCase().includes(q)) return true;
      if (c.usage.toLowerCase().includes(q)) return true;
      for (const s of c.subcommands) {
        if (s.verb.toLowerCase().includes(q)) return true;
        if (s.usage.toLowerCase().includes(q)) return true;
        if (s.description.toLowerCase().includes(q)) return true;
        if (s.aliases.some((a) => a.toLowerCase().includes(q))) return true;
      }
      return false;
    });
  }, [commands, filter]);

  return (
    <Modal onClose={onClose} zIndex={50}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-[90vh] w-full flex-col rounded border border-keep-border bg-keep-bg shadow-xl md:w-[78vw] md:max-w-[1100px]"
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-keep-border bg-keep-panel px-4 py-2">
          <div className="flex items-center gap-2">
            <h2 className="font-action text-lg">Help</h2>
            <nav className="flex gap-1 text-xs uppercase tracking-widest">
              <TabBtn active={tab === "guides"} onClick={() => setTab("guides")}>
                Guides
              </TabBtn>
              <TabBtn active={tab === "commands"} onClick={() => setTab("commands")}>
                Commands
              </TabBtn>
              <TabBtn active={tab === "formatting"} onClick={() => setTab("formatting")}>
                Formatting
              </TabBtn>
            </nav>
          </div>
          {tab === "commands" ? (
            <input
              ref={inputRef}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search commands, aliases, subcommands..."
              className="flex-1 rounded border border-keep-border bg-keep-bg px-2 py-1 text-sm outline-none focus:border-keep-action"
            />
          ) : (
            <div className="flex-1" />
          )}
          <button onClick={onClose} className="text-sm text-keep-muted hover:text-keep-text">close</button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {tab === "commands" ? (
            error ? (
              <div className="rounded border border-keep-accent/40 bg-keep-accent/10 p-2 text-xs text-keep-accent">{error}</div>
            ) : !commands ? (
              <div className="text-keep-muted">loading...</div>
            ) : filtered.length === 0 ? (
              <div className="text-keep-muted">no matches.</div>
            ) : (
              <ul className="space-y-2">
                {filtered.map((c) => (
                  <CommandCard key={c.name} cmd={c} />
                ))}
              </ul>
            )
          ) : tab === "formatting" ? (
            <FormattingHelp />
          ) : (
            <HelpGuides />
          )}
        </div>

        <div className="shrink-0 space-y-0.5 border-t border-keep-border bg-keep-panel/40 p-2 text-[10px] text-keep-muted">
          <div>
            Mention someone in chat by typing <code className="text-keep-action">@username</code> - clickable, opens their active profile.
          </div>
          <div>
            Tip: <code>/help char</code> jumps right here. Press <kbd className="rounded border border-keep-border bg-keep-bg px-1">Esc</kbd> to close.
          </div>
        </div>
      </div>
    </Modal>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded border border-keep-border px-2 py-0.5 ${
        active ? "bg-keep-bg" : "bg-keep-panel/40 hover:bg-keep-panel"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Formatting reference. Each row shows the raw syntax in a code cell and
 * the actual rendered output via `parseInline` - so the examples are
 * always faithful to what the chat will produce, even if the parser is
 * tweaked later. Adding a new pattern? Add a row here too.
 */
const FORMATTING_ROWS: Array<{ syntax: string; example: string; note?: string }> = [
  { syntax: "**bold**", example: "**bold** is sturdy" },
  { syntax: "__bold__", example: "__bold__ is sturdy" },
  { syntax: "*italic*", example: "*italic* leans in" },
  { syntax: "_italic_", example: "talk _quietly_ now", note: "underscores require word boundaries - `snake_case_var` won't italicize" },
  { syntax: "***bold-italic***", example: "***both at once***" },
  { syntax: "~~strikethrough~~", example: "~~not a ghost~~" },
  { syntax: "`code`", example: "press `Enter` to send" },
  { syntax: "[link text](https://url)", example: "[the Spire](https://thespire.example)", note: "http and https URLs only - `javascript:` schemes are dropped silently" },
  { syntax: "https://url", example: "see https://example.com for details", note: "bare URLs are auto-linked at word boundaries" },
  { syntax: "![alt](https://image-url)", example: "![cat](https://example.com/cat.png)", note: "renders as a link with a Show image toggle - opt-in so loading the image doesn't leak your IP to the host" },
  { syntax: "https://.../photo.png", example: "screenshot: https://example.com/screenshot.png", note: "image URLs ending in png/jpg/jpeg/gif/webp/svg/bmp/avif also get the Show image toggle" },
  { syntax: "@username", example: "thanks @sigrid!", note: "click to open their profile; matches a master account or active character" },
  { syntax: "@world:slug", example: "anyone for a game in @world:ironreach?", note: "click to open the world viewer; slug is the world's URL slug (lowercase + hyphens)" },
  { syntax: "\\* escape", example: "\\*boinks Kaal on the head\\*", note: "put a backslash before a markdown character (* _ ~ | ` etc.) to keep it literal — useful for old-school IRC-style actions where you want the asterisks to show" },
];

/**
 * Categorized listing of every HTML construct the bio/world-page sanitizer
 * accepts. Mirrors the allow-list in apps/server/src/auth/html.ts —
 * keep them in sync when one changes. Anything outside this list is
 * dropped silently on save.
 */
const HTML_TAG_GROUPS: Array<{ label: string; tags: string[]; note?: string }> = [
  {
    label: "Inline text",
    tags: ["b", "i", "u", "em", "strong", "s", "mark", "small", "sub", "sup", "code", "kbd", "var", "samp", "abbr", "cite", "q"],
  },
  {
    label: "Block structure",
    tags: ["p", "div", "br", "blockquote", "pre", "hr", "h3", "h4", "h5", "h6", "figure", "figcaption"],
    note: "h1 and h2 are reserved for the site chrome (banner, modal titles); writer content tops out at h3.",
  },
  {
    label: "Lists",
    tags: ["ul", "ol", "li", "dl", "dt", "dd"],
  },
  {
    label: "Tables",
    tags: ["table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td"],
    note: "th/td accept colspan, rowspan, scope, headers.",
  },
  {
    label: "Disclosure (spoilers / NSFW gates)",
    tags: ["details", "summary"],
    note: "<details open> ships a section pre-expanded.",
  },
  {
    label: "Links & media",
    tags: ["a", "img", "span"],
    note: "a href: http/https/mailto only. img src: http/https only. javascript: and data: schemes are blocked.",
  },
];

const HTML_STYLE_PROPS: Array<{ prop: string; values: string }> = [
  { prop: "color, background-color", values: "#abc, #aabbcc, rgb(…), rgba(…)" },
  { prop: "font-weight", values: "normal, bold, lighter, bolder, 100 to 900 (step 100)" },
  { prop: "font-style", values: "italic, normal, oblique" },
  { prop: "font-family", values: "any name list up to 200 chars" },
  { prop: "font-size", values: "1 to 72px, 0.5 to 4em, 50 to 400%, or named (small/large/etc.)" },
  { prop: "line-height", values: "0.0 to 3.9, or 10 to 69px" },
  { prop: "text-decoration", values: "underline, line-through, overline, none" },
  { prop: "text-align", values: "left, right, center, justify" },
  { prop: "list-style-type", values: "disc, circle, square, decimal, lower/upper-roman, lower/upper-alpha, none" },
  { prop: "vertical-align", values: "baseline, top, middle, bottom, sub, super" },
];

function FormattingHelp() {
  return (
    <div className="space-y-3 text-xs">
      <p className="text-keep-muted">
        Chat messages support a small set of formatting shortcuts.
        Headings, lists, tables, and other big-block stuff stays off
        in chat. Profile and world pages can use more (see the
        Profile / world HTML section below).
      </p>
      <p className="text-[11px] text-keep-muted">
        Tip: highlight a word in any text box to see synonyms.
        Up/Down to choose, Enter to swap, Esc to close.
      </p>

      <div className="overflow-hidden rounded border border-keep-border">
        <table className="w-full text-[12px]">
          <thead className="bg-keep-panel/50 text-[10px] uppercase tracking-widest text-keep-muted">
            <tr>
              <th className="w-1/2 px-2 py-1 text-left">You type</th>
              <th className="w-1/2 px-2 py-1 text-left">It renders as</th>
            </tr>
          </thead>
          <tbody>
            {FORMATTING_ROWS.map((r) => (
              <tr key={r.syntax} className="border-t border-keep-border align-top">
                <td className="px-2 py-1.5 align-top">
                  <div className="font-mono text-keep-text">{r.example}</div>
                  {r.note ? (
                    <div className="mt-1 text-[10px] text-keep-muted">{r.note}</div>
                  ) : null}
                </td>
                <td className="px-2 py-1.5 align-top">
                  {/*
                    Render via the same parseInline used by MessageList so the
                    preview is guaranteed to match what messages actually show.
                  */}
                  <div className="text-keep-text">{parseInline(r.example)}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-5 border-t border-keep-rule/40 pt-3">
        <h3 className="mb-1 font-action text-sm uppercase tracking-widest text-keep-text">
          Profile / world HTML
        </h3>
        <p className="text-keep-muted">
          On profiles and world pages, you can use a small set of HTML
          tags to lay out your text. Plain typing works too. Anything
          on the list below is fine to use; anything else is dropped
          when you save. The list keeps things safe so nothing weird
          can run on other people's screens.
        </p>

        <div className="mt-2 overflow-hidden rounded border border-keep-border">
          <table className="w-full text-[12px]">
            <thead className="bg-keep-panel/50 text-[10px] uppercase tracking-widest text-keep-muted">
              <tr>
                <th className="w-1/4 px-2 py-1 text-left">Category</th>
                <th className="px-2 py-1 text-left">Allowed tags</th>
              </tr>
            </thead>
            <tbody>
              {HTML_TAG_GROUPS.map((g) => (
                <tr key={g.label} className="border-t border-keep-border align-top">
                  <td className="px-2 py-1.5 font-semibold text-keep-text">{g.label}</td>
                  <td className="px-2 py-1.5">
                    <div className="flex flex-wrap gap-1">
                      {g.tags.map((t) => (
                        <code key={t} className="rounded bg-keep-panel/60 px-1 font-mono text-[11px] text-keep-action">
                          &lt;{t}&gt;
                        </code>
                      ))}
                    </div>
                    {g.note ? (
                      <div className="mt-1 text-[10px] text-keep-muted">{g.note}</div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-3 text-keep-muted">
          You can also add a small bit of styling using a{" "}
          <code className="font-mono text-keep-action">style</code> on
          any tag. The properties you can change are listed below.
          Links open in a new tab automatically.
        </p>

        <h4 className="mt-3 font-action text-xs uppercase tracking-widest text-keep-muted">
          Styling you can use
        </h4>
        <div className="mt-1 overflow-hidden rounded border border-keep-border">
          <table className="w-full text-[12px]">
            <thead className="bg-keep-panel/50 text-[10px] uppercase tracking-widest text-keep-muted">
              <tr>
                <th className="w-1/3 px-2 py-1 text-left">Property</th>
                <th className="px-2 py-1 text-left">Allowed values</th>
              </tr>
            </thead>
            <tbody>
              {HTML_STYLE_PROPS.map((s) => (
                <tr key={s.prop} className="border-t border-keep-border align-top">
                  <td className="px-2 py-1 font-mono text-keep-action">{s.prop}</td>
                  <td className="px-2 py-1 text-keep-text">{s.values}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h4 className="mt-3 font-action text-xs uppercase tracking-widest text-keep-muted">
          Example bio snippet
        </h4>
        <pre className="overflow-x-auto rounded border border-keep-rule/60 bg-keep-panel/30 p-2 font-mono text-[10px] leading-relaxed">{`<h3 style="color:#a83232">Character Name</h3>
<p style="font-style:italic">"A short opening line."</p>

<h4>At a glance</h4>
<table>
  <tr><th>Age</th><td>32</td></tr>
  <tr><th>Build</th><td>Tall, scarred</td></tr>
</table>

<details>
  <summary>Content warnings</summary>
  <p>Grief, violence (no on-screen without buy-in).</p>
</details>`}</pre>
        <p className="mt-1 text-[10px] text-keep-muted">
          The <b>Building a profile</b> guide on the Guides tab walks
          through the editor step by step with more examples.
        </p>
      </div>

      <details className="rounded border border-keep-border bg-keep-panel/30 p-2">
        <summary className="cursor-pointer text-keep-muted">Edge cases &amp; gotchas</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-[11px] text-keep-muted">
          <li>
            <b>Asterisks work intraword.</b> <code>f**oo**bar</code> bolds
            the <code>oo</code>. Underscores don't -{" "}
            <code>snake_case_var</code> stays plain text.
          </li>
          <li>
            <b>Whitespace breaks emphasis.</b> <code>* foo *</code> is plain
            text; <code>*foo*</code> is italic. The character on each side of
            the delimiter must be non-whitespace.
          </li>
          <li>
            <b>Unmatched delimiters fall through.</b> <code>**unclosed</code>{" "}
            renders as <code>**unclosed</code> rather than disappearing.
          </li>
          <li>
            <b>Newlines pass through as text.</b> Multi-line messages stack
            their lines but don't get block-level formatting.
          </li>
          <li>
            <b>Images stay opt-in.</b> Even when a URL ends in
            <code>.png</code>, you'll see a link with a "Show image" button -
            click to load it inline (max 480×360). The image's host can see
            your IP only if you click; <code>referrerPolicy="no-referrer"</code>{" "}
            blocks the chat URL from leaking via Referer.
          </li>
        </ul>
      </details>
    </div>
  );
}

function CommandCard({ cmd }: { cmd: CommandDoc }) {
  return (
    <li className="rounded border border-keep-border bg-keep-bg p-2 text-xs">
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="font-mono font-bold text-keep-action">/{cmd.name}</span>
          {cmd.isCustom ? (
            <span className="rounded bg-keep-action/20 px-1 text-[10px] uppercase tracking-widest text-keep-action">custom</span>
          ) : null}
        </div>
        {cmd.aliases.length ? (
          <div className="font-mono text-keep-muted">
            also: {cmd.aliases.map((a) => `/${a}`).join(" ")}
          </div>
        ) : null}
      </div>

      <div className="mt-1 font-mono text-[11px] text-keep-text">{cmd.usage}</div>
      {cmd.description ? (
        <div className="mt-1 text-keep-muted">{cmd.description}</div>
      ) : null}

      {cmd.subcommands.length ? (
        <div className="mt-2 rounded border border-keep-rule/40 bg-keep-panel/30">
          <div className="border-b border-keep-rule/40 px-2 py-1 text-[10px] uppercase tracking-widest text-keep-muted">
            Options
          </div>
          <table className="w-full text-[11px]">
            <tbody>
              {cmd.subcommands.map((s, i) => (
                <tr key={`${s.verb}-${i}`} className="border-t border-keep-rule/20 align-top first:border-t-0">
                  {/* whitespace-nowrap so a long placeholder verb like
                      "(no args, away)" doesn't wrap and squash the description */}
                  <td className="whitespace-nowrap py-1 pl-2 pr-3 font-mono text-keep-action">{s.verb}</td>
                  <td className="py-1 pr-2">
                    <div className="font-mono">{s.usage}</div>
                    <div className="text-keep-muted">{s.description}</div>
                    {s.aliases.length ? (
                      <div className="mt-0.5 font-mono text-[10px] text-keep-muted">
                        aliases: {s.aliases.join(", ")}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </li>
  );
}
