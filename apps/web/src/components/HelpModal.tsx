import { useEffect, useMemo, useRef, useState } from "react";
import type { CommandDoc } from "@thekeep/shared";
import { markVerified } from "@thekeep/shared";
import { parseInline } from "../lib/markdown.js";
import { HelpGuides } from "./HelpGuides.js";
import { Modal, MODAL_CARD_CONTENT } from "./Modal.js";
import { useChat } from "../state/store.js";
import { CloseButton } from "./CloseButton.js";

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
    // Score each command by best-matching field. Lower = better. The
    // previous implementation was a plain `.filter()` that left results
    // in catalog order, so searching "request" surfaced /accept,
    // /decline, /dissolve (which mention "request" in their description)
    // BEFORE /request itself. Now exact-name matches always win, then
    // name-prefix, then name-substring, then aliases, then subcommands,
    // then description/usage hits as the long-tail fallback.
    function scoreCommand(c: CommandDoc): number {
      const name = c.name.toLowerCase();
      if (name === q) return 0;
      if (name.startsWith(q)) return 1;
      const aliasExact = c.aliases.some((a) => a.toLowerCase() === q);
      if (aliasExact) return 2;
      if (name.includes(q)) return 3;
      const aliasPrefix = c.aliases.some((a) => a.toLowerCase().startsWith(q));
      if (aliasPrefix) return 4;
      const aliasContains = c.aliases.some((a) => a.toLowerCase().includes(q));
      if (aliasContains) return 5;
      // Subcommand verb hits: exact / prefix / substring.
      let bestSub = Infinity;
      for (const s of c.subcommands) {
        const verb = s.verb.toLowerCase();
        if (verb === q) bestSub = Math.min(bestSub, 6);
        else if (verb.startsWith(q)) bestSub = Math.min(bestSub, 7);
        else if (verb.includes(q)) bestSub = Math.min(bestSub, 8);
        else if (s.aliases.some((a) => a.toLowerCase() === q)) bestSub = Math.min(bestSub, 8);
        else if (s.usage.toLowerCase().includes(q)) bestSub = Math.min(bestSub, 9);
        else if (s.description.toLowerCase().includes(q)) bestSub = Math.min(bestSub, 9);
      }
      if (bestSub < Infinity) return bestSub;
      if (c.usage.toLowerCase().includes(q)) return 10;
      if (c.description.toLowerCase().includes(q)) return 11;
      return Infinity;
    }
    const scored: Array<{ c: CommandDoc; score: number; idx: number }> = [];
    commands.forEach((c, idx) => {
      const score = scoreCommand(c);
      if (score < Infinity) scored.push({ c, score, idx });
    });
    // Stable sort by score asc, then original index asc so ties keep
    // catalog order (alphabetical, presumably) instead of shuffling.
    scored.sort((a, b) => a.score - b.score || a.idx - b.idx);
    return scored.map((s) => s.c);
  }, [commands, filter]);

  return (
    <Modal onClose={onClose} zIndex={50} variant="mobile-fullscreen">
      <div
        onClick={(e) => e.stopPropagation()}
        className={`${MODAL_CARD_CONTENT} keep-frame rounded bg-keep-bg`}
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
          <CloseButton onClick={onClose} />
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
  { syntax: "||spoiler||", example: "the killer is ||the butler||", note: "renders as a black box; click to reveal." },
  { syntax: "`code`", example: "press `Enter` to send" },
  { syntax: "```fenced```", example: "```\nmulti-line\ncode block\n```", note: "triple backticks on their own line(s) for a preformatted block. Content inside is literal, no further markdown / mention / inline-command interpretation." },
  { syntax: "[link text](https://url)", example: "[the Spire](https://thespire.example)", note: "http and https URLs only - `javascript:` schemes are dropped silently" },
  { syntax: "https://url", example: "see https://example.com for details", note: "bare URLs are auto-linked at word boundaries" },
  { syntax: "![alt](https://image-url)", example: "![cat](https://example.com/cat.png)", note: "renders as a link with a Show image toggle - opt-in so loading the image doesn't leak your IP to the host" },
  { syntax: "https://.../photo.png", example: "screenshot: https://example.com/screenshot.png", note: "image URLs ending in png/jpg/jpeg/gif/webp/svg/bmp/avif also get the Show image toggle" },
  { syntax: "https://youtu.be/...", example: "lookbook clip: https://youtu.be/dQw4w9WgXcQ", note: "YouTube and Vimeo links get a Show video toggle next to the link - click to play it inline. Works for youtube.com/watch, youtu.be, youtube.com/shorts, and vimeo.com URLs" },
  { syntax: "@username", example: "thanks @sigrid!", note: "click to open their profile; matches a master account or active character" },
  { syntax: "@world:slug", example: "anyone for a game in @world:ironreach?", note: "click to open the world viewer; slug is the world's URL slug (lowercase + hyphens)" },
  { syntax: `<font color="#hex">text</font>`, example: `<font color="#a83232">red text</font>`, note: "puts a one-off color on a chunk of text. Color must be a 3- or 6-digit hex literal; anything else falls through as plain text. The viewer's theme nudges the value toward legibility if it would disappear against their chat background." },
  { syntax: "\\* escape", example: "\\*boinks Kaal on the head\\*", note: "put a backslash before any of * _ ~ | ` [ ] ( ) ! < > @ \\ to keep it literal. Use `\\@name` to type an @username without pinging, or `\\!cmd` to write the command name without firing it." },
];

