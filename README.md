# The Spire

A roleplay-focused chat sanctuary. Build characters, share scenes, and tell collaborative stories with other writers. A modern Node/React reimagining of the RPGHost / NexxusChat / phpMyChat lineage, with first-class character profiles, slash-command parity, mutual relationship titles, and privacy guarantees enforced in code rather than by promise.

### Live demo

[https://thespire.fly.dev/](https://thespire.fly.dev/)

---

## What you can do here

The Spire is a real-time text chat built specifically for roleplayers. It treats characters as first-class citizens, keeps OOC and IC distinct, and gives admins a moderation toolkit without ever letting them read what was said in private.

### Characters & profiles

You sign in with a **master account** — that's your OOC handle and login identity. Underneath it, you keep as many **characters** as you want, each with their own bio (limited HTML — links, formatting, lists), structured stats (age, race, gender, height, weight, alignment, occupation, plus custom key/value rows you define), avatar, and theme.

| Action | Command |
| --- | --- |
| Activate a character | `/char switch <name>` |
| Drop back to your OOC handle | `/char clear` (or `/char switch OOC`) |
| Create a new character (opens the editor) | `/char create <name>` |
| Rename, edit, or delete | `/char edit <name>` / `/char delete <name>` |
| Open the editor for your active identity | `/profile` |
| View someone's profile by name | `/whois <name>` |
| Open a random profile | `/whois` (no args) |

Click a name in chat to pre-fill a whisper; click the gender icon next to it to view that user's profile. Each profile applies the **owner's** theme to the modal — every character feels distinctly theirs to whoever's looking.

Master usernames are globally unique; character names are unique per owner. If a master and a character happen to share a name, `/whois` resolves to the master.

### Mutual titles

Two players can ask each other to share a relationship title that appears on both of their profiles — `Married to`, `'s Partner`, `Best Friend of`, `Mate of`, `Sibling of`, plus whatever else admins add to the catalog.

```
/request marriage Bob       # ask Bob to be married to you
/dissolve marriage Bob      # ask Bob to remove the marriage
/titles                     # list your accepted titles
/titles Alice               # list someone else's
/request list               # what title kinds are available
```

When you `/request`, Bob sees an inline Accept | Decline card above the chat composer. On accept, both profiles surface the title; on decline, the request is gone with no record. The same flow applies to dissolution — the other party has to agree before the title is removed, so a marriage can't be silently severed.

Titles attach to **identities**, not accounts. Master-Alice married to Master-Bob is a separate relationship from Char-Alice married to Char-Bob, so the system follows whichever face you were wearing when you sent the request. The catalog is admin-managed (Admin → Titles), supporting both symmetric kinds (marriage, partner) and asymmetric ones (mentor / apprentice).

### Chat & roleplay

- **`/me <action>`** — renders `YourName <action>` with no brackets or colons. Aliases let you phrase pronoun-naturally: `/he`, `/she`, `/they`, `/it`, `/em`, `/action`, `/pose`, `/emote`. The display name is always the sender's; pronouns inside the action text are the author's responsibility.
- **Limited Markdown** — `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, `[link text](https://...)`, `@mentions`, opt-in inline images. Block-level features (headings, tables, blockquotes) are intentionally omitted — chat is single-line content. The full reference is in the Help modal's Formatting tab.
- **`/whisper <name> <text>`** — private 1:1 message. The recipient can be a master username (always works) or an active character name.
- **`/roll 1d20`, `/roll 3d6`, `/roll d20`** — dice with crypto-secure RNG. Results post as a distinct message kind that's authoritative server-side (clients can't re-roll or fake).
- **`/color #990000`** — set the hex color used on your messages and actions. `/color clear` reverts.
- **`/away [reason]`** — toggle your away state. With a reason, others see it on hover. With no reason while already away, you come back.
- **`/ignore <name>`** — silence a user. One-way and silent — they have no signal you've done it. `/unignore <name>` reverses.
- **`/refresh [N]`** — re-fetch the userlist + topic. Pass `N` (5–3600) to set an auto-refresh interval; `/refresh off` disables it.
- **Custom commands** — admins author their own slash commands at runtime (`/blush`, `/grin`, `/tea`, etc.) with a small template language. They appear in `/help` alongside built-ins, and can default to a custom color.

Type `/help` or click **Help** in the banner for the full searchable reference with subcommand options. `/help <command>` jumps to a specific command's card.

### Rooms

- **Public rooms** — anyone joins via `/go RoomName`. Creates the room if it doesn't exist. Multi-word names work: `/go Common Room`.
- **Private (password-protected) rooms** — `/go SecretRoom hunter2` creates one with that password if it doesn't exist, or joins an existing private room without you having to click through the password prompt. Equivalent to `/private SecretRoom hunter2`. The first whitespace-separated token is the name; everything after is the password.
- **Invites** — `/invite <name>` whitelists a user so they can join a private room without the password. Useful for sustaining a scene as new players are added without leaking the password every time.
- **Topics and descriptions** — `/topic <text>` is the short headline above the chat (always visible). `/describe <long text>` is the long-form world-setting description shown once when someone enters the room.
- **Per-room moderation** — `/kick`, `/mute <user> <duration>`, `/ban <user> [duration] [reason]`, `/promote` users to room mods, `/demote` them back. Room owners and mods govern their own rooms; site admins can intervene anywhere.
- **Persistent rooms** — system rooms (`The_Spire`, `Tavern`, `Library`, `Garden`, `Bazaar` by default) survive admin sweeps and auto-expiry. User-created rooms auto-expire when nobody's inside.

The first room you land in on connect is The Spire — a beacon-tower where entities arrive disoriented and find their footing. From there you wander.

---

## Privacy & safety

The Spire's privacy guarantees are enforced **in code**, not by policy. The invariants:

### What admins can NOT see

- **Whispers are never readable by admins.** Sender and recipient can scroll back through their own; no admin endpoint will return them. The `/admin/messages` route filters whispers out of every room regardless of room type.
- **Private-room messages are never readable by admins.** Admins can list private rooms, see who's in them, and view their metadata (name, topic, owner, member count) — but the message contents are walled off at the data layer. Whatever you say in a private room stays between the people who were there.
- **Soft-deleted characters keep their message history under the snapshotted name.** Admins see the name as-it-was-then in moderation views, not whatever the owner renames to later.

### What admins CAN see

To be honest about what moderation does have access to:

- All public-room message content (for moderation review).
- The existence, name, owner, topic, and current occupants of every room — including private ones.
- The user list, login/registration metadata, IP/user-agent recorded per session.
- Site-wide configuration: themes, branding, rules, room caps, retention windows, etc.

If you have abuse to report, screenshot and contact an admin — the privacy contract means we can act on evidence we can see, but never on contents we can't.

### Other guarantees

- **`/ignore` is one-way and silent.** The ignored user has no signal you've done it. Your scrollback is filtered locally; their incoming messages are dropped server-side before they reach your socket.
- **Sessions are server-side.** They live in a database row referenced by an `httpOnly` cookie — admins (and the periodic janitor) can revoke them. No JWTs. Idle expiry is sliding; typing or scrolling keeps your session alive while you're at the keyboard.
- **The keymaster is untouchable.** The longest-tenured admin (the first registered user, by default) cannot be demoted, kicked, muted, or banned by anyone. The keys to the keep stay with the original holder. Worth choosing carefully on a fresh install.
- **Admins are NOT exempt from `/ignore`.** If you ignore an admin, you stop seeing their messages just like anyone else's.
- **No third-party content loads at first paint.** The page sets `referrer-policy: no-referrer` so admin-configured banner backgrounds and avatars don't leak the visitor's URL to third parties. Inline images in chat are opt-in (you click "Show image" before they load).

### Etiquette & community standards

The default house rules (admin-editable per install) cover what most RP communities expect:

1. **Stay in character.** OOC chatter belongs in `(( double parens ))` or in OOC rooms.
2. **Consent matters.** Negotiate dark, sexual, or violent themes with your scene partners before play. Honor "no" without negotiation.
3. **No god-modding.** Don't dictate other characters' actions, thoughts, or outcomes. Ask, or roll for contested actions.
4. **Respect pace.** Don't pressure others to post faster, write longer, or play scenes they're uncomfortable with.
5. **Keep IC and OOC separate.** A character's hostility is not the player's.
6. **Mind the rating.** Public rooms are general-audience by default; explicit content belongs in private rooms with consenting participants.
7. **No real-world hate.** Bigotry, harassment, and targeting of real people are out of bounds in any room.
8. **Report problems.** If something crosses a line, screenshot and report to an admin rather than escalating in chat.

Registration requires explicit acknowledgement of a disclaimer that the operators don't endorse the fiction users write here, that mature themes may appear, and that respectful OOC behavior is expected. Both the rules and the disclaimer are admin-editable per install.

---

## Concepts cheat sheet

- **Master account** — your login identity / OOC handle. The first registered user is auto-promoted to admin (the keymaster).
- **Character** — display name + bio + stats + avatar + theme. `/char switch <name>` activates one; `/char clear` returns you to OOC.
- **Identity** — a master account OR a specific character. Mutual titles, profile lookups, and most "who is this?" questions resolve to an identity.
- **System rooms** — permanent rooms that survive admin sweeps and auto-expiry. Default install ships The_Spire, Tavern, Library, Garden, and Bazaar; admins can edit them but not delete.
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

In production mode the server registers `@fastify/static` against `apps/web/dist/` and adds an SPA fallback so client-side routes serve `index.html`. The splash response is rewritten server-side with the admin-configured site name, SEO meta description, and any analytics scripts so non-JS crawlers see live values. CORS is disabled (same origin), and `WEB_ORIGIN=""` makes that explicit.

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

### Preserving admin customizations across deploys

Server boot calls `ensureSystemSeeds`, which idempotently re-creates the default rooms by exact-name match. If an admin **renames** a default room, the seed sees the original name as missing and re-creates it — leaving a duplicate next to the renamed copy.

To freeze the seed once you've customized rooms, ship with `--no-seed`:

```sh
pnpm ship "msg" --no-seed                # stages SKIP_DEFAULT_SEED=1 as a Fly secret, then deploys
pnpm ship "msg" --reseed                 # clears it so default rooms get re-seeded again
```

The flag is sticky — once set, every subsequent deploy honors it until cleared with `--reseed`. The system sentinel user and the site-settings singleton are still ensured (both insert-if-missing only; they never overwrite admin customization), so this is safe to leave on permanently for production installs.

A second helper, [`remote-deploy.sh`](remote-deploy.sh), is a one-liner that runs `bash scripts/ship.sh --deploy-only --no-seed --remote-only` — what you'll typically use after pushing changes manually (or for re-deploying current `origin/main` without a new commit).

### What `fly.toml` does

- Runs the container on internal port **8080**, with Fly's edge mapping external **80** and **443** (HTTPS forced) to it. End users hit `https://<app>.fly.dev` with no port suffix.
- Mounts a 1 GB volume at `/data`, where the SQLite file lives. Survives deploys and machine restarts.
- Wires `/health` as the health check and keeps at least one machine warm (chat needs persistent WebSocket connections).

The `Dockerfile` builds the web bundle, then runs the server with `tsx`. Migrations apply on every boot (idempotent) before the server starts listening.

## SEO & analytics

The splash page is server-rendered with admin-configured `<title>`, `<meta name="description">`, Open Graph + Twitter Card tags, JSON-LD structured data, and a canonical URL — so non-JS crawlers (Google's classic crawler, Discord/Slack/Twitter card scrapers, etc.) see live values rather than the empty Vite shell.

Admins control three SEO-related fields from **Admin → Branding**:

- **SEO description** — plain text used in `<meta description>`, `og:description`, and `twitter:description`.
- **Custom head HTML** — verbatim raw HTML spliced into `<head>` on every splash response. The intended use is analytics tags (Plausible, GA4, Cloudflare Web Analytics, Umami, etc.) — paste from your provider's dashboard. **Not** sanitized; admin-trusted only.

A `robots.txt` and `sitemap.xml` are served from the app at the root. The default `robots.txt` allows everything (the auth wall handles privacy); the sitemap lists only `/` since everything past login is private.

## Known limitations

A short list of small surprises that are intentional in the current build — documented here so future contributors don't re-discover them as bugs:

- **Reply snippets are frozen at the moment of reply.** When the author of a parent message uses the 60-second edit grace to fix typos, any child message's `replyToBodySnippet` keeps the original snippet. This matches the rest of the snapshot-at-send-time pattern (`displayName`, `toDisplayName`, etc.) and keeps the audit trail honest, but it means a reply quote can drift from the live parent body. Revisit only if users complain.
- **Public-room reports only.** The 🚩 button doesn't show on whispers or private-room messages, and the server rejects reports for either kind. Whispers carry the strongest privacy contract (admins explicitly cannot read them), and private-room participants can already use `/ignore` and the room owner's `/kick`. Surfacing private-room bodies into the admin queue would breach the privacy posture and is not in scope for v1.
