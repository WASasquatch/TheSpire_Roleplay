# The Spire

A roleplay-focused chat sanctuary. Build characters, share scenes, and tell collaborative stories with other writers. A modern Node/React reimagining of the RPGHost / NexxusChat / phpMyChat lineage, with first-class character profiles, slash-command parity, mutual relationship titles, an in-app wiki for your world(s), per-user direct messages, and privacy guarantees enforced in code rather than by promise.

### Live demo

[https://thespire.fly.dev/](https://thespire.fly.dev/)

---

## What you can do here

The Spire is a real-time text chat built specifically for roleplayers. It treats characters as first-class citizens, keeps OOC and IC distinct, and gives admins a moderation toolkit without ever letting them read what was said in private.

### Characters & profiles

You sign in with a **master account** — that's your OOC handle and login identity. Underneath it, you keep as many **characters** as you want, each with their own bio (rich HTML — headings, lists, tables, collapsible spoiler blocks, inline CSS), structured stats (age, race, gender, height, weight, alignment, occupation, plus custom key/value rows you define), avatar, theme, a portrait gallery, and an in-character journal.

| Action | Command |
| --- | --- |
| Activate a character | `/char switch <name>` |
| Drop back to your OOC handle | `/char clear` (or `/char switch OOC`) |
| Create a new character (opens the editor) | `/char create <name>` |
| Rename, edit, or delete | `/char edit <name>` / `/char delete <name>` |
| Open the editor for your active identity | `/profile` |
| View someone's profile by name | `/whois <name>` |
| Open a random profile | `/whois` (no args) |

Click a name in chat to pre-fill a whisper; click their `@mention` to open the profile. Each profile applies the **owner's** theme to the modal — every character feels distinctly theirs to whoever's looking.

Master usernames are globally unique; character names are unique per owner. If a master and a character happen to share a name, `/whois` resolves to the master.

The profile editor is tabbed: **Description** (bio HTML), **Profile** (name/avatar/stats), **Appearance** (theme + fonts, master only), **Privacy** (visibility, NSFW, notifications, DM opt-out, sound effects), **Links** (external chip links), **Gallery** (extra portraits, per-image NSFW flag, character only), and **Journal** (in-character log entries, character only).

### Direct messages & friends

Two players can DM each other privately — conversations live outside the rooms, follow you across rooms, and persist even when the recipient is offline.

- **Friends** are mutual and explicit. `/friend <name>` sends a pending request; `/accept <name>` or `/decline <name>` resolves it; `/unfriend <name>` ends it; `/friends` lists yours. Friends get a small "X is online" line when they connect.
- **DM anyone.** You don't need to be friends to message someone. Profile → 💬 Message, or the compose-to-non-friend form in the Messages modal.
- **Unread badges** appear on the Tools button, on the Messages menu item, and on each conversation in the list.
- **Soft-delete** + 60-second edit grace, same as room messages.
- **Reports** — right-click any incoming DM to file a moderation report. The full thread snapshot lands in the admin queue; the body is preserved server-side even if the sender later deletes the message.
- **Opt-out** — Profile → Privacy → DMs enabled. Toggle off to refuse all DMs; senders get a friendly "this user has DMs turned off" response.

The Messages modal has a resizable two-pane layout (drag the divider, double-click to reset) with the inbox on the left and the active thread on the right. Mobile collapses to one pane with a back chevron.

### Chat & roleplay

- **`/me <action>`** — renders `YourName <action>` with no brackets or colons. Aliases let you phrase pronoun-naturally: `/he`, `/she`, `/they`, `/it`, `/em`, `/action`, `/pose`, `/emote`. The display name is always the sender's; pronouns inside the action text are the author's responsibility.
- **Limited Markdown** — `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, `[link text](https://...)`, `@mentions`, `@world:slug` chips, opt-in inline images. Block-level features (headings, tables, blockquotes) are intentionally omitted from chat — chat is single-line content. The full reference is in the Help modal's Formatting tab.
- **`/whisper <name> <text>`** (alias `/w`) — private 1:1 message. The recipient can be a master username (always works) or an active character name. `/reply <text>` answers the last whisper without re-typing the name.
- **`/reply <messageId> <text>`** (or click a timestamp) — threaded reply that quotes the parent message and stacks under it in nested-reply rooms.
- **`/mood <text>`** — small mood chip next to your name ("brooding", "smug"). `/mood clear` removes it.
- **`/scene <title>`** (owner/mod) — set a scene banner above the chat. `/scene end` clears it.
- **`/npcmode on|off`** (owner/mod) — toggle whether `/npc <name> <dialogue>` is allowed in this room. Voiced-by tag prevents impersonation.
- **`/roll 1d20`, `/roll 3d6`, `/roll d20`** — dice with crypto-secure RNG. Results post as a distinct message kind that's authoritative server-side (clients can't re-roll or fake).
- **`/color #990000`** — set the hex color used on your messages and actions. `/color clear` reverts. Each character can override the master color independently.
- **`/away [reason]`** — toggle your away state. `/back` clears it.
- **`/ignore <name>`** — silence a user. One-way and silent — they have no signal you've done it. Their messages are dropped server-side before they reach your socket. `/unignore <name>` reverses.
- **`/bookmarks`** — save a message for later. The Bookmarks modal lists every save with a jump-to-message link and a freeform note field.
- **`/refresh [N]`** — re-fetch the userlist + topic. Pass `N` (5–3600) to set an auto-refresh interval; `/refresh off` disables it.
- **Custom commands** — admins author their own slash commands at runtime (`/blush`, `/grin`, `/tea`, etc.) with a small template language. They appear in `/help` alongside built-ins, and can default to a custom color.

Type `/help` for the full searchable reference with subcommand options. `/help <command>` jumps to a specific command's card. The Help modal also has a Guides tab with plain-language walkthroughs of every major feature, and a Formatting tab that doubles as the HTML allow-list reference for profile + world bios.

### Sound effects

Three small audio cues, each individually toggleable in Profile → Privacy → Sound effects:

| Sound | Fires on | Default |
| --- | --- | --- |
| `ping` | Inbound DM from anyone | on |
| `tap` | Inbound chat message or `/me` action in any room you're in | on |
| `alert` | Admin `/announce` or system message | on |

Sounds respect the browser's autoplay rules — they kick in after your first click anywhere in the app. Toggling a sound in the editor takes effect immediately on save (no reload).

### Rooms

- **Public rooms** — anyone joins via `/go RoomName`. Creates the room if it doesn't exist. Multi-word names work: `/go Common Room`.
- **Private (password-protected) rooms** — `/go SecretRoom hunter2` creates one with that password if it doesn't exist, or joins an existing private room without you having to click through the password prompt. Equivalent to `/private SecretRoom hunter2`. The first whitespace-separated token is the name; everything after is the password.
- **Invites** — `/invite <name>` whitelists a user so they can join a private room without the password. Useful for sustaining a scene as new players are added without leaking the password every time.
- **Topics and descriptions** — `/topic <text>` is the short headline above the chat (always visible). `/describe <long text>` is the long-form world-setting description shown once when someone enters the room.
- **Scene marker** — `/scene <title>` puts a banner above the chat ("Scene: dragon's lair"); `/scene end` clears it. Owner/mod only.
- **Per-room moderation** — `/kick`, `/mute <user> <duration>`, `/ban <user> [duration] [reason]`, `/promote` users to room mods, `/demote` them back. Room owners and mods govern their own rooms; site admins can intervene anywhere.
- **Announcements** — `/announce <text>` (owner/mod/admin) renders a high-visibility banner in the current room. `/announce all <text>` (admin only) blasts it sitewide.
- **Per-room rendering modes** — `/replymode nested` groups replies under their parent in a thread container; `/replymode flat` reverts. `/expiry <minutes>` auto-deletes messages older than N; `/expiry off` clears it. Pairs well with `nested` for bulletin/forum-style rooms.
- **Persistent rooms** — system rooms (`The_Spire`, `Tavern`, `Library`, `Garden`, `Bazaar` by default) survive admin sweeps and auto-expiry. User-created rooms auto-expire when nobody's inside.

The first room you land in on connect is The Spire — a beacon-tower where entities arrive disoriented and find their footing. From there you wander.

### Forums (threaded rooms)

Any room can be switched into forum mode with `/replymode nested`. In forum mode:

- New top-level messages become **topics** with a title input alongside the composer.
- Replies stack under their parent in a collapsible thread. Latest 5 are visible; "View More" expands the rest.
- Topics can be **sticky** (admin-pinned), **locked** (no more replies), and grouped into **thread categories** (per-room labels you create from the Tools menu).
- Each topic has its own URL fragment so you can deep-link a thread.
- A "Pop-out" icon opens a topic in a focused modal with the full reply tree.

Pair forum mode with `/expiry` for "looking for RP" bulletin boards that clean themselves up.

### Worlds (your own wiki)

A **world** is a private wiki for your setting — lore, factions, places, NPCs. Each world has a tree of pages nested up to 10 levels deep. You own and edit every world you create; nobody else can edit your pages.

Three visibility tiers:

- **Private** — only you can see it. Draft-mode.
- **Public** — anyone with the URL can read it; not listed in the catalog.
- **Open** — public + listed in the World Catalog; others can join your world and link it to their own rooms.

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

### Mutual titles (bonds)

Two players can ask each other to share a relationship title that appears on both of their profiles — `Married to`, `'s Partner`, `Best Friend of`, `Mate of`, `Sibling of`, plus whatever else admins add to the catalog.

```
/request marriage Bob       # ask Bob to be married to you
/dissolve marriage Bob      # ask Bob to remove the marriage
/titles                     # list your accepted titles
/titles Alice               # list someone else's
/request list               # what title kinds are available
```

When you `/request`, Bob sees an inline Accept | Decline card above the chat composer. On accept, both profiles surface the title; on decline, the request is gone with no record. The same flow applies to dissolution — the other party has to agree before the title is removed.

Titles attach to **identities**, not accounts. Master-Alice married to Master-Bob is a separate relationship from Char-Alice married to Char-Bob, so the system follows whichever face you were wearing when you sent the request. The catalog is admin-managed (Admin → Titles), supporting both symmetric kinds (marriage, partner) and asymmetric ones (mentor / apprentice).

---

## Privacy & safety

The Spire's privacy guarantees are enforced **in code**, not by policy. The invariants:

### What admins can NOT see

- **Whispers are never readable by admins.** Sender and recipient can scroll back through their own; no admin endpoint will return them. The `/admin/rooms/:id/messages` route filters whispers out of every room regardless of room type.
- **Direct messages are never readable by admins via room queries.** A DM only enters the moderation queue when the *recipient* explicitly files a 🚩 report on it — and then it's the reported snippet, not the full inbox.
- **Private-room messages are never readable by admins.** Admins can list private rooms, see who's in them, and view their metadata (name, topic, owner, member count) — but the message contents are walled off at the data layer. Whatever you say in a private room stays between the people who were there.
- **Soft-deleted characters keep their message history under the snapshotted name.** Admins see the name as-it-was-then in moderation views, not whatever the owner renames to later.

### What admins CAN see

To be honest about what moderation does have access to:

- All public-room message content (for moderation review).
- The existence, name, owner, topic, and current occupants of every room — including private ones.
- The user list, login/registration metadata, IP/user-agent recorded per session.
- Site-wide configuration: themes, branding, rules, room caps, retention windows, etc.
- DM contents that someone explicitly reported via the 🚩 button (preserved server-side even if the sender deletes the message later).

If you have abuse to report, screenshot or 🚩 and contact an admin — the privacy contract means we can act on evidence we can see, but never on contents we can't.

### Other guarantees

- **NSFW flagging is multi-layered and independent.** A profile can be marked NSFW (gates anonymous viewers behind a "private" stub and surfaces a content warning before the modal opens). Individual character portraits in the gallery carry their own `nsfw` flag — these blur with click-to-reveal regardless of the parent profile's flag. The two are intentionally decoupled.
- **`/ignore` is one-way and silent.** The ignored user has no signal you've done it. Your scrollback is filtered locally; their incoming messages are dropped server-side before they reach your socket. Admins are not exempt — ignore an admin and you stop seeing their messages.
- **Sessions are server-side and per-tab.** They live in a SQLite row referenced by a bearer token stored in `sessionStorage` — admins (and the periodic janitor) can revoke them by deleting the row. No JWTs, no shared cookies. Each browser tab gets its own session, so you can sign in as two different accounts (or the same account with different active characters) side-by-side without one tab stomping the other.
- **The keymaster is untouchable.** The longest-tenured admin (the first registered user, by default) cannot be demoted, kicked, muted, or banned by anyone. The keys to the keep stay with the original holder. Worth choosing carefully on a fresh install.
- **No third-party content loads at first paint.** The page sets `referrer-policy: no-referrer` so admin-configured banner backgrounds and avatars don't leak the visitor's URL to third parties. Inline images in chat are opt-in (you click "Show image" before they load).
- **Strict Content Security Policy in production.** Every HTML response carries a fresh per-request CSP nonce; `script-src` and `style-src` reject anything that doesn't quote it. Inline scripts (the JSON-LD block, Vite's prod bundle tag, admin analytics splices) are auto-nonced server-side. `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`. Companion headers: HSTS, X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy strict-origin-when-cross-origin, Cross-Origin-Opener-Policy same-origin, and a Permissions-Policy that opts the site out of camera/mic/geolocation/payment/USB/sensors/MIDI/FLoC.

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

