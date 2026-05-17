import type { ReactNode } from "react";

/**
 * TOC click handler. The Help modal scrolls within its own
 * `overflow-y-auto` pane (not the window), so a bare `<a href="#...">`
 * jump only moves the document scroll position and the modal stays put.
 * We also need to force-open the target `<details>` because everything
 * past the first guide ships collapsed — landing on a closed disclosure
 * with no visible content reads as "the link is broken."
 *
 * scrollIntoView walks up to the nearest scrollable ancestor (the
 * modal's overflow pane), so the same call works regardless of where
 * the parent puts us.
 */
function jumpToGuide(id: string) {
  const el = document.getElementById(`guide-${id}`);
  if (!el) return;
  if (el instanceof HTMLDetailsElement) el.open = true;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

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
              <button
                type="button"
                onClick={() => jumpToGuide(g.id)}
                className="text-left text-keep-action hover:underline"
              >
                {g.title}
              </button>
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
            Typing <K>!</K> mid-message opens an autocomplete popup of <b>inline commands</b> —
            these splice their result into the sentence instead of running as a standalone command.
            <K>!roll</K> drops in a dice roll, <K>!roll:3d6</K> with a custom dice spec, and admins
            can mark their own custom commands as inline. Real expansions show a small ✓ that names
            the underlying command on hover, so a typed-by-hand fake doesn't pass for the real
            output. Type <K>{`\\!roll`}</K> (with a leading backslash) to keep the literal text.
          </li>
          <li>
            Anything not starting with <K>/</K> is a normal "say" message. Wrap a sentence in
            <K>/me {`<action>`}</K> to post a third-person action ("Sigrid draws her sword.").
          </li>
          <li>
            Quick action shortcut: start a line with <K>:</K> and the rest
            becomes an action. <K>:walks in casually</K> is the same as
            <K>/me walks in casually</K>. If you actually want to start a
            message with a colon, type two: <K>::like this</K>.
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
    title: "Building a profile",
    body: (
      <>
        <P>
          You and every character you make get a profile page. Other users
          see it by clicking your name. The bio is the big text area where
          you describe yourself or your character.
        </P>

        <Heading>Open your editor</Heading>
        <Steps>
          <li>Type <K>/profile</K> in chat, or open the Tools drawer and pick <b>Edit Profile</b>.</li>
          <li>You start on your master (OOC) account. Use the dropdown at the top to switch to one of your characters, or to make a new one.</li>
        </Steps>

        <Heading>What the tabs do</Heading>
        <Bullets>
          <li><b>Description</b> - the bio. The main thing visitors read.</li>
          <li><b>Profile</b> - your name, picture (avatar), gender, and character stats like age and race.</li>
          <li><b>Appearance</b> - colors and fonts.</li>
          <li><b>Privacy</b> - who can see the profile, on/off switches for sounds and notifications, and whether to allow DMs.</li>
          <li><b>Links</b> - little chips you can add at the top of the profile (Discord, Twitter, etc.).</li>
          <li><b>Gallery</b> - extra pictures for a character.</li>
          <li><b>Journal</b> - in-character diary entries for a character.</li>
        </Bullets>

        <Heading>Writing the bio</Heading>
        <P>
          The bio is plain text by default. Hit <b>Save</b> when you're
          done. If you'd like more control, you can also use a small set
          of HTML tags to add headings, lists, links, tables, and so on.
          The <b>Formatting</b> tab in this Help has the full list of
          what's allowed, with an example you can copy.
        </P>

        <Heading>A simple example</Heading>
        <pre className="overflow-x-auto rounded border border-keep-rule/60 bg-keep-panel/30 p-2 font-mono text-[10px] leading-relaxed">{`<h3>Sigrid the Quiet</h3>
<p>A retired blade-singer who runs a quiet inn at the
foot of the mountains. Speaks little. Watches everything.</p>

<h4>At a glance</h4>
<ul>
  <li>Age: late forties</li>
  <li>Build: lean, scarred forearms</li>
  <li>Voice: low, weighed, rarely raised</li>
</ul>

<details>
  <summary>Content warnings (click to expand)</summary>
  <p>Touches on grief and occasional combat injury.
  Nothing on-screen without buy-in.</p>
</details>`}</pre>

        <Tip>
          The bio editor doesn't save by itself. Hit <b>Save</b> before
          switching characters, or you'll lose your edits.
        </Tip>

        <Heading>Visibility and NSFW</Heading>
        <P>
          In the <b>Privacy</b> tab you can mark the profile as public
          (anyone can read it) or only visible when signed in. The{" "}
          <b>NSFW</b> checkbox hides the profile behind a content warning
          and limits it to signed-in viewers.
        </P>
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
          A direct message (DM) is a private one-on-one chat. It's just
          between you and the other person, and it stays in your Messages
          inbox even if you're in different rooms.
        </P>

        <Heading>Open your Messages inbox</Heading>
        <Steps>
          <li>Open the <b>Tools</b> drawer and pick <b>Messages</b>.</li>
          <li>Or click the small envelope icon next to your name above the Tools button.</li>
          <li>Or click <b>💬 Message</b> at the top of someone's profile.</li>
        </Steps>
        <P>
          The inbox shows your friends and your recent conversations on the
          left. Tap one to open the chat on the right. On a phone, tap a
          conversation and the chat takes over the screen; the tabs at the
          top let you flip back to the inbox.
        </P>

        <Heading>Make a friend</Heading>
        <Steps>
          <li>Type their username in <b>add friend by username</b> at the bottom of the inbox.</li>
          <li>They get a notice with Accept / Decline buttons.</li>
          <li>If they accept, you both show up on each other's friends list.</li>
        </Steps>
        <P>
          You can also do this with <K>/friend {`<name>`}</K> in chat.
          <K>/friends</K> shows your list, <K>/unfriend {`<name>`}</K> ends
          a friendship.
        </P>

        <Heading>Message someone who isn't a friend</Heading>
        <P>
          You don't have to be friends to send a DM. Type their username
          in <b>message non-friend</b> at the bottom of the inbox, or click{" "}
          <b>💬 Message</b> on their profile. The conversation shows up
          under <b>Recent</b>.
        </P>

        <Heading>Turn off DMs</Heading>
        <P>
          If you'd rather not receive DMs at all, open your profile editor,
          go to <b>Privacy</b>, and turn off <b>DMs enabled</b>. People
          trying to message you will see a friendly "this user has DMs
          turned off" notice.
        </P>

        <Heading>Notifications and sounds</Heading>
        <P>
          A new DM makes a soft "ping" sound. The Messages icon shows a
          little number for any unread DMs or pending friend requests.
          You can turn the ping off in your profile under{" "}
          <b>Privacy</b> &rarr; <b>Sound effects</b>.
        </P>

        <Heading>Fix a mistake</Heading>
        <P>
          For one minute after sending a DM, you can edit or delete it.
          After that, what's sent is sent.
        </P>
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
    id: "thesaurus",
    title: "Thesaurus: highlight a word for synonyms",
    body: (
      <>
        <P>
          Stuck on a word mid-scene? Highlight it in the chat box and a
          list of synonyms pops up. Pick one, it replaces what you had
          selected, and you keep typing.
        </P>
        <Heading>Where it works</Heading>
        <Bullets>
          <li>The main chat box in any room.</li>
          <li>The text box in your direct messages.</li>
          <li>Forum topics and replies.</li>
        </Bullets>
        <Heading>How to trigger it</Heading>
        <P>
          Drag-select a single word (apostrophes and hyphens are fine, so
          "can't" and "cross-examine" both work). A small list appears
          just above the text box.
        </P>
        <Heading>Using the popup</Heading>
        <Bullets>
          <li>Press <b>Up</b> or <b>Down</b> to move through the list.</li>
          <li>Press <b>Enter</b> or <b>Tab</b> to take the highlighted word.</li>
          <li>Press <b>Esc</b> to close it without changing anything.</li>
          <li>Or just click the word you want.</li>
        </Bullets>
        <Heading>What shows up</Heading>
        <P>
          Single words and short phrases, drawn from a built-in synonym
          dictionary. A common word like "happy" might suggest "cheerful"
          and "in good spirits" side by side. If nothing comes up, the
          word isn't in the dictionary; try a different form (e.g.
          "running" vs "run").
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

  {
    id: "earning",
    title: "Earning: XP, Currency, ranks, and cosmetics",
    body: (
      <>
        <P>
          Earning is the long-term reward layer for being part of the community. Every chat
          message, forum post, and quiet stretch of presence in a room earns you{" "}
          <b>Experience (XP)</b> and <b>Currency</b> in parallel — XP grows your <b>rank</b>{" "}
          (the sigil shown next to your name), Currency stays in your wallet for spending on
          name styles, avatar borders, and other cosmetics.
        </P>
        <P>
          Open <b>Earning</b> from the top banner to see your wallet, rank progress, activity
          ledger, and everything available to buy.
        </P>

        <Heading>How you earn</Heading>
        <Bullets>
          <li>
            <b>Chat messages</b> in a room — the body has to be a few characters long, so a
            single "ok" doesn't count.
          </li>
          <li>
            <b>Forum posts and replies</b> in nested-mode rooms.
          </li>
          <li>
            <b>Presence</b> — staying active in a room awards a small amount every few minutes,
            capped per day. "Active" means you posted or scrolled history in that block.
          </li>
        </Bullets>
        <P>
          When you're posting <i>as a character</i>, your earnings credit that character's pool;
          OOC channels and forum posts credit your master account. Both pools have their own
          rank. You can level a favorite character while keeping your master rank separate.
        </P>

        <Heading>Slash commands</Heading>
        <Bullets>
          <li>
            <K>/currency</K> — show your wallet (master + active character).
          </li>
          <li>
            <K>/currency [user]</K> — peek at another user's balance (honors their privacy
            toggle).
          </li>
          <li>
            <K>/currency send [target] [amount]</K> — send Currency to another user OR
            character. Subject to daily caps and account-age gates set by the admin.
          </li>
          <li>
            <K>/exp</K> — show your XP, rank, and tier. If you've reached the capstone of any
            rank (Tier IV: Verified), the line also lists which borders you can buy.
          </li>
          <li>
            <K>/exp [user]</K> — look up another user's rank. Rank is always public.
          </li>
        </Bullets>

        <Heading>Ranks and tiers</Heading>
        <P>
          The ladder has six ranks shipped by default: New Arrival, Active, Recognized,
          Established, Distinguished, Legacy Member. Each has four tiers (I, II, III, IV:
          Verified — the capstone). Crossing into a new tier surfaces a quiet ribbon at the top
          of the chat ("you've reached Recognized III") that you can dismiss. Reaching Tier IV
          of any rank unlocks that rank's <b>border frame</b> for purchase.
        </P>
        <P>
          Your <b>sigil</b> — the small badge next to your name in chat, the userlist, and on
          forum posts — always tracks your current rank/tier. It updates automatically.
        </P>

        <Heading>Cosmetics you can buy</Heading>
        <Bullets>
          <li>
            <b>Name styles</b> — gradient, glow, pulsing, panning, etc. Buy in the Earning
            dashboard's Name Styles section, customize the colors, and equip. Your styled name
            shows in chat, the userlist, and forum posts. Colors stay legible against both
            light and dark themes.
          </li>
          <li>
            <b>Rank borders</b> — circular frames that wrap your avatar. Available only after
            you've reached Tier IV of a given rank. You can own multiple and pick which one
            you display.
          </li>
          <li>
            <b>Inline avatar in chat</b> — once bought, your round avatar shows after the
            timestamp on every chat line. It also replaces the gender icon in the userlist as
            the click-target for opening your profile.
          </li>
        </Bullets>

        <Heading>Privacy</Heading>
        <P>
          Open <b>Earning → Settings</b> to hide your Currency total from other users (or via
          the profile editor's Privacy tab). Your rank and XP stay visible — rank is meant as a
          public identity tag.
        </P>

        <Tip>
          New here? Earning is opt-in by participation, not opt-in by clicking. Just chat
          normally and you'll see your first rank within a session or two.
        </Tip>
      </>
    ),
  },
];
