import type { ReactNode } from "react";

/**
 * Long-form, ELI5-style walkthroughs for the major site features. Lives
 * in the Help modal alongside the Commands and Formatting tabs - the Commands
 * tab is the precise reference; this is the "what does this thing even do"
 * counterpart.
 *
 * Each Guide is a collapsible section so users can scan the table of
 * contents up top and expand only what they need. Defaults: the first guide
 * is open; the rest are closed. Anchor ids on each guide match the TOC links
 * so clicking a TOC entry jumps and opens it.
 */
export function HelpGuides() {
  return (
    <div className="space-y-3 text-xs">
      <p className="text-keep-muted">
        Plain-language walkthroughs of the site's main features. The Commands tab is the precise
        reference for every slash command; this tab is the "why and when" behind them.
      </p>

      <nav className="rounded border border-keep-rule/60 bg-keep-panel/30 p-2 text-[11px]">
        <div className="mb-1 uppercase tracking-widest text-keep-muted">Jump to</div>
        <ul className="grid grid-cols-1 gap-x-3 gap-y-0.5 sm:grid-cols-2">
          {GUIDES.map((g) => (
            <li key={g.id}>
              <a href={`#guide-${g.id}`} className="text-keep-action hover:underline">
                {g.title}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {GUIDES.map((g, i) => (
        <details
          key={g.id}
          id={`guide-${g.id}`}
          open={i === 0}
          className="rounded border border-keep-rule/60 bg-keep-bg"
        >
          <summary className="cursor-pointer rounded bg-keep-banner/30 px-3 py-2 font-action text-sm hover:bg-keep-banner/50">
            {g.title}
          </summary>
          <div className="space-y-3 px-3 py-3 leading-relaxed text-keep-text">{g.body}</div>
        </details>
      ))}
    </div>
  );
}

/* ============================================================ *
 *  Re-usable building blocks
 * ============================================================ */

function P({ children }: { children: ReactNode }) {
  return <p>{children}</p>;
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="list-decimal space-y-1 pl-5">{children}</ol>;
}

function Bullets({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-1 pl-5">{children}</ul>;
}

function Tip({ children }: { children: ReactNode }) {
  return (
    <div className="rounded border border-keep-action/30 bg-keep-action/10 p-2 text-[11px] text-keep-text">
      <span className="mr-1 font-semibold uppercase tracking-widest text-keep-action">Tip</span>
      {children}
    </div>
  );
}

function K({ children }: { children: ReactNode }) {
  // "Keystroke" - used for slash commands and short code snippets so the
  // body copy stays readable while commands stand out.
  return <code className="rounded bg-keep-panel/60 px-1 font-mono text-[11px] text-keep-action">{children}</code>;
}

function Heading({ children }: { children: ReactNode }) {
  return <div className="mt-2 font-action text-[13px] uppercase tracking-widest text-keep-muted">{children}</div>;
}

/* ============================================================ *
 *  Guide content
 * ============================================================ */

const GUIDES: Array<{ id: string; title: string; body: ReactNode }> = [
  {
    id: "welcome",
    title: "Welcome to The Spire",
    body: (
      <>
        <P>
          The Spire is a free-form roleplay chat. You write characters, hang out in rooms, and tell
          stories together. There are no rolls or stats forced on anyone - the system stays out of
          the way and lets you write.
        </P>
        <Heading>Two layers of identity</Heading>
        <Bullets>
          <li>
            <b>Your master account</b> - the OOC person behind the keyboard. Has its own name,
            profile, theme, and color.
          </li>
          <li>
            <b>Your characters</b> - any number of personas you can step into. Each character has
            its own name, profile, gallery, and stats. While "active," your messages appear under
            that character's name with their styling.
          </li>
        </Bullets>
        <P>
          You can switch in and out of characters at any time. When no character is active, you're
          posting OOC under your master name.
        </P>
      </>
    ),
  },

  {
    id: "chat-basics",
    title: "Chat basics: clicking around the interface",
    body: (
      <>
        <P>
          Almost everything you can see in chat is clickable. Once you know which click does what,
          you rarely need to type slash commands at all.
        </P>

        <Heading>In the chat window</Heading>
        <Bullets>
          <li>
            <b>Click a sender's name</b> in a message to start a whisper to them. Your composer
            fills with <K>/whisper {`<name>`} </K> - finish typing and press Enter. To open
            their profile from chat, click their <K>@username</K> in any message, or click their
            name in the right rail (gender icon is rail-only; chat lines stay compact).
          </li>
          <li>
            <b>Click a message's timestamp</b> to reply to it. The composer fills with{" "}
            <K>/reply {`<id>`} </K> and your next message threads under that one. Only enabled on
            chat-style lines (regular messages, /me actions, OOC); system lines and announcements
            don't accept replies.
          </li>
          <li>
            <b>Click an @username</b> mention inside a message to open that person's profile. If
            they have an active character, it opens the character profile; otherwise the master
            account.
          </li>
          <li>
            <b>Click an @world:slug</b> chip to open the world viewer for that world. No
            membership change happens - it's pure linkage.
          </li>
        </Bullets>

        <Heading>In the right rail (rooms + userlist)</Heading>
        <Bullets>
          <li><b>Click a room name</b> to switch to that room. Private rooms prompt for a password.</li>
          <li>
            <b>Click an occupant's gender icon</b> (the small glyph beside their name in the
            rail) to open their profile. This is the only place the icon is clickable - chat lines
            hide it to keep the timeline tight.
          </li>
          <li><b>Click an occupant's name</b> in the rail to whisper them - same as clicking a name in chat.</li>
          <li>
            <b>Click a world section header</b> in the rail (when a room has occupants grouped
            by their primary world) to open that world's viewer.
          </li>
          <li>
            <b>"▲ Tools" button at the bottom of the rail</b> opens the Tools drawer with
            buttons for every common action - covered in its own guide below.
          </li>
        </Bullets>

        <Heading>The composer (where you type)</Heading>
        <Bullets>
          <li><b>Enter</b> sends your message. <b>Shift+Enter</b> inserts a newline for paragraph posts.</li>
          <li>
            Typing <K>/</K> at the start of a message opens an autocomplete popup of matching
            commands. <b>Up/Down</b> navigates, <b>Enter</b> or <b>Tab</b> accepts, <b>Esc</b>{" "}
            dismisses.
          </li>
          <li>
            Typing <K>@</K> anywhere opens an autocomplete popup of users currently in the room.
            Same controls.
          </li>
          <li>
            Anything not starting with <K>/</K> is a normal "say" message. Wrap a sentence in
            <K>/me {`<action>`}</K> to post a third-person action ("Sigrid draws her sword.").
          </li>
        </Bullets>

        <Heading>Editing &amp; deleting your own messages</Heading>
        <P>
          For one minute after sending, your own chat-style messages get small <b>edit</b> and{" "}
          <b>delete</b> controls in the line. Past that grace window, the controls vanish and the
          message is permanent (apart from janitor / per-room expiry sweeps).
        </P>
        <P>
          Deleted messages collapse to "[message removed]" - the original body is stripped on the
          server, so even your past view of the line clears the next time the page refreshes.
        </P>

        <Heading>Reading replies</Heading>
        <P>
          When someone replies to a message with <K>/reply</K> (or via timestamp click), the reply
          renders with a small quote line above it: <i>↪ Sigrid: ...the original snippet...</i>{" "}
          That snippet is the truncated parent body so you can see what's being responded to
          without scrolling up. Click the quoted name to open that author's profile.
        </P>

        <Heading>Tags and chips you'll see beside names</Heading>
        <Bullets>
          <li>
            <b>♛</b> (chess-queen glyph) = the <b>room owner</b>. Whoever ran <K>/private</K>{" "}
            or <K>/go</K> to first create the room. Per-room only - default system rooms
            (The_Spire, Tavern, etc.) have no owner so nobody gets one there.
          </li>
          <li>
            <b>★</b> (star) = a <b>mod</b>. Either a per-room mod (promoted by the owner via{" "}
            <K>/promote</K>) <i>or</i> a site-level mod (a mod for every room). Same star
            either way; a site mod is conceptually just "a mod everywhere."
          </li>
          <li>
            <b>Italic name</b> = a <b>site admin</b> (account-level). Visible everywhere - in the
            userlist, in chat lines, on profiles. Site admins have admin power in every room
            regardless of per-room role.
          </li>
          <li>
            <b>[away]</b> = the user has set <K>/away</K>. Hover their name to see their reason.
          </li>
          <li><b>Mood chip</b> ("brooding", "smug") = the user has set <K>/mood</K>.</li>
          <li><b>[ooc]</b> in the userlist = no active character; that's their master account.</li>
        </Bullets>
        <Tip>
          If you've created a room but you're currently in a system room (The_Spire, etc.), you
          won't see your own ♛ - that chip is per-room. Switch to a room you own and your name
          picks up the marker.
        </Tip>

        <Heading>Notifications</Heading>
        <P>
          When the tab is in the background, getting <K>@mentioned</K> or whispered triggers a
          desktop notification (if you've granted permission). Notification preference (off /
          mentions only / all messages) lives in your profile editor - open <K>/profile</K>{" "}
          and pick from the Notifications dropdown. Default is mentions-only.
        </P>
      </>
    ),
  },

  {
    id: "characters",
    title: "Characters: creating, switching, retiring",
    body: (
      <>
        <P>
          Characters are personas. Open a character and you become them in chat - same room, same
          conversation, different name.
        </P>
        <Heading>Make a new character</Heading>
        <Steps>
          <li>Open <K>/profile</K> (or use the <b>Tools</b> drawer at the bottom-right of the rail).</li>
          <li>In the editor, click <b>New character</b> and fill in name + bio.</li>
          <li>Save. The character now lives under your account.</li>
        </Steps>
        <Heading>Step into a character</Heading>
        <Steps>
          <li>Open the character's profile (click their name anywhere in chat).</li>
          <li>Use the <b>Switch to {`<name>`}</b> button - your master profile shows the same option for jumping back to OOC.</li>
        </Steps>
        <P>
          Or with commands: <K>/char list</K> to see your characters, <K>/char switch {`<name>`}</K> to step into one,
          <K>/char clear</K> to drop back to OOC.
        </P>
        <Tip>
          Your active character drives more than just the displayed name - their gender, theme, and
          chat color all override your master settings while they're active.
        </Tip>
      </>
    ),
  },

  {
    id: "profile-create",
    title: "Profile creation: bios, HTML, and examples",
    body: (
      <>
        <P>
          Every account (master + every character) gets a profile page that
          other users can open by clicking your name in chat. Your bio is the
          centerpiece. It accepts a generous subset of HTML so you can lay
          out a profile like a tiny webpage — colors, headings, tables for
          stats, collapsible spoilers, the works.
        </P>

        <Heading>Open the editor</Heading>
        <Steps>
          <li>Open <K>/profile</K> or pick <b>Edit Profile</b> from the Tools drawer.</li>
          <li>
            The editor opens to your master account. To edit a character, pick
            it from the dropdown at the top — there's also a <b>New character</b>{" "}
            button if you don't have one yet.
          </li>
          <li>
            Tabs along the top split the editor into focused panes:{" "}
            <b>Description</b> (bio HTML), <b>Profile</b> (name/avatar/gender/stats),{" "}
            <b>Appearance</b> (theme + fonts, master only), <b>Privacy</b>{" "}
            (visibility, NSFW gate, notifications, sound prefs), <b>Links</b>{" "}
            (chips that appear on your profile), <b>Gallery</b> (portraits,
            character only), and <b>Journal</b> (in-character entries, character only).
          </li>
        </Steps>

        <Heading>Bio HTML — what's allowed</Heading>
        <P>
          The bio field is HTML, not Markdown. The server runs your text
          through <K>sanitize-html</K> on save and re-sanitizes on read, so
          anything outside the allow-list is silently stripped. Event
          handlers (<K>onclick=</K>, <K>onload=</K>, etc.) and the{" "}
          <K>javascript:</K> + <K>data:</K> URL schemes are blocked.
        </P>
        <P>
          See the <b>Formatting</b> tab for the full categorized table of
          allowed tags, attributes, and CSS style properties. Quick summary:
        </P>
        <Bullets>
          <li>
            <b>Text:</b> <K>b</K>, <K>i</K>, <K>u</K>, <K>em</K>, <K>strong</K>,{" "}
            <K>s</K>, <K>mark</K>, <K>small</K>, <K>sub</K>, <K>sup</K>,{" "}
            <K>code</K>, <K>kbd</K>, <K>abbr</K>, <K>cite</K>, <K>q</K>.
          </li>
          <li>
            <b>Structure:</b> <K>p</K>, <K>div</K>, <K>span</K>, <K>br</K>,{" "}
            <K>blockquote</K>, <K>pre</K>, <K>hr</K>, <K>h3</K>–<K>h6</K>{" "}
            (h1/h2 are reserved for the site chrome).
          </li>
          <li>
            <b>Lists:</b> <K>ul</K>, <K>ol</K>, <K>li</K>, <K>dl</K>,{" "}
            <K>dt</K>, <K>dd</K>.
          </li>
          <li>
            <b>Tables:</b> <K>table</K>, <K>thead</K>, <K>tbody</K>, <K>tr</K>,{" "}
            <K>th</K>, <K>td</K>, <K>caption</K> — useful for stat blocks.
          </li>
          <li>
            <b>Spoilers / NSFW gates:</b> <K>{`<details>`}</K> +{" "}
            <K>{`<summary>`}</K> for collapsible sections.
          </li>
          <li>
            <b>Links + images:</b> <K>a href</K> (http/https/mailto only),{" "}
            <K>img src</K> (http/https only).
          </li>
          <li>
            <b>Inline CSS</b> on any element via <K>style="…"</K>: colors
            (hex/rgb), <K>font-weight</K>, <K>font-style</K>,{" "}
            <K>font-family</K>, <K>font-size</K> (1–72px, 0.5–4em, 50–400%),{" "}
            <K>line-height</K>, <K>text-decoration</K>, <K>text-align</K>,{" "}
            <K>list-style-type</K>, <K>vertical-align</K>. Anything else is
            dropped silently.
          </li>
        </Bullets>

        <Heading>Example: a clean RP bio</Heading>
        <pre className="overflow-x-auto rounded border border-keep-rule/60 bg-keep-panel/30 p-2 font-mono text-[10px] leading-relaxed">{`<h3 style="color:#a83232">Sigrid the Quiet</h3>
<p>A retired blade-singer who runs a quiet inn at the foot of
the mountains. Speaks little. Watches everything.</p>

<h4>At a glance</h4>
<table>
  <tr><th>Age</th><td>Late forties (Hollow elf)</td></tr>
  <tr><th>Build</th><td>Lean, scarred forearms</td></tr>
  <tr><th>Voice</th><td>Low, weighed; rarely raised</td></tr>
</table>

<h4>Looking for</h4>
<ul>
  <li>Slow-burn dialogue with travelers in the common room.</li>
  <li>Old comrades dropping in (DM first; lore is touchy).</li>
</ul>

<details>
  <summary>Content warnings (click to expand)</summary>
  <p>Touches on grief, old violence, occasional combat injury.
  Nothing on-screen without buy-in.</p>
</details>`}</pre>

        <Heading>Example: a styled flourish</Heading>
        <pre className="overflow-x-auto rounded border border-keep-rule/60 bg-keep-panel/30 p-2 font-mono text-[10px] leading-relaxed">{`<p style="text-align:center; font-family:Georgia, serif;
font-size:1.4em; color:#5a3a1a">
  <em>"The road remembers what we leave on it."</em>
</p>
<hr />
<blockquote style="border-left:3px solid #8a6a3a; padding-left:0.6em">
  Origin: <a href="https://example.com/lore">Ironreach campaign notes</a>.
</blockquote>`}</pre>

        <Tip>
          Save often — the bio editor doesn't autosave, and switching
          characters mid-edit will drop unsaved changes. The character/world
          limit shown under the textarea reflects the server-side cap
          (default 50,000 chars; admin-tunable).
        </Tip>

        <Heading>Non-bio fields</Heading>
        <Bullets>
          <li>
            <b>Avatar URL</b> — any HTTP/HTTPS URL pointing at an image. The
            server doesn't proxy it, so the host can see clicks; pick one
            you trust to stay up.
          </li>
          <li>
            <b>Gender</b> (master + character independently) — drives the
            small icon next to your name in the userlist.
          </li>
          <li>
            <b>Theme + style</b> (master only) — palette + style axis
            (medieval / modern / scifi). A character can override the
            palette in their own theme tab.
          </li>
          <li>
            <b>Stats</b> (character only) — short labelled fields (age,
            race, etc.) that show up as a small card above the bio.
          </li>
          <li>
            <b>Visibility</b> — public, or "logged-in only." Marking
            <b>NSFW</b> forces logged-in-only and gates the profile behind
            a content warning splash that the owner + admins skip.
          </li>
          <li>
            <b>Links</b> — chips at the top of the profile (Discord, Twitter,
            blog, etc.). Show or hide each independently.
          </li>
          <li>
            <b>Gallery + Journal</b> (character only) — extra portraits and
            in-character log entries. Both have their own tab in the editor.
          </li>
        </Bullets>
      </>
    ),
  },

  {
    id: "bonds",
    title: "Bonds (mutual titles): marriage, mates, family, friends",
    body: (
      <>
        <P>
          A <b>bond</b> is a relationship label that connects two profiles - things like "Married
          to", "Mate of", "Family", "Friend of". Bonds appear under the <b>Bonds</b> section on
          both profiles. They're <i>mutual</i> - both parties have to agree before the bond
          appears.
        </P>
        <Heading>Why bother?</Heading>
        <Bullets>
          <li>Lets visitors to a profile see at a glance who someone is connected to in-fiction.</li>
          <li>Each bond links to the other profile - one click and you're reading their story.</li>
          <li>Mutual-only means nobody can claim a relationship that the other half hasn't agreed to.</li>
        </Bullets>
        <Heading>Propose a bond</Heading>
        <Steps>
          <li>Decide which kind of bond fits: <K>marriage</K>, <K>mate</K>, <K>family</K>, <K>friend</K>, etc.</li>
          <li>
            Run <K>/request {`<kind>`} {`<name>`}</K> - for example <K>/request marriage @Sigrid</K>.
            The other side sees a prompt to accept or decline.
          </li>
          <li>
            When they accept, the bond appears on both profiles. If they decline, nothing shows up
            and you can try a different kind or chat about it first.
          </li>
        </Steps>
        <Heading>End a bond</Heading>
        <P>
          Either party can dissolve a bond at any time with <K>/dissolve {`<kind>`} {`<name>`}</K>{" "}
          or <K>/dissolve {`<name>`}</K> to clear all your bonds with that person. The other side
          isn't asked - dissolving is unilateral, just like real life.
        </P>
        <Heading>Character vs master bonds</Heading>
        <P>
          Bonds attach to whichever profile is <b>active</b> when you propose. So a character's
          marriage bond with another character lives on the character profiles, not on the master
          accounts behind them. To bond OOC, drop your character first (<K>/char clear</K>) and
          then propose.
        </P>
      </>
    ),
  },

  {
    id: "messages",
    title: "Direct messages & friends",
    body: (
      <>
        <P>
          Direct messages are 1:1 conversations that live <i>outside</i> the
          rooms. They follow you across rooms, persist when you're offline,
          and let two people talk privately without needing to share a room.
        </P>

        <Heading>Open the Messages modal</Heading>
        <Steps>
          <li>
            From the <b>Tools</b> drawer, pick <b>Messages</b> (or click the
            ▲ Tools button — an unread-count badge on that button hints at
            new DMs without opening the drawer).
          </li>
          <li>
            From any profile, click <b>💬 Message</b> in the header. The
            modal opens straight to that conversation.
          </li>
        </Steps>
        <P>
          The modal has two panes. Left: your friends, pending requests, and
          recent non-friend conversations. Right: the active thread. Drag the
          divider between the panes to resize (double-click to reset).
          On mobile it slides between the two — a back chevron returns to
          the list.
        </P>

        <Heading>Friends</Heading>
        <P>
          Friendship is mutual and explicit. To add a friend, type the
          username in <b>add friend by username…</b> in the modal, or run{" "}
          <K>/friend {`<name>`}</K>. The other side sees a pending request
          they can accept or decline. While pending, you can already DM
          them — friendship is the persistent-list affordance, not the
          permission gate.
        </P>
        <Bullets>
          <li><K>/friends</K> — list your accepted friends.</li>
          <li><K>/accept {`<name>`}</K> — accept a pending request.</li>
          <li><K>/decline {`<name>`}</K> — decline (silent on their side).</li>
          <li><K>/unfriend {`<name>`}</K> — end a friendship.</li>
        </Bullets>
        <P>
          When a friend comes online, you get a small "X is online" line in
          your current room. Per-tab quiet: only the active tab shows it.
        </P>

        <Heading>Messaging non-friends</Heading>
        <P>
          You don't need to be friends to DM. Type a username in{" "}
          <b>message non-friend…</b> in the modal, or click <b>💬 Message</b>{" "}
          on their profile. The conversation appears under <b>Recent</b>{" "}
          until someone friends the other side.
        </P>

        <Heading>Opting out</Heading>
        <P>
          Profile editor → <b>Privacy</b> → <b>DMs enabled</b>. Toggle off to
          refuse all DMs; attempts to message you return a friendly "this
          user has DMs turned off" error instead of going through.
        </P>

        <Heading>Sound + notifications</Heading>
        <P>
          Incoming DMs play the <b>ping</b> sound when this tab is open
          (toggle in <b>Privacy → Sound effects</b>). If you've opted into
          web push, you'll also get an OS-level notification when this tab
          is closed or backgrounded — the body just says "You have a new
          direct message" without quoting any content, so a glance at the
          lock screen never leaks a thread.
        </P>

        <Heading>Editing, deleting, reporting</Heading>
        <Bullets>
          <li>
            Your own messages get tiny edit/delete buttons for one minute
            after sending — same grace window as room chat.
          </li>
          <li>
            Right-click (or long-press) someone else's DM to <b>Report</b>{" "}
            it. The full conversation snapshot lands in the admin queue;
            the body is preserved server-side even if the sender later
            deletes the message.
          </li>
        </Bullets>

        <Tip>
          DM history is yours alone. The other side can independently delete
          their copy of a message (within the grace window), but you keep
          your view of what they sent. Admin moderation can read both sides
          via the report path.
        </Tip>
      </>
    ),
  },

  {
    id: "worlds-create",
    title: "Worlds: creating one (your own wiki)",
    body: (
      <>
        <P>
          A <b>world</b> is a private wiki for your setting - lore, factions, places, NPCs. Each
          world has a tree of <b>pages</b> nested up to 10 levels deep. You own and edit every
          world you create; nobody else can edit your pages.
        </P>
        <Heading>Three visibility tiers</Heading>
        <Bullets>
          <li>
            <b>Private</b> - only you can see it. Good for drafting or for personal notes you don't
            want shared.
          </li>
          <li>
            <b>Public</b> - anyone with the URL or a link from a room can read it. Won't appear in
            the catalog. Good for "share with my group" worlds.
          </li>
          <li>
            <b>Open</b> - public + listed in the World Catalog + others can join your world and
            link it to their own rooms. Use this for community settings you want others to play in.
          </li>
        </Bullets>
        <Heading>Make your first world</Heading>
        <Steps>
          <li>Open the <b>Tools</b> drawer (bottom-right of the rail) and pick <b>My Worlds</b>.</li>
          <li>Click <b>+ New world</b>. Fill in the name and (optionally) a slug for the URL.</li>
          <li>Pick a starting visibility - you can change it any time from the editor.</li>
          <li>Save. You're dropped straight into the editor.</li>
        </Steps>
        <Heading>Add pages</Heading>
        <Steps>
          <li>In the editor's left sidebar, hit <b>+ Page</b> for a top-level page, or hover an existing page and click <b>+</b> to add a child.</li>
          <li>Give the page a title. The slug auto-derives from the title; override it if you want a tidier URL.</li>
          <li>
            Write the body in HTML (the same allow-list as your bio: <K>b</K>, <K>i</K>, <K>p</K>,{" "}
            <K>ul</K>, <K>ol</K>, <K>blockquote</K>, <K>h3</K>-<K>h6</K>, etc.). Save when ready.
          </li>
          <li>Re-arrange via the <b>Sort order</b> field, or move a page under a different parent with the <b>Parent page</b> dropdown.</li>
        </Steps>
        <Heading>World theme</Heading>
        <P>
          In the world editor, the <b>Theme</b> section lets you pick a custom color palette for
          your world's modal. Useful for setting the mood of a dark-fantasy world vs a bright
          slice-of-life one. The theme applies <b>only</b> when someone opens your world - it never
          bleeds into chat or the userlist.
        </P>
        <Tip>
          Worlds are fully owned by you. Deleting one cascades through every page and removes any
          room links. There's no undo, just a confirmation dialog - so think twice on private
          worlds you've built up over months.
        </Tip>
      </>
    ),
  },

  {
    id: "worlds-join",
    title: "Worlds: joining one (declare your affiliation)",
    body: (
      <>
        <P>
          You can <b>join</b> any <b>open</b> world to declare that your character is from there.
          Joining is purely an affiliation - it doesn't change which rooms you can enter or what
          you can do. You can join as many worlds as you like.
        </P>
        <Heading>What joining gets you</Heading>
        <Bullets>
          <li>The world appears under <b>Worlds</b> on your profile, so visitors can see your affiliations.</li>
          <li>You can mark <b>one</b> world as your <b>primary</b> - that's the one used to group you with other members in chat userlists.</li>
          <li>The world's owner sees you in their member list (a small "by us" signal that their setting has reach).</li>
        </Bullets>
        <Heading>Three ways to join</Heading>
        <Steps>
          <li>
            <b>From the catalog</b>: Tools drawer &rarr; <b>World Catalog</b>, then click <b>Join</b> on a row.
          </li>
          <li>
            <b>From the world viewer</b>: open any open world, click the <b>Join</b> chip in the header.
          </li>
          <li>
            <b>By command</b>: <K>/world join {`<slug>`}</K>, or just <K>/world join</K> to join the
            world that's currently linked to the room you're in.
          </li>
        </Steps>
        <Heading>Set a primary world</Heading>
        <P>
          Joining is silent until you mark a world as primary. To do that:
        </P>
        <Bullets>
          <li><b>From My Worlds</b>: in the "Worlds I've joined" section, click <b>Set as primary</b> next to the world.</li>
          <li><b>From the world viewer</b>: <b>Set as primary</b> chip in the header.</li>
          <li><b>By command</b>: <K>/world primary {`<slug>`}</K>. Run <K>/world primary</K> with no slug to clear it.</li>
        </Bullets>
        <P>
          Only one world can be primary at a time - setting a new one automatically demotes the
          previous. Userlists in chat re-sort the moment you change it.
        </P>
        <Heading>Leaving a world</Heading>
        <P>
          Click <b>Leave</b> in the viewer, or use <K>/world leave {`<slug>`}</K>. Your membership
          goes away; you can re-join any time.
        </P>
        <Tip>
          Joining and primary are independent of room access. You can sit in a world's room
          without ever joining the world - and you can join a world without ever visiting one of
          its rooms. They serve different purposes.
        </Tip>
      </>
    ),
  },

  {
    id: "worlds-attach",
    title: "Worlds: attaching one to a room",
    body: (
      <>
        <P>
          A room can have <b>one</b> world attached to it. When attached, a small banner appears
          above the chat showing the world name; clicking it opens the wiki. New visitors get
          context for the setting without anyone having to explain.
        </P>
        <Heading>Who can attach?</Heading>
        <P>
          Only the room's <b>owner</b> or a <b>mod</b> (or a site admin) can link or unlink a
          world. This stops drive-by attachments by visitors.
        </P>
        <Heading>Attach a world you own</Heading>
        <Steps>
          <li>
            Stand in the room you want to attach to (you have to be in the room to issue the
            command).
          </li>
          <li>
            Run <K>/world link {`<slug>`}</K> with the slug of one of your own worlds (e.g.{" "}
            <K>/world link darkrealm</K>).
          </li>
          <li>The banner appears immediately for everyone in the room.</li>
        </Steps>
        <Heading>Attach someone else's world</Heading>
        <P>
          You can only do this when their world is <b>open</b>. The slash command intentionally
          rejects cross-author linking - you go through the catalog UI instead, which is the
          gating point:
        </P>
        <Steps>
          <li>Open <b>Tools</b> drawer &rarr; <b>World Catalog</b>.</li>
          <li>
            Find the world. The row has a <b>Use in this room</b> button if you're in a room you
            can mod.
          </li>
          <li>Click it. The banner appears in the room.</li>
        </Steps>
        <Heading>Detach</Heading>
        <P>
          <K>/world unlink</K> removes the current attachment (owner/mod/admin only). Replacing one
          world with another is a single step - <K>/world link {`<other-slug>`}</K> overwrites
          whatever was there.
        </P>
        <Heading>What attachment doesn't do</Heading>
        <Bullets>
          <li>It doesn't auto-join visitors to the world. They have to opt in themselves.</li>
          <li>It doesn't restrict who can talk in the room. Room access is set independently (public/private).</li>
          <li>It doesn't share editing rights. Only the world's owner can edit pages.</li>
        </Bullets>
        <Heading>Mention a world inline with @world:slug</Heading>
        <P>
          You can drop a clickable world chip into any chat message by typing{" "}
          <K>@world:{`<slug>`}</K> - for example <K>@world:ironreach</K>. It renders as a
          highlighted pill; clicking it opens the world viewer for everyone who clicks it.
          Useful for "looking for RP in @world:ironreach tonight" without having to attach the
          world to the room.
        </P>
        <Tip>
          Mentioning a world doesn't notify anyone (unlike <K>@username</K>) and doesn't change
          your or the room's affiliation. It's pure linkage.
        </Tip>
      </>
    ),
  },

  {
    id: "rooms",
    title: "Rooms: finding, joining, and hosting",
    body: (
      <>
        <P>
          Rooms are where conversations happen. Each room has its own occupants, topic,
          description, and (optionally) attached world.
        </P>
        <Heading>Find a room</Heading>
        <Bullets>
          <li><b>Sidebar</b> - the rail on the right lists every public room and its occupant count. Click any room to enter.</li>
          <li><b><K>/list</K></b> prints all rooms in chat (handy if you want a paste-able list).</li>
          <li><b><K>/find {`<name>`}</K></b> searches by name fragment. Useful when you remember a chunk of the name but not all of it.</li>
        </Bullets>
        <Heading>Switch rooms</Heading>
        <P>
          Click a room name in the sidebar, or run <K>/go {`<name>`}</K>. Joining a private room
          asks for a password (or accepts an invite if someone gave you one).
        </P>
        <Heading>Make your own room</Heading>
        <Steps>
          <li>
            Run <K>/private {`<name>`} {`<password>`}</K>. You're its owner the moment it exists.
          </li>
          <li>
            Set a <b>topic</b> with <K>/topic ...</K> (the short headline above chat) and a{" "}
            <b>description</b> with <K>/describe ...</K> (the longer prose new visitors see on
            join).
          </li>
          <li>
            Invite specific users with <K>/invite {`<username>`}</K> - they skip the password
            prompt.
          </li>
          <li>
            Optionally attach a world: <K>/world link {`<slug>`}</K>.
          </li>
        </Steps>
        <Heading>Mod tools (owner / mod / admin only)</Heading>
        <P>
          Common ones: <K>/kick</K>, <K>/mute</K>, <K>/ban</K> (with optional duration), <K>/promote</K>{" "}
          to make a member a mod, <K>/demote</K> to take it back. Full reference in the Commands
          tab.
        </P>
        <Heading>Per-room rendering modes</Heading>
        <P>
          Two room-level toggles tune how the chat behaves in this specific room. Both default to
          off / flat. Owner/mod only.
        </P>
        <Bullets>
          <li>
            <K>/expiry {`<minutes>`}</K> - messages older than N minutes auto-delete the next time
            the janitor runs. <K>/expiry off</K> clears it. Useful for "Looking for RP" rooms
            where stale postings should clear themselves.
          </li>
          <li>
            <K>/replymode nested</K> - replies group under their parent in a thread container,
            with the latest 5 visible and a "View More" toggle for the rest. <K>/replymode flat</K>
            {" "}reverts to the default chronological timeline. Pairs naturally with{" "}
            <K>/expiry</K> for bulletin-style rooms.
          </li>
        </Bullets>
        <Tip>
          The rail's per-world groupings (when occupants share a primary world) make crowded rooms
          easier to skim - clusters of "members of {`<World>`}" stand out from the unaffiliated
          regulars.
        </Tip>
      </>
    ),
  },

  {
    id: "tools",
    title: "The Tools drawer (bottom-right of the rail)",
    body: (
      <>
        <P>
          Every common action has a button - you don't have to memorize commands. Tap the{" "}
          <b>Tools</b> button at the bottom of the rail to slide up the drawer. Backdrop tap or{" "}
          <K>Esc</K> closes it.
        </P>
        <Heading>What lives in there</Heading>
        <Bullets>
          <li><b>Worldbuilding</b> - My Worlds, World Catalog.</li>
          <li><b>Roleplay</b> - Set Mood, Set Scene, NPC mode toggle.</li>
          <li><b>Rooms</b> - Find Rooms, List Rooms, New Private Room.</li>
          <li><b>People</b> - Messages (DMs + friends + friend requests in one modal), All Users, Ignore List. A small unread-count badge appears on the trigger and on the Messages row when someone DMs you.</li>
          <li><b>Display</b> - Chat color, Font size, Refresh interval.</li>
          <li><b>Account</b> - Edit Profile, Bookmarks, Toggle Away, Help.</li>
        </Bullets>
        <P>
          Anything you can do from the drawer, you can also do via slash command - the drawer just
          saves you typing.
        </P>
      </>
    ),
  },

  {
    id: "customization",
    title: "Customization: themes, color, mood, away",
    body: (
      <>
        <P>
          A few small things make chat feel like yours. None are required to participate.
        </P>
        <Heading>Theme</Heading>
        <P>
          Open the theme picker from the banner (top of the page) to change the colors of the
          whole site for you. Doesn't affect anyone else's view.
        </P>
        <Heading>Chat color</Heading>
        <P>
          <K>/color {`<hex>`}</K> sets the color of <i>your</i> chat name and actions. <K>/color clear</K>{" "}
          drops back to the default. Active characters can have their own color, separate from your
          master color.
        </P>
        <Heading>Mood</Heading>
        <P>
          <K>/mood {`<text>`}</K> shows a small tag next to your name - "brooding", "exhausted",
          "smug". <K>/mood clear</K> removes it. Great for telegraphing emotional state without
          spelling it out in dialogue.
        </P>
        <Heading>Away</Heading>
        <P>
          <K>/away [reason]</K> marks you as away (a small "[away]" tag appears with you).{" "}
          <K>/away</K> with no reason while already away clears it.
        </P>
        <Heading>Scene (room-level)</Heading>
        <P>
          Owners and mods can set a <b>scene</b> with <K>/scene {`<title>`}</K> - a short banner
          shown alongside the topic, useful for "we're in the tavern now" framing. <K>/scene end</K>{" "}
          clears it.
        </P>
      </>
    ),
  },
];
