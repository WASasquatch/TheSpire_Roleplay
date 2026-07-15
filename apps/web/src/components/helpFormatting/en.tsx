/**
 * Canonical ENGLISH content for the Help modal's Formatting tab.
 *
 * Localization (docs/I18N_PLAN.md §6): like the Guides tab, this content is
 * long-form, syntax-heavy JSX, so translations live as drop-in locale modules
 * (./locales/<lng>.tsx exporting a `FormattingHelp` component), NOT in the
 * JSON catalogs. This module is statically bundled and is the fallback when
 * no locale module covers the active language — see ../FormattingHelp.tsx.
 */
import { markVerified } from "@thekeep/shared";
import { parseInline } from "../../lib/markdown.js";

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
  { syntax: `<font size="1-4">text</font>`, example: `<font size="4">huge text</font>`, note: "sizes a chunk of text in four steps: 1 small, 2 normal, 3 large, 4 huge. Numbers outside 1-4 snap to the nearest step, and you can combine color and size on one tag. The toolbar's size menu writes this for you." },
  { syntax: "\\* escape", example: "\\*boinks Kaal on the head\\*", note: "put a backslash before any of * _ ~ | ` [ ] ( ) ! < > @ \\ to keep it literal. Use `\\@name` to type an @username without pinging, or `\\!cmd` to write the command name without firing it." },
];

/**
 * Conditional / check posts. Unlike FORMATTING_ROWS, these are block-level
 * or custom-command constructs, so there's no faithful `parseInline`
 * preview to show; we describe what each one does and give a copy-able
 * example instead. The Dice, checks, and pass/fail prompts guide on the
 * Guides tab walks through them in full.
 */
