# The Spire

A roleplay-focused chat sanctuary. Build characters, share scenes, and tell collaborative stories with other writers. A modern Node/React reimagining of the RPGHost / NexxusChat / phpMyChat lineage, with first-class character profiles, slash-command parity, mutual relationship titles, an in-app wiki for your world(s), per-user direct messages, a long-form fiction surface with chapters and reviews, and privacy guarantees enforced in code rather than by promise.

### Live demo

[https://thespire.games/](https://thespire.games/)

---

## What you can do here

The Spire is a real-time text chat built specifically for roleplayers. It treats characters as first-class citizens, keeps OOC and IC distinct, and gives admins a moderation toolkit without ever letting them read what was said in private.

### Characters & profiles

You sign in with a **master account** - that's your OOC handle and login identity. Underneath it, you keep as many **characters** as you want, each with their own bio (rich HTML - headings, lists, tables, collapsible spoiler blocks, inline CSS), structured stats (age, race, gender, height, weight, alignment, occupation, plus custom key/value rows you define), avatar, theme, a portrait gallery, and an in-character journal.

| Action | Command |
| --- | --- |
| Activate a character | `/char switch <name>` |
| Drop back to your OOC handle | `/char clear` (or `/char switch OOC`) |
| Create a new character (opens the editor) | `/char create <name>` |
| Rename, edit, or delete | `/char edit <name>` / `/char delete <name>` |
| Open the editor for your active identity | `/profile` |
| View someone's profile by name | `/whois <name>` |
| Open a random profile | `/whois` (no args) |

Click a name in chat to pre-fill a whisper; click their `@mention` to open the profile. Each profile applies the **owner's** theme to the modal - every character feels distinctly theirs to whoever's looking.

Master usernames are globally unique; character names are unique per owner. If a master and a character happen to share a name, `/whois` resolves to the master.

The profile editor is tabbed: **Description** (bio HTML), **Profile** (name/avatar/stats), **Appearance** (theme + fonts, master only), **Privacy** (visibility, NSFW, notifications, DM opt-out, sound effects, Scriptorium content-warning blocklist), **Links** (external chip links), **Gallery** (extra portraits, per-image NSFW flag, character only), and **Journal** (in-character log entries, character only).

### Direct messages & friends

Two players can DM each other privately - conversations live outside the rooms, follow you across rooms, and persist even when the recipient is offline.

- **Friends** are mutual and explicit. `/friend <name>` sends a pending request; `/accept <name>` or `/decline <name>` resolves it; `/unfriend <name>` ends it; `/friends` lists yours. Friends get a small "X is online" line when they connect.
- **DM anyone.** You don't need to be friends to message someone. Profile → 💬 Message, or the compose-to-non-friend form in the Messages modal.
- **Unread badges** appear on the Tools button, on the Messages menu item, and on each conversation in the list.
- **Soft-delete** + 60-second edit grace, same as room messages.
- **Reports** - right-click any incoming DM to file a moderation report. The full thread snapshot lands in the admin queue; the body is preserved server-side even if the sender later deletes the message.
- **Opt-out** - Profile → Privacy → DMs enabled. Toggle off to refuse all DMs; senders get a friendly "this user has DMs turned off" response.

The Messages modal has a resizable two-pane layout (drag the divider, double-click to reset) with the inbox on the left and the active thread on the right. Mobile collapses to one pane with a back chevron.

### Chat & roleplay

- **`/me <action>`** - renders `YourName <action>` with no brackets or colons. Aliases let you phrase pronoun-naturally: `/he`, `/she`, `/they`, `/it`, `/em`, `/action`, `/pose`, `/emote`. The display name is always the sender's; pronouns inside the action text are the author's responsibility.
- **Limited Markdown** - `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, `[link text](https://...)`, `@mentions`, `@world:slug` chips, opt-in inline images. Block-level features (headings, tables, blockquotes) are intentionally omitted from chat - chat is single-line content. The full reference is in the Help modal's Formatting tab.
- **`/whisper <name> <text>`** (alias `/w`) - private 1:1 message. The recipient can be a master username (always works) or an active character name. `/reply <text>` answers the last whisper without re-typing the name.
- **`/reply <messageId> <text>`** (or click a timestamp) - threaded reply that quotes the parent message and stacks under it in nested-reply rooms.
- **`/mood <text>`** - small mood chip next to your name ("brooding", "smug"). `/mood clear` removes it.
- **`/scene <title>`** (owner/mod) - set a scene banner above the chat. `/scene end` clears it.
- **`/npcmode on|off`** (owner/mod) - toggle whether `/npc <name> <dialogue>` is allowed in this room. Voiced-by tag prevents impersonation.
- **`/roll <NdM[±X]>`** - dice with crypto-secure RNG. `/roll 1d20`, `/roll 3d6`, `/roll d20` (count defaults to 1), plus an optional flat modifier: `/roll 1d20+3` renders `14 + 3 = 17`; `/roll 2d6-1` subtracts. Caps: 1–100 dice, 2–1000 sides, ±999 modifier. Results post as a distinct message kind that's authoritative server-side (clients can't re-roll or fake).
- **`/color #990000`** - set the hex color used on your messages and actions. `/color clear` reverts. Each character can override the master color independently.
- **`/away [reason]`** - toggle your away state. `/back` clears it.
- **`/ignore <name>`** - silence a user. One-way and silent - they have no signal you've done it. Their messages are dropped server-side before they reach your socket. `/unignore <name>` reverses.
- **`/bookmarks`** - save a message for later. The Bookmarks modal lists every save with a jump-to-message link and a freeform note field.
- **`/refresh [N]`** - re-fetch the userlist + topic. Pass `N` (5–3600) to set an auto-refresh interval; `/refresh off` disables it.
- **Custom commands** - admins author their own slash commands at runtime (`/blush`, `/grin`, `/tea`, etc.) with a small template language. They appear in `/help` alongside built-ins, and can default to a custom color.
- **Inline `!cmd` expansion** - drop a command into the middle of a sentence with a `!` prefix. `She rolls perception !roll:1d20+3 and waits` expands the `!roll:1d20+3` token in place to `( rolls 🎲 1d20+3: 17 + 3 = 20 )`, leaving the rest of the line untouched. `!roll` with no `:arg` defaults to `1d20`. Custom commands opt in to inline form too — admins flag them inline-eligible and they expand on the same `!name[:arg]` token shape. Expansions carry a server-side verification marker so the renderer paints a ✓ tooltip — confirmation that the result really came from the command, not a writer faking output. Escape with `\!cmd` (literal) or put the token inside `` `code` `` / a fenced code block to suppress expansion.

Type `/help` for the full searchable reference with subcommand options. `/help <command>` jumps to a specific command's card. The Help modal also has a Guides tab with plain-language walkthroughs of every major feature, and a Formatting tab that doubles as the HTML allow-list reference for profile + world bios.

### Thesaurus lookup

Highlight any word in a chat composer, a DM input, or a forum thread / reply and a synonyms popup floats above the input - same UX shape as the `@`-mention completer. Arrow keys navigate, Enter or Tab accepts the highlighted synonym (replacing the selection in place), Esc dismisses, and clicking a result also accepts.

The data is the public-domain **Moby Thesaurus + Open Office Thesaurus** corpus (~30k root words, hundreds of thousands of synonyms including short phrases), bundled in-process via the [`moby`](https://github.com/words/moby) npm package - no external API, no key, no rate-limit dependency. The server exposes a single `GET /thesaurus?word=<word>` endpoint (auth-gated, 60/min/IP, results capped at 50 per call). Lookups are synchronous hash hits, debounced 200ms client-side so a fast drag through a selection doesn't fire a request per pixel.

Out-of-scope by design: definitions, antonyms, part-of-speech filtering. The point is "swap a word for a better word mid-roleplay," not full lexicography.

### Emoticons & reactions

A sticker-sheet emoticon system spans chat, DMs, and forum posts. Each sheet is a 4×4 grid (16 cells) labeled per cell; admins manage sheets, images, sort order, and per-cell labels from the admin panel.

- **Inline emoticons.** Click the smiley in the formatting toolbar to insert a sprite at the caret. Tokens are `:slug:idx:`; the chat parser distinguishes them from the `:` /me shortcut, so an emoticon-only line sends as a normal chat message instead of an italic action.
- **Sticker mode.** When a chat message body is just a single emoticon, it renders at 84px (Messenger / Discord / Telegram style) instead of the 24px inline sprite.
- **Reactions.** Tap any chat message, DM, or forum post to react. Reactions group by (sheet, cell) and show as round chips with the sprite + a count. Hovering pops a preview tooltip with a 48px sprite and the reactor names - phrased as prose ("Alice and Bob reacted with happy", "Alice, Bob, and 3 others reacted with happy").
- **+ react placement.** The trigger lives in the floating right-side message-tool row next to Edit on chat messages, and in the forum-post action toolbar on forum surfaces. It surfaces on hover (desktop) or row tap (mobile), so empty chat rows aren't littered with feint pills under every line.
- **Visible-count caps.** 4 chips on mobile, 10 on desktop, with a "+N more" overflow that opens the full reactor list grouped by emoticon.

### Sound effects

Three small audio cues, each individually toggleable in Profile → Privacy → Sound effects:

| Sound | Fires on | Default |
| --- | --- | --- |
| `ping` | Inbound DM from anyone | on |
| `tap` | Inbound chat message or `/me` action in any room you're in | on |
| `alert` | Admin `/announce` or system message | on |

Sounds respect the browser's autoplay rules - they kick in after your first click anywhere in the app. Toggling a sound in the editor takes effect immediately on save (no reload).

### Rooms

- **Public rooms** - anyone joins via `/go RoomName`. Creates the room if it doesn't exist. Multi-word names work: `/go Common Room`.
- **Private (password-protected) rooms** - `/go SecretRoom hunter2` creates one with that password if it doesn't exist, or joins an existing private room without you having to click through the password prompt. Equivalent to `/private SecretRoom hunter2`. The first whitespace-separated token is the name; everything after is the password.
- **Invites** - `/invite <name>` whitelists a user so they can join a private room without the password. Useful for sustaining a scene as new players are added without leaking the password every time.
- **Topics and descriptions** - `/topic <text>` is the short headline above the chat (always visible). `/describe <long text>` is the long-form world-setting description shown once when someone enters the room.
- **Scene marker** - `/scene <title>` puts a banner above the chat ("Scene: dragon's lair"); `/scene end` clears it. Owner/mod only.
- **Per-room moderation** - `/kick`, `/mute <user> <duration>`, `/ban <user> [duration] [reason]`, `/promote` users to room mods, `/demote` them back. Room owners and mods govern their own rooms; site admins can intervene anywhere.
- **Announcements** - `/announce <text>` (owner/mod/admin) renders a high-visibility banner in the current room. `/announce all <text>` (admin only) blasts it sitewide.
- **Per-room rendering modes** - `/replymode nested` groups replies under their parent in a thread container; `/replymode flat` reverts. `/expiry <minutes>` auto-deletes messages older than N; `/expiry off` clears it. Pairs well with `nested` for bulletin/forum-style rooms.
- **Persistent rooms** - system rooms (`The_Spire`, `Tavern`, `Library`, `Garden`, `Bazaar` by default) survive admin sweeps and auto-expiry. User-created rooms auto-expire when nobody's inside.
- **Enter / leave broadcasts** - when a user moves between rooms, a system line announces departure in the old room ("X has left the room.") and arrival in the new one ("X has entered the room."). Multi-tab safe: if the user has another tab still in the old room, no broadcast fires. Forum rooms suppress these, same as the connect / disconnect messages.

The first room you land in on connect is The Spire - a beacon-tower where entities arrive disoriented and find their footing. From there you wander.

### Forums (threaded rooms)

Any room can be switched into forum mode with `/replymode nested`. In forum mode:

- New top-level messages become **topics** with a title input alongside the composer.
- Replies stack under their parent in a collapsible thread. Latest 5 are visible; "View More" expands the rest.
- Topics can be **sticky** (admin-pinned), **locked** (no more replies), and grouped into **thread categories** (per-room labels you create from the Tools menu).
- Each topic has its own URL fragment so you can deep-link a thread.
- A "Pop-out" icon opens a topic in a focused modal with the full reply tree.

Pair forum mode with `/expiry` for "looking for RP" bulletin boards that clean themselves up.

### Worlds (your own wiki)

A **world** is a private wiki for your setting - lore, factions, places, NPCs. Each world has a tree of pages nested up to 10 levels deep. You own and edit every world you create; nobody else can edit your pages.

Three visibility tiers:

- **Private** - only you can see it. Draft-mode.
- **Public** - anyone with the URL can read it; not listed in the catalog.
- **Open** - public + listed in the World Catalog; others can join your world and link it to their own rooms.

Major actions:

| Action | Command / UI |
| --- | --- |
| Create / list your worlds | Tools → My Worlds |
| Browse open worlds others made | Tools → World Catalog |
| Open a specific world | `/world <slug>` |
| Join an open world (declare affiliation) | `/world join <slug>` |
| Set a primary world (drives chat userlist grouping) | `/world primary <slug>` |
| Leave a world | `/world leave <slug>` |
| Attach a world to the current room (owner/mod) | `/world link <slug>` |
| Detach the room's world | `/world unlink` |
| Inline link to a world in chat | `@world:<slug>` |

Each world has its own theme, NSFW flag, cover image, tagline, and metadata fields. Pages accept the same HTML allow-list as profile bios. Joining a world is purely affiliation; it doesn't grant access to anything.

### Scriptorium (long-form fiction)

Past the chat surface, the Scriptorium is a dedicated long-form writing module for short stories, serialized novels, and fanfiction - authored by master accounts OR characters. Stories surface in the splash bookshelf, the in-app Story Catalog, and via direct link.

**Story structure**

- **Chapters** with their own publish state (draft / published / abandoned), autosaved version history with restore, and per-chapter content warnings.
- **Codex** - a per-story bible for characters, locations, and plot points. Lives alongside the story but isn't part of the narrative; useful for tracking continuity without polluting the prose.
- **Collaborators** with role-based permissions: reader (beta access), commenter, co-author. A soft editing lock prevents two collaborators from overwriting each other's drafts - a second editor sees "Alice is editing - open read-only?" instead of clobbering.

**Visibility tiers** (orthogonal to rating)

- **Private** - author + collaborators only.
- **Unlisted** - anyone with the URL can read; not in catalogs.
- **Public** - catalog-listed; readable per the rating gate.

**Reader engagement**

- **Reviews + applause** - one review per (reader, story) with 1–5 stars + optional prose body. 60-second edit grace mirrors chat / DMs. Reviews support replies. Authors can pin one review and hide individual reviews (still visible to the reviewer themselves). Applause is one-tap, one per (reader, story).
- **Subscriptions** - readers subscribe to a story; new-chapter publishes fan out an in-app notification to every subscriber.
- **Per-user content-warning blocklist** - Profile → Privacy → Scriptorium. Readers hide stories tagged with specific warnings (`body-horror`, `self-harm`, `dubcon`, etc.) without affecting what other readers see.

**Rating gates**

- The catalog and splash bookshelf list every public story regardless of rating, including NC-17.
- NC-17 cards show with a lock indicator and require login to read; the body-open route returns a login-required stub for anonymous viewers.
- G / PG / PG-13 / R are publicly readable without an account.
- The reader carries content-warning chips on the story landing card AND on each chapter heading where the author added them.

**Reader UI**

- **Book mode** - paginated CSS-column flow, page-flip navigation.
- **Pageless mode** - single scrollable column, mark-as-read tracks scroll position so the next visit resumes where you left off.
- **Typography** controls - font family, size, line height, column width.
- **Color schemes** - manual light / sepia / dark override the active theme; the default auto scheme tracks your theme with a contrast-checked text color.

**In-chat commands**

| Action | Command |
| --- | --- |
| Open the Scriptorium catalog (Find Stories tab) | `/scriptorium` (alias `/stories`) |
| Open a specific tab | `/scriptorium find` / `my` / `reading` / `following` |
| Open the editor on your most recent draft | `/write` (aliases `/writing`, `/fanfic`) |
| Start a brand-new story | `/write new` |
| Edit one of your stories by slug | `/write <slug>` |
| Open a story in the reader | `/story <slug>` |
| Jump to a specific chapter | `/story <slug> chapter <N>` (alias `ch`) |

`/write` opens the editor on the author's own draft and is gated to your own stories; `/story` opens the public reader. Unlisted and draft stories only open for their author and invited collaborators.

### Mutual titles (bonds)

Two players can ask each other to share a relationship title that appears on both of their profiles - `Married to`, `'s Partner`, `Best Friend of`, `Mate of`, `Sibling of`, plus whatever else admins add to the catalog.

```
/request marriage Bob       # ask Bob to be married to you
/dissolve marriage Bob      # ask Bob to remove the marriage
/titles                     # list your accepted titles
/titles Alice               # list someone else's
/request list               # what title kinds are available
```

When you `/request`, Bob sees an inline Accept | Decline card above the chat composer. On accept, both profiles surface the title; on decline, the request is gone with no record. The same flow applies to dissolution - the other party has to agree before the title is removed.

Titles attach to **identities**, not accounts. Master-Alice married to Master-Bob is a separate relationship from Char-Alice married to Char-Bob, so the system follows whichever face you were wearing when you sent the request. The catalog is admin-managed (Admin → Titles), supporting both symmetric kinds (marriage, partner) and asymmetric ones (mentor / apprentice).

### Earning — XP, ranks & cosmetics

Posting in chat earns **XP** and **Currency**. Both pools accumulate independently at your master OOC level and per character — your characters earn their own progression alongside your account total.

- **Ranks** are tiered progression bands (Tier I → IV within each rank). Reaching Tier IV in any rank unlocks **borders** — cosmetic frames around your avatar that you can then purchase with Currency.
- **Earning lookups are private to you** — `/exp` and `/currency` reply only to the caller; no broadcast to the room.
- **Currency transfers** are gated by admin-configurable daily caps and account-age requirements to limit gold-farming abuse.

| Action | Command |
| --- | --- |
| Open the Earnings dashboard | `/earnings` (alias `/earning`) |
| Show your XP, Rank, and Tier | `/exp` (aliases `/xp`, `/rank`) |
| Show someone else's Rank + Tier (always public) | `/exp <name>` |
| Show your Currency balance | `/currency` (aliases `/cur`, `/coin`, `/coins`, `/wallet`) |
| Look up another user's balance (honors their privacy toggle) | `/currency <user>` |
| Send Currency from your active identity | `/currency send <target> <amount>` |

### Items, shop, pets & collections

Each identity (master + each character) keeps its own item inventory. Catalog items — cookies, plushies, tools, weapons, pets, etc. — are admin-curated; you acquire them from the Shop with Currency or as gifts from other players.

| Action | Command |
| --- | --- |
| Open the Shop | `/shop` (aliases `/store`, `/market`) |
| Inspect an item by name or alias | `/item <name>` (aliases `/lookup-item`, `/inspect`) |
| Open your 10-slot pinned Collection | `/collection` (alias `/pins`) |
| Open your 5-slot pinned Pets showcase | `/pets` (alias `/pet-collection`) |
| Give an item to someone in the room | `/give <name> [num] <item>` |
| Throw an item at someone (flavor; consumed) | `/throw <name> [num] <item>` |
| Drop an item on someone (flavor; consumed) | `/drop <name> [num] <item>` |

`/give` is the only legal cross-identity transfer. Master inventory and each character's inventory are partitioned by design — your character can't reach into your master's pockets and vice versa. If you want to consolidate, `/give` to yourself between identities.

`/throw` and `/drop` consume the item for flavor — the target doesn't receive anything. Each item ships with its own random throw / drop lines (set by admins); an item that has no lines for an action refuses that action. Both share a 4-second per-sender cooldown so the room doesn't turn into a flicker of system messages.

The pinned **Collection** (items) and **Pets** showcases appear on your profile so other players can see what you've curated. Per-identity: each character pins their own; the master account has its own pair too.

---

## Privacy & safety

The Spire's privacy guarantees are enforced **in code**, not by policy. The invariants:

### What admins can NOT see

- **Whispers are never readable by admins.** Sender and recipient can scroll back through their own; no admin endpoint will return them. The `/admin/rooms/:id/messages` route filters whispers out of every room regardless of room type.
- **Direct messages are never readable by admins via room queries.** A DM only enters the moderation queue when the *recipient* explicitly files a 🚩 report on it - and then it's the reported snippet, not the full inbox.
- **Private-room messages are never readable by admins.** Admins can list private rooms, see who's in them, and view their metadata (name, topic, owner, member count) - but the message contents are walled off at the data layer. Whatever you say in a private room stays between the people who were there.
- **Soft-deleted characters keep their message history under the snapshotted name.** Admins see the name as-it-was-then in moderation views, not whatever the owner renames to later.

### What admins CAN see

To be honest about what moderation does have access to:

- All public-room message content (for moderation review).
- The existence, name, owner, topic, and current occupants of every room - including private ones.
- The user list, login/registration metadata, IP/user-agent recorded per session.
- Site-wide configuration: themes, branding, rules, room caps, retention windows, etc.
- DM contents that someone explicitly reported via the 🚩 button (preserved server-side even if the sender deletes the message later).

If you have abuse to report, screenshot or 🚩 and contact an admin - the privacy contract means we can act on evidence we can see, but never on contents we can't.

### Other guarantees

- **NSFW flagging is multi-layered and independent.** A profile can be marked NSFW (gates anonymous viewers behind a "private" stub and surfaces a content warning before the modal opens). Individual character portraits in the gallery carry their own `nsfw` flag - these blur with click-to-reveal regardless of the parent profile's flag. The two are intentionally decoupled.
- **`/ignore` is one-way and silent.** The ignored user has no signal you've done it. Your scrollback is filtered locally; their incoming messages are dropped server-side before they reach your socket. Admins are not exempt - ignore an admin and you stop seeing their messages.
- **Sessions are server-side and per-tab.** They live in a SQLite row referenced by a bearer token stored in `sessionStorage` - admins (and the periodic janitor) can revoke them by deleting the row. No JWTs, no shared cookies. Each browser tab gets its own session, so you can sign in as two different accounts (or the same account with different active characters) side-by-side without one tab stomping the other.
- **The keymaster is untouchable.** The longest-tenured admin (the first registered user, by default) cannot be demoted, kicked, muted, or banned by anyone. The keys to the keep stay with the original holder. Worth choosing carefully on a fresh install.
- **No third-party content loads at first paint.** The page sets `referrer-policy: no-referrer` so admin-configured banner backgrounds and avatars don't leak the visitor's URL to third parties. Inline images in chat are opt-in (you click "Show image" before they load).
- **Strict Content Security Policy in production.** Every HTML response carries a fresh per-request CSP nonce; `script-src` and `style-src` reject anything that doesn't quote it. Inline scripts (the JSON-LD block, Vite's prod bundle tag, admin analytics splices) are auto-nonced server-side. `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`. Companion headers: HSTS, X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy strict-origin-when-cross-origin, Cross-Origin-Opener-Policy same-origin, and a Permissions-Policy that opts the site out of camera/mic/geolocation/payment/USB/sensors/MIDI/FLoC.
- **Chat copy is plain-text.** Selections copied out of the chat feed or a DM thread land on the clipboard as `text/plain` only - no `text/html`, no inline color spans, no name-style CSS, no avatar markup. Paste a quoted line into Word / Discord / an HTML email composer and you get the prose, not a visually re-rendered chat snippet.
- **Emoticon sprites resist casual save.** Right-click and drag are blocked on every emoticon sprite (chat, DMs, forum, reaction chips, picker, sticker mode). The underlying sheet PNG is still public at its asset URL - devtools can reveal it - but the one-click save vectors are closed.

### Etiquette & community standards

The default house rules (admin-editable per install) cover what most RP communities expect:

1. **Stay in character.** OOC chatter belongs in `(( double parens ))` or in OOC rooms.
2. **Consent matters.** Negotiate dark, sexual, or violent themes with your scene partners before play. Honor "no" without negotiation.
3. **No god-modding.** Don't dictate other characters' actions, thoughts, or outcomes. Ask, or roll for contested actions.
4. **Respect pace.** Don't pressure others to post faster, write longer, or play scenes they're uncomfortable with.
5. **Keep IC and OOC separate.** A character's hostility is not the player's.
6. **Mind the rating.** Public rooms are general-audience by default; explicit content belongs in private rooms with consenting participants.
7. **No real-world hate.** Bigotry, harassment, and targeting of real people are out of bounds in any room.
8. **Report problems.** If something crosses a line, screenshot or 🚩 the message and contact an admin rather than escalating in chat.

Registration requires explicit acknowledgement of a disclaimer (admin-editable per install) that the operators don't endorse the fiction users write here, that mature themes may appear, that you are 18+, and that respectful OOC behavior is expected.

---

## Concepts cheat sheet

- **Master account** - your login identity / OOC handle. The first registered user is auto-promoted to admin (the keymaster).
- **Character** - display name + bio + stats + avatar + theme + gallery + journal. `/char switch <name>` activates one; `/char clear` returns you to OOC.
- **Identity** - a master account OR a specific character. Mutual titles, profile lookups, DMs, friends, and most "who is this?" questions resolve to an identity.
- **System rooms** - permanent rooms that survive admin sweeps and auto-expiry. Default install ships The_Spire, Tavern, Library, Garden, and Bazaar.
- **World** - your own private wiki. Owned and edited by you; can be private, public-by-URL, or open (listed + joinable).
- **Friend** - mutual relationship; both sides accept. A friendship surfaces the online indicator and groups conversations under a Friends section in Messages.
- **Bond** - mutual relationship *title* (married, mate, mentor, etc.) that appears on both profiles.
- **Custom commands** - admin-authored at runtime via a small template language (variables, math, choose, if/else). Two flavors: `action` (renders like `/me`) and `say` (renders as a normal message). Can optionally be flagged inline-eligible so they expand mid-message via `!cmd[:arg]`.
- **Inline command** - `!name[:arg]` token expanded in place inside a chat / DM / forum message body. Built-in: `!roll[:NdM±X]` (defaults to `1d20`). Custom commands opt in. Output carries a ✓ verification tooltip so the rendered result is provably server-authored.
- **XP / Currency** - twin earning pools; chat activity grows both. XP unlocks Ranks + Tiers (cosmetic borders at Tier IV); Currency is spent in the Shop and can be sent between players (`/currency send`).
- **Rank / Tier / Border** - progression cosmetics. Ranks are bands ("Member", "Distinguished", etc., admin-named); each rank has Tiers I → IV. Reaching Tier IV in any rank unlocks the matching avatar Border, which you then buy with Currency.
- **Item / Collection / Pet** - admin-curated catalog items live in your per-identity inventory. Pin up to 10 items to your Collection and up to 5 pets to your Pets showcase; both surface on your profile.
- **Story** - long-form fiction in the Scriptorium. Authored by a master account or a character. Has chapters, an optional codex, optional collaborators, a visibility tier, and a rating tier (G / PG / PG-13 / R / NC-17).
- **Chapter** - one unit of a Story, with its own publish state and version history. The reader navigates between chapters; the codex sits alongside.
- **Codex** - per-story bible: characters, locations, plot points. Reader-visible but not part of the narrative.
- **Emoticon sheet** - 4×4 grid (16 cells) of sprite art with per-cell labels. Admin-managed. Drives both inline emoticons in message bodies and the reactions a user can drop on a message.
- **Reaction** - a (sheet, cell) chip attached to a chat message, DM, or forum post. One reaction per (reactor identity, target, cell); chips group across reactors with a hover-preview of who reacted.

---

# Run it yourself

The rest of this document is for people standing up their own Spire. End-users don't need to read past here.

## Layout

```
TheSpire/
├── apps/
│   ├── server/   Fastify + Socket.IO + Drizzle (SQLite)
│   └── web/      Vite + React + TypeScript + Tailwind
├── packages/
│   └── shared/   Cross-package types (events, commands, profile shapes)
├── scripts/      ship.sh (commit + push + deploy wrapper)
├── first-deployment.sh    bootstrap a fresh Fly.io app
├── remote-deploy.sh       routine deploys (no commit, no seed reset)
├── Dockerfile
└── fly.toml
```

## Development

Two processes, two ports, with Vite proxying API calls from one to the other:

```sh
pnpm install
cp apps/server/.env.example apps/server/.env   # then set SESSION_SECRET
pnpm --filter @thekeep/server run db:push      # creates apps/server/data/thekeep.sqlite
pnpm dev                                       # server :3001, web :5173
```

Open <http://localhost:5173>. The Vite dev server proxies `/auth`, `/admin`, `/site`, `/users`, `/socket.io`, etc. to the Fastify backend on `:3001` (see [`apps/web/vite.config.ts`](apps/web/vite.config.ts)).

## Production (single-process)

A single Node process serves both the API and the built web bundle on one port. The server picks up `PORT` from env (defaults to 3001), so the same binary runs on 80 / 8080 / whatever your host wants.

```sh
NODE_ENV=production \
PORT=80 \
SESSION_SECRET=$(openssl rand -hex 32) \
DATABASE_URL=/var/lib/thespire/thekeep.sqlite \
WEB_ORIGIN="" \
pnpm --filter @thekeep/web run build           # build the SPA bundle once
pnpm --filter @thekeep/server run start        # serves bundle + API on PORT
```

In production mode the server registers `@fastify/static` against `apps/web/dist/` and adds an SPA fallback so client-side routes serve `index.html`. The splash response is rewritten server-side with the admin-configured site name, SEO meta description, JSON-LD, and any analytics scripts spliced in - so non-JS crawlers see live values. CORS is disabled (same origin), and `WEB_ORIGIN=""` makes that explicit.

The production response carries a strict per-request CSP with a fresh nonce; every inline `<script>` and `<style>` the server emits is stamped with that nonce on the way out. See `Privacy & safety → Other guarantees` above for the full policy.

## Deploying to Fly.io

### One-time setup

The repo ships a [`first-deployment.sh`](first-deployment.sh) helper that walks the whole bootstrap idempotently - installing flyctl + logging in are still your job, but everything else (app create, `SESSION_SECRET`, persistent volume, initial seeded deploy) runs in one command:

```sh
./first-deployment.sh
```

It reads the app name and region from `fly.toml`, skips any step that's already done, and keeps default-room seeding **enabled** so a fresh install boots with `The_Spire`, `Tavern`, `Library`, `Garden`, and `Bazaar` ready to go. After the deploy finishes, register the first account at `https://<app>.fly.dev/` - that user is auto-promoted to keymaster admin.

If you'd rather drive flyctl yourself, the equivalent manual commands are:

```sh
flyctl launch --no-deploy
flyctl secrets set SESSION_SECRET=$(openssl rand -hex 32)
flyctl volumes create thespire_data --size 1 --region <your-region>
flyctl deploy
```

### Day-to-day publishing

A `pnpm ship` wrapper bundles typecheck → commit → push to `origin/main` → `flyctl deploy` so a routine publish is one command:

```sh
pnpm ship "your commit message"          # full flow (typecheck, commit, push, deploy)
pnpm ship -m "msg" --remote-only         # build on Fly's builders (handy from WSL)
pnpm ship "msg" --all                    # also stage root files (fly.toml, Dockerfile, scripts/)
pnpm ship "msg" --no-typecheck           # faster, riskier
pnpm ship "msg" --no-deploy              # commit + push only
pnpm deploy                              # alias for `ship --deploy-only` (no commit)
```

By default the script stages `apps/`, `packages/`, and `README.md` only - root-level files require `--all`. `.gitignore` is honored either way. Run `bash scripts/ship.sh --help` for the full flag reference.

A second helper, [`remote-deploy.sh`](remote-deploy.sh), is a one-liner that runs `bash scripts/ship.sh --deploy-only --no-seed --remote-only` - what you'll typically use after pushing changes manually (or for re-deploying current `origin/main` without a new commit).

### Heads-up: bearer-token migration

The current codebase ships sessions as bearer tokens stored in `sessionStorage`, not as HttpOnly cookies. The first deploy after upgrading from a cookie-session install will invalidate every active session - users sign back in once and pick up the new flow. Their session rows in SQLite stay around (unreachable until janitor sweep), which is harmless.

### Preserving admin customizations across deploys

Server boot calls `ensureSystemSeeds`, which idempotently re-creates the default rooms by exact-name match. If an admin **renames** a default room, the seed sees the original name as missing and re-creates it - leaving a duplicate next to the renamed copy.

To freeze the seed once you've customized rooms, ship with `--no-seed`:

```sh
pnpm ship "msg" --no-seed                # stages SKIP_DEFAULT_SEED=1 as a Fly secret, then deploys
pnpm ship "msg" --reseed                 # clears it so default rooms get re-seeded again
```

The flag is sticky - once set, every subsequent deploy honors it until cleared with `--reseed`. The system sentinel user and the site-settings singleton are still ensured (both insert-if-missing only; they never overwrite admin customization), so this is safe to leave on permanently for production installs.

### What `fly.toml` does

- Runs the container on internal port **8080**, with Fly's edge mapping external **80** and **443** (HTTPS forced) to it. End users hit `https://<app>.fly.dev` with no port suffix.
- Mounts a 1 GB volume at `/data`, where the SQLite file lives. Survives deploys and machine restarts.
- Wires `/health` as the health check and keeps at least one machine warm (chat needs persistent WebSocket connections).

The `Dockerfile` builds the web bundle, then runs the server with `tsx`. Migrations apply on every boot (idempotent) before the server starts listening.

## SEO & analytics

The splash page is server-rendered with admin-configured `<title>`, `<meta name="description">`, Open Graph + Twitter Card tags, JSON-LD structured data, and a canonical URL - so non-JS crawlers (Google's classic crawler, Discord/Slack/Twitter card scrapers, etc.) see live values rather than the empty Vite shell.

Admins control three SEO-related fields from **Admin → Branding**:

- **SEO description** - plain text used in `<meta description>`, `og:description`, and `twitter:description`.
- **Custom head HTML** - verbatim raw HTML spliced into `<head>` on every splash response. The intended use is analytics tags (Plausible, GA4, Cloudflare Web Analytics, Umami, etc.) - paste from your provider's dashboard. **Not** sanitized; admin-trusted only. The server auto-stamps the per-request CSP nonce onto any `<script>` or `<style>` tags it splices in, so analytics keeps working under the strict CSP.

A `robots.txt` and `sitemap.xml` are served from the app at the root. The default `robots.txt` allows everything (the auth wall handles privacy); the sitemap lists `/`, `/login`, and `/register` since everything past login is private.

## Known limitations

A short list of small surprises that are intentional in the current build - documented here so future contributors don't re-discover them as bugs:

- **Reply snippets are frozen at the moment of reply.** When the author of a parent message uses the 60-second edit grace to fix typos, any child message's `replyToBodySnippet` keeps the original snippet. This matches the rest of the snapshot-at-send-time pattern and keeps the audit trail honest, but it means a reply quote can drift from the live parent body.
- **Public-room reports only for room messages.** The 🚩 button doesn't show on whispers or private-room messages, and the server rejects reports for either kind. Whispers carry the strongest privacy contract; private-room participants can already use `/ignore` and the room owner's `/kick`. DMs have their own report path (recipient only) since the DM is already a two-party affair.
- **`sessionStorage` is per-tab, not per-window.** Two tabs you open via "+ new tab" are independent (the intended behavior). But a tab spawned by a `target="_blank"` link from a logged-in tab *does* inherit `sessionStorage` per the HTML spec, so it'll be logged in too. That's typically what users want, but worth knowing.
- **Bearer token is JS-reachable.** Migrating off HttpOnly cookies bought per-tab session isolation at the cost of making an XSS more dangerous (the token can be exfiltrated by injected script). The strict CSP closes the most common vector, but the bio HTML sanitizer is still the load-bearing defense for stored-XSS attempts.