- **Master account** — your login identity / OOC handle. The first registered user is auto-promoted to admin (the keymaster).
- **Character** — display name + bio + stats + avatar + theme + gallery + journal. `/char switch <name>` activates one; `/char clear` returns you to OOC.
- **Identity** — a master account OR a specific character. Mutual titles, profile lookups, DMs, friends, and most "who is this?" questions resolve to an identity.
- **System rooms** — permanent rooms that survive admin sweeps and auto-expiry. Default install ships The_Spire, Tavern, Library, Garden, and Bazaar.
- **World** — your own private wiki. Owned and edited by you; can be private, public-by-URL, or open (listed + joinable).
- **Friend** — mutual relationship; both sides accept. A friendship surfaces the online indicator and groups conversations under a Friends section in Messages.
- **Bond** — mutual relationship *title* (married, mate, mentor, etc.) that appears on both profiles.
- **Custom commands** — admin-authored at runtime via a small template language (variables, math, choose, if/else). Two flavors: `action` (renders like `/me`) and `say` (renders as a normal message).

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

In production mode the server registers `@fastify/static` against `apps/web/dist/` and adds an SPA fallback so client-side routes serve `index.html`. The splash response is rewritten server-side with the admin-configured site name, SEO meta description, JSON-LD, and any analytics scripts spliced in — so non-JS crawlers see live values. CORS is disabled (same origin), and `WEB_ORIGIN=""` makes that explicit.