/**
 * Tag/feature highlights surfaced in the Profile / world HTML help
 * section. Profiles accept almost any HTML now (only a short blocked
 * list, see HTML_BLOCKED below), so this is a quick reference of the
 * tags writers reach for most often, not an allow-list.
 */
const HTML_COMMON_TAGS: Array<{ label: string; tags: string[]; note?: string }> = [
  {
    label: "Text",
    tags: ["b", "i", "u", "em", "strong", "s", "mark", "small", "sub", "sup", "span", "br"],
  },
  {
    label: "Layout",
    tags: ["p", "div", "section", "article", "header", "footer", "h3", "h4", "h5", "h6", "blockquote", "pre", "hr"],
  },
  {
    label: "Lists",
    tags: ["ul", "ol", "li", "dl", "dt", "dd"],
  },
  {
    label: "Tables",
    tags: ["table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td"],
  },
  {
    label: "Details / spoilers",
    tags: ["details", "summary"],
    note: "<details open> starts expanded.",
  },
  {
    label: "Links & images",
    tags: ["a", "img", "figure", "figcaption"],
    note: "Links open in a new tab. Image and link URLs must be http or https.",
  },
];

/** Short list of what's blocked so people don't waste time trying it. */
const HTML_BLOCKED = [
  "<script>",
  "<iframe> (except the <youtube> shortcut below)",
  "<form>, <input>, <button>",
  "<object>, <embed>",
  "Image URLs that aren't http/https",
];

/**
 * Theme color variables a writer can use in their custom CSS. Each name
 * resolves to the matching color from the *profile owner's* picked
 * theme, so a bio styled with these keeps working when the writer
 * switches palette. Mirrors `themeUserVars` in apps/web/src/lib/theme.ts.
 */