const CHECK_ROWS: Array<{ syntax: string; meaning: string; example: string }> = [
  {
    syntax: "<check> <pass>…</pass> <fail>…</fail> </check>",
    meaning:
      "A 50/50 pass or fail prompt. Write both outcomes; the room sees a card with the winning one and the other tucked away. Needs at least a pass or fail line.",
    example: "<check><pass>The lock clicks open.</pass><fail>The pick snaps off.</fail></check>",
  },
  {
    syntax: "<roll:NdM:DC> <pass>…</pass> <fail>…</fail> </roll>",
    meaning:
      "Like a check, but a dice roll decides it. The roll must meet or beat the target (DC) to pass. Add one bonus with +X, -X, or an x multiplier.",
    example:
      "<roll:1d20+3:12><pass>The ropes slice clean.</pass><fail>The rope barely takes a mark.</fail></roll>",
  },
  {
    syntax: "!name  (or !name:extra)",
    meaning:
      "Drop a custom command into the middle of a sentence. Its text lands right there, marked with a ✓. Put a backslash in front (\\!name) to show it as plain text.",
    example: "she waves at the newcomer !greet and smiles",
  },
  {
    syntax: "{arg:1}  {arg:2}  …",
    meaning:
      "Inside a custom command: the words the caller typed after the command, one at a time. {arg:1} is the first, {arg:2} the second, and so on. A missing one comes out blank. {target} is the same as {arg:1}.",
    example: "swings at {arg:1} for {arg:2} damage",
  },
  {
    syntax: "{rng:A:B}",
    meaning:
      "Inside a custom command: a random whole number from A to B (both ends possible). A and B can be plain numbers or other pieces like {arg:2}.",
    example: "today's luck: {rng:1:100}",
  },
  {
    syntax: "{if:condition|then|else}",
    meaning:
      'Inside a custom command: show the "then" text when the condition holds, or the "else" text when it doesn\'t. A condition with something in it counts as true; it can also compare with > < >= <= == or != . The else part is optional.',
    example: "{if:{arg:1}>15|a mighty blow|a glancing hit}",
  },
  {
    syntax: "{choose:a|b|c}",
    meaning:
      "Inside a custom command: pick one of the options at random. The short form {a|b|c} does the same thing.",
    example: "{choose:warmly|tightly|gently}",
  },
  {
    syntax: "{roll:NdM}",
    meaning:
      "Inside a custom command: drop in a random dice total (just the number). Plain dice only, no plus or minus bonus.",
    example: "You rolled a {roll:1d20}!",
  },
  {
    syntax: '<loop:N>…</loop>  (or <loop:N sep=", ">…</loop>)',
    meaning:
      'Inside a custom command: repeat the part between the tags N times, with a space between each. N can be a number or a piece like {arg:1}, and anything random inside re-rolls each time. {loop} counts the passes. Add sep="" for no gap, or sep=", " for commas.',
    example: "{sender} rolls {arg:1} d{arg:2}: <loop:{arg:1}>{rng:1:{arg:2}}</loop>",
  },
  {
    syntax: "{=math}",
    meaning:
      "Inside a custom command: quick math with + - * / and parentheses. You can nest other pieces inside it.",
    example: "{=10+{roll:1d20}}",
  },
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

export function FormattingHelp() {
  return (
    <div className="space-y-3 text-xs">
      <p className="text-keep-muted">
        Chat messages support the formatting shortcuts below, and the
        toolbar above the message box covers most of them with a click.
        Pasting from Gmail, Docs, or Word keeps its formatting too.
        Tables stay off in chat. Profile and world pages can use more
        (see the Profile / world HTML section below).
      </p>
      <p className="text-keep-muted">
        A few toolbar tools have no typed shortcut. The{" "}
        <b>Heading</b> dropdown turns the current line into a big
        Heading 1, 2, or 3 (typing <code className="font-mono text-keep-action">#</code>,{" "}
        <code className="font-mono text-keep-action">##</code>, or{" "}
        <code className="font-mono text-keep-action">###</code> plus a
        space at the start of a line does the same). The three{" "}
        <b>alignment</b> buttons push a line to the left, center, or
        right. The <b>quote</b> and <b>list</b> buttons turn lines into
        a quote block or a bulleted list (typing{" "}
        <code className="font-mono text-keep-action">&gt;</code> or{" "}
        <code className="font-mono text-keep-action">-</code> plus a
        space at the start of a line works too). Headings and alignment
        are for chat rooms only, so those controls stay hidden in
        forums.
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
          Conditional &amp; check posts
        </h3>
        <p className="text-keep-muted">
          Let the dice (or a coin flip) decide an outcome, or add a dash of chance to your own custom
          commands. Write these as their own block or inside a custom command's text. The{" "}
          <b>Dice, checks, and pass/fail prompts</b> guide on the Guides tab walks through every one
          with examples.
        </p>

        <div className="mt-2 overflow-hidden rounded border border-keep-border">
          <table className="w-full text-[12px]">
            <thead className="bg-keep-panel/50 text-[10px] uppercase tracking-widest text-keep-muted">
              <tr>
                <th className="w-1/3 px-2 py-1 text-left">You write</th>
                <th className="px-2 py-1 text-left">What it does</th>
              </tr>
            </thead>
            <tbody>
              {CHECK_ROWS.map((r) => (
                <tr key={r.syntax} className="border-t border-keep-border align-top">
                  <td className="px-2 py-1.5 align-top">
                    <code className="block whitespace-pre-wrap break-words font-mono text-[11px] text-keep-action">
                      {r.syntax}
                    </code>
                  </td>
                  <td className="px-2 py-1.5 align-top">
                    <div className="text-keep-muted">{r.meaning}</div>
                    <div className="mt-1 text-[10px] text-keep-muted">
                      Example:{" "}
                      <code className="whitespace-pre-wrap break-words font-mono text-keep-text">
                        {r.example}
                      </code>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
            their lines. In chat, lines starting with <code>&gt; </code> or{" "}
            <code>- </code> group into quote blocks and bullet lists; action
            lines like /me keep them literal.
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