The production response carries a strict per-request CSP with a fresh nonce; every inline `<script>` and `<style>` the server emits is stamped with that nonce on the way out. See `Privacy & safety → Other guarantees` above for the full policy.

## Deploying to Fly.io

### One-time setup

The repo ships a [`first-deployment.sh`](first-deployment.sh) helper that walks the whole bootstrap idempotently — installing flyctl + logging in are still your job, but everything else (app create, `SESSION_SECRET`, persistent volume, initial seeded deploy) runs in one command:

```sh
./first-deployment.sh
```

It reads the app name and region from `fly.toml`, skips any step that's already done, and keeps default-room seeding **enabled** so a fresh install boots with `The_Spire`, `Tavern`, `Library`, `Garden`, and `Bazaar` ready to go. After the deploy finishes, register the first account at `https://<app>.fly.dev/` — that user is auto-promoted to keymaster admin.

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

By default the script stages `apps/`, `packages/`, and `README.md` only — root-level files require `--all`. `.gitignore` is honored either way. Run `bash scripts/ship.sh --help` for the full flag reference.

A second helper, [`remote-deploy.sh`](remote-deploy.sh), is a one-liner that runs `bash scripts/ship.sh --deploy-only --no-seed --remote-only` — what you'll typically use after pushing changes manually (or for re-deploying current `origin/main` without a new commit).