const THEME_VARS: Array<{ name: string; purpose: string }> = [
  { name: "--theme-bg",     purpose: "page background" },
  { name: "--theme-panel",  purpose: "card / surface color" },
  { name: "--theme-border", purpose: "border color" },
  { name: "--theme-text",   purpose: "main text color" },
  { name: "--theme-muted",  purpose: "secondary text color" },
  { name: "--theme-action", purpose: "link / button color" },
  { name: "--theme-accent", purpose: "highlight / accent color" },
  { name: "--theme-system", purpose: "system notice color" },
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
          Inline commands
        </h3>
        <p className="text-keep-muted">
          Some commands can be spliced mid-sentence with a leading{" "}
          <code className="font-mono text-keep-action">!</code> instead of being run as a standalone
          slash command. Type the command's name and the server replaces it with the rendered text in
          place, without breaking your sentence apart.
        </p>

        <div className="mt-2 overflow-hidden rounded border border-keep-border">
          <table className="w-full text-[12px]">
            <thead className="bg-keep-panel/50 text-[10px] uppercase tracking-widest text-keep-muted">
              <tr>
                <th className="w-1/2 px-2 py-1 text-left">You type</th>
                <th className="w-1/2 px-2 py-1 text-left">Roughly what it produces</th>
              </tr>
            </thead>
            <tbody>
              {/* Each row pairs the literal text a user would type
                  against the rendered output produced by running it
                  through the *real* markdown parser, including the
                  verification marker that the server adds in production.
                  That way the docs and the live renderer can't drift:
                  any visual change to <VerifiedInline /> shows up here
                  on the next render. */}
              <tr className="border-t border-keep-border align-top">
                <td className="px-2 py-1.5 font-mono text-keep-text">
                  she rolls a d20 !roll and waits
                </td>
                <td className="px-2 py-1.5 text-keep-text">
                  {parseInline(
                    `she rolls a d20 ${markVerified("roll", "( rolls 🎲 1d20: 17 )")} and waits`,
                  )}
                </td>
              </tr>
              <tr className="border-t border-keep-border align-top">
                <td className="px-2 py-1.5 font-mono text-keep-text">
                  she rolls !roll:3d6 for damage
                </td>
                <td className="px-2 py-1.5 text-keep-text">
                  {parseInline(
                    `she rolls ${markVerified("roll", "( rolls 🎲 3d6: [4, 2, 6] = 12 )")} for damage`,
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <p className="mt-2 text-keep-muted">
          The small <span className="text-keep-system">✓</span> next to a spliced result is the{" "}
          <b>verification mark</b>, hover it and you'll see which command produced the text.
          If you ever see output styled like a command but{" "}
          <em>without</em> the ✓, someone is typing the same characters by hand to fake a result;
          only output the server actually ran carries the mark.
        </p>

        <ul className="mt-2 list-disc space-y-1 pl-5 text-[11px] text-keep-muted">
          <li>
            <b>What's inline-callable</b> depends on the install. The composer's{" "}
            <code className="font-mono text-keep-action">!</code> palette lists every command an
            admin enabled inline; <code className="font-mono text-keep-action">/roll</code> is
            inline by default (use <code className="font-mono text-keep-action">!roll</code> or{" "}
            <code className="font-mono text-keep-action">!roll:3d6</code>).
          </li>
          <li>
            <b>Optional argument.</b> The bit after a colon, like{" "}
            <code className="font-mono text-keep-action">:3d6</code> on roll, is passed to the
            command. Most custom commands don't take args inline and quietly ignore them.
          </li>
          <li>
            <b>Want to type one literally?</b> Put a backslash in front:{" "}
            <code className="font-mono text-keep-action">{`\\!roll`}</code> stays as the literal
            text "<code className="font-mono text-keep-action">!roll</code>". Same for{" "}
            <code className="font-mono text-keep-action">{`\\@name`}</code> when you want to say a
            username without pinging it. Putting either inside <code className="font-mono text-keep-action">`code`</code>{" "}
            or a fenced block also keeps them literal.
          </li>
        </ul>
      </div>

      <div className="mt-5 border-t border-keep-rule/40 pt-3">
        <h3 className="mb-1 font-action text-sm uppercase tracking-widest text-keep-text">
          Profile / world HTML
        </h3>
        <p className="text-keep-muted">
          Profiles and world pages are like little webpages. You can use
          almost any HTML and CSS you like, including a{" "}
          <code className="font-mono text-keep-action">&lt;style&gt;</code>{" "}
          block at the top to theme the whole bio. Plain typing works
          too. Hitting Enter twice gives you a blank line between
          paragraphs.
        </p>
        <p className="mt-2 text-keep-muted">
          A few things stay blocked so nothing weird can run on other
          people's screens:
        </p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[11px] text-keep-muted">
          {HTML_BLOCKED.map((b) => (
            <li key={b}><code className="font-mono text-keep-text">{b}</code></li>
          ))}
        </ul>

        <h4 className="mt-3 font-action text-xs uppercase tracking-widest text-keep-muted">
          Common tags
        </h4>
        <div className="mt-1 overflow-hidden rounded border border-keep-border">
          <table className="w-full text-[12px]">
            <thead className="bg-keep-panel/50 text-[10px] uppercase tracking-widest text-keep-muted">
              <tr>
                <th className="w-1/4 px-2 py-1 text-left">Category</th>
                <th className="px-2 py-1 text-left">Tags</th>
              </tr>
            </thead>
            <tbody>
              {HTML_COMMON_TAGS.map((g) => (
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

        <h4 className="mt-3 font-action text-xs uppercase tracking-widest text-keep-muted">
          Custom CSS with &lt;style&gt;
        </h4>
        <p className="text-keep-muted">
          Drop a <code className="font-mono text-keep-action">&lt;style&gt;</code>{" "}
          block anywhere in the bio and write normal CSS. Your rules only
          apply inside your own profile. You can use any selector,
          @media queries, @keyframes animations, and so on. External
          stylesheets (@import) are not loaded.
        </p>

        <h4 className="mt-3 font-action text-xs uppercase tracking-widest text-keep-muted">
          Theme colors
        </h4>
        <p className="text-keep-muted">
          Match your bio to whichever theme you picked by using these
          color variables. They follow your theme automatically, so the
          bio still looks right if you change the palette later.
        </p>
        <div className="mt-1 overflow-hidden rounded border border-keep-border">
          <table className="w-full text-[12px]">
            <thead className="bg-keep-panel/50 text-[10px] uppercase tracking-widest text-keep-muted">
              <tr>
                <th className="w-1/3 px-2 py-1 text-left">Variable</th>
                <th className="px-2 py-1 text-left">What it is</th>
              </tr>
            </thead>
            <tbody>
              {THEME_VARS.map((v) => (
                <tr key={v.name} className="border-t border-keep-border align-top">
                  <td className="px-2 py-1 font-mono text-keep-action">{v.name}</td>
                  <td className="px-2 py-1 text-keep-text">{v.purpose}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-keep-muted">
          Use them straight as colors:{" "}
          <code className="font-mono text-keep-action">color: var(--theme-accent)</code>.
          For a faded version, every name above also has a{" "}
          <code className="font-mono text-keep-text">-rgb</code> companion
          you can drop into <code className="font-mono text-keep-action">rgb(...)</code>:{" "}
          <code className="font-mono text-keep-action">background: rgb(var(--theme-accent-rgb) / 0.25)</code>.
        </p>

        <h4 className="mt-3 font-action text-xs uppercase tracking-widest text-keep-muted">
          YouTube embeds
        </h4>
        <p className="text-keep-muted">
          Wrap a YouTube URL in{" "}
          <code className="font-mono text-keep-action">&lt;youtube&gt;...&lt;/youtube&gt;</code>{" "}
          and it turns into a player. Works for{" "}
          <code className="font-mono text-keep-text">youtube.com/watch</code>,{" "}
          <code className="font-mono text-keep-text">youtu.be</code>,{" "}
          <code className="font-mono text-keep-text">youtube.com/shorts</code>,
          and embed URLs. The player fills the column on phones and
          shrinks to half-width on desktop.
        </p>
        <pre className="mt-1 overflow-x-auto rounded border border-keep-rule/60 bg-keep-panel/30 p-2 font-mono text-[10px] leading-relaxed">{`<youtube>https://youtu.be/dQw4w9WgXcQ</youtube>`}</pre>

        <h4 className="mt-3 font-action text-xs uppercase tracking-widest text-keep-muted">
          Example bio snippet
        </h4>
        <pre className="overflow-x-auto rounded border border-keep-rule/60 bg-keep-panel/30 p-2 font-mono text-[10px] leading-relaxed">{`<style>
  .card {
    background: rgb(var(--theme-panel-rgb) / 0.6);
    border: 1px solid var(--theme-border);
    border-radius: 0.75rem;
    padding: 1rem;
    margin-bottom: 1rem;
  }
  .card h3 {
    color: var(--theme-accent);
    margin: 0 0 0.5rem 0;
  }
</style>

<div class="card">
  <h3>Character Name</h3>
  <p style="font-style:italic">"A short opening line."</p>
</div>

<div class="card">
  <h3>At a glance</h3>
  <table>
    <tr><th>Age</th><td>32</td></tr>
    <tr><th>Build</th><td>Tall, scarred</td></tr>
  </table>
</div>

<details>
  <summary>Content warnings</summary>
  <p>Grief, violence (no on-screen without buy-in).</p>
</details>

<youtube>https://youtu.be/dQw4w9WgXcQ</youtube>`}</pre>
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
          <li>
            <b>Videos stay opt-in too.</b> Paste a YouTube or Vimeo link and
            you'll see a "Show video" button. Click to play it inline; the
            video stays off the page until you do, so the link won't ping
            anyone's tracker just because someone scrolled past it.
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