### Heads-up: bearer-token migration

The current codebase ships sessions as bearer tokens stored in `sessionStorage`, not as HttpOnly cookies. The first deploy after upgrading from a cookie-session install will invalidate every active session — users sign back in once and pick up the new flow. Their session rows in SQLite stay around (unreachable until janitor sweep), which is harmless.

### Preserving admin customizations across deploys

Server boot calls `ensureSystemSeeds`, which idempotently re-creates the default rooms by exact-name match. If an admin **renames** a default room, the seed sees the original name as missing and re-creates it — leaving a duplicate next to the renamed copy.

To freeze the seed once you've customized rooms, ship with `--no-seed`:

```sh
pnpm ship "msg" --no-seed                # stages SKIP_DEFAULT_SEED=1 as a Fly secret, then deploys
pnpm ship "msg" --reseed                 # clears it so default rooms get re-seeded again
```

The flag is sticky — once set, every subsequent deploy honors it until cleared with `--reseed`. The system sentinel user and the site-settings singleton are still ensured (both insert-if-missing only; they never overwrite admin customization), so this is safe to leave on permanently for production installs.

### What `fly.toml` does

- Runs the container on internal port **8080**, with Fly's edge mapping external **80** and **443** (HTTPS forced) to it. End users hit `https://<app>.fly.dev` with no port suffix.
- Mounts a 1 GB volume at `/data`, where the SQLite file lives. Survives deploys and machine restarts.
- Wires `/health` as the health check and keeps at least one machine warm (chat needs persistent WebSocket connections).

The `Dockerfile` builds the web bundle, then runs the server with `tsx`. Migrations apply on every boot (idempotent) before the server starts listening.

## SEO & analytics

The splash page is server-rendered with admin-configured `<title>`, `<meta name="description">`, Open Graph + Twitter Card tags, JSON-LD structured data, and a canonical URL — so non-JS crawlers (Google's classic crawler, Discord/Slack/Twitter card scrapers, etc.) see live values rather than the empty Vite shell.

Admins control three SEO-related fields from **Admin → Branding**:

- **SEO description** — plain text used in `<meta description>`, `og:description`, and `twitter:description`.
- **Custom head HTML** — verbatim raw HTML spliced into `<head>` on every splash response. The intended use is analytics tags (Plausible, GA4, Cloudflare Web Analytics, Umami, etc.) — paste from your provider's dashboard. **Not** sanitized; admin-trusted only. The server auto-stamps the per-request CSP nonce onto any `<script>` or `<style>` tags it splices in, so analytics keeps working under the strict CSP.

A `robots.txt` and `sitemap.xml` are served from the app at the root. The default `robots.txt` allows everything (the auth wall handles privacy); the sitemap lists `/`, `/login`, and `/register` since everything past login is private.

## Known limitations

A short list of small surprises that are intentional in the current build — documented here so future contributors don't re-discover them as bugs:

- **Reply snippets are frozen at the moment of reply.** When the author of a parent message uses the 60-second edit grace to fix typos, any child message's `replyToBodySnippet` keeps the original snippet. This matches the rest of the snapshot-at-send-time pattern and keeps the audit trail honest, but it means a reply quote can drift from the live parent body.
- **Public-room reports only for room messages.** The 🚩 button doesn't show on whispers or private-room messages, and the server rejects reports for either kind. Whispers carry the strongest privacy contract; private-room participants can already use `/ignore` and the room owner's `/kick`. DMs have their own report path (recipient only) since the DM is already a two-party affair.
- **`sessionStorage` is per-tab, not per-window.** Two tabs you open via "+ new tab" are independent (the intended behavior). But a tab spawned by a `target="_blank"` link from a logged-in tab *does* inherit `sessionStorage` per the HTML spec, so it'll be logged in too. That's typically what users want, but worth knowing.
- **Bearer token is JS-reachable.** Migrating off HttpOnly cookies bought per-tab session isolation at the cost of making an XSS more dangerous (the token can be exfiltrated by injected script). The strict CSP closes the most common vector, but the bio HTML sanitizer is still the load-bearing defense for stored-XSS attempts.
