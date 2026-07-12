# Feature Scoping — Discord-like gaps + bookmark archiving

Scoped against the live codebase (one design pass per feature). Full per-feature detail
(reuse citations, data models, risks) lives in the scoping workflow transcript; this doc is
the decision layer: ranking, effort, key decisions, and the cross-cutting insights.

Effort scale: **S** <1d · **M** 1–3d · **L** ~1wk · **XL** multi-week. Next migration is `0314`.

## Corrections & owner decisions
- **Link unfurling already ships** (`apps/server/src/unfurl.ts` — OpenGraph fetch, SSRF guards, 24h cache).
- **`serverWelcomeSeen` table exists but was never wired** (migration 0276). Onboarding reuses it as the "completed" marker for free.
- **DECISION — attachments deferred.** No storage budget for hosted files; keep the existing **direct image-link (URL) embeds**. With unfurl already done, the whole "richer messages" ask is effectively closed.
- **DECISION — "server search" = widen the existing search, not a new one.** Today the Menu's "Search this room" box (`SearchBar` → `/rooms/:id/messages/search`) searches **only the current room** and works; it does **not** search the active server. The item is just extending that box's scope to the whole active server.

## The structural insight: one shared primitive
**Pinned messages** and **bookmark archiving** both need the same thing — *keep a message's content alive after the retention janitor hard-deletes the row*. Build the snapshot mechanism once and both features fall out. They share the same moderation rule: **only retention-expiry may preserve content; a mod-delete / `/trash` / block must show `[removed]`, never the snapshot.** Recommend building them together.

## Recommended roadmap (phased)

| Phase | Feature | Effort | Why here |
|---|---|---|---|
| **1** | Bookmark archiving | **M** | Your headline ask; fixes real data-loss; establishes the snapshot primitive |
| **1** | Pinned messages | **M** | High RP value (scene briefs, rules); reuses the snapshot primitive |
| **2** | Events / RSVP | **L** | Biggest RP-native feature — organizing sessions; reuses Notification Center |
| **3** | Per-channel notifications + unread | **L** | Big usability win at scale; **perf-sensitive** (must not re-create the `/rooms` storm) |
| **3** | Self-roles + onboarding | **L** | Reuses usergroups + the unwired welcome table; identity/belonging fit |
| **4** | Auto-mod filters | **L** | Anti-raid safety; must stay opt-in/configurable (mature RP) |
| **4** | 2FA (TOTP) | **L** | Account-takeover protection; staff-mandatory option |
| **1** | Announcements → per-server admin | **S–M** | Mostly already built + migrated; remaining = retire/repoint the global tab + fix a banner-leak bug |
| **5** | Server search — relocated + rich | **L** | Move search into the room rail (above Forums Catalog), widen to the active server, per-hit room/server context; privacy-critical visible-room filter is the hard part |
| — | ~~Native attachments~~ **Deferred** | — | No storage budget — keep direct image-link (URL) embeds |
| **6** | Webhooks / bot API | **XL** | Platform extensibility; ship **incoming webhooks first** (~L), defer bot API/outgoing |

## Per-feature capsules

### Bookmark archiving — M *(headline)*
Snapshot the message into the `bookmarks` row at bookmark time (mirrors the existing reply-snapshot columns); render live while the message exists, fall back to the snapshot **only** when retention-expired.
- **Data:** ~12 nullable `snapshot_*` columns on `bookmarks` + `archived_at`; **flip `bookmarks.message_id` FK from `ON DELETE CASCADE` → `SET NULL`** (the linchpin — otherwise retention cascades the bookmark away). SQLite table-rebuild migration.
- **Key correctness rule:** the retention janitor (`seed.ts sweepMessages`) sets `archived_at` before its delete; `/trash`, mod-delete, ban-purge, and account-delete never do → those show `[removed]`. Do **not** infer intent after the row is gone.
- **Also:** block-suppression on read, forum-thread bookmarking (forum posts are messages), client-side search. Folders/multi-tag deferred.
- **Top risk:** exposing a snapshot for mod-removed content = a privacy hole. **Fit:** strong (RP chat is ephemeral by design; keepsakes shouldn't vanish).

### Pinned messages — M
Room-mod/owner-gated pin; everyone sees a pins panel in `RoomInfoBar`. Snapshot into a **separate `pinned_messages` table** (not a flag on `messages`) so retention needs zero sweep edits and pins survive.
- **Reuse:** the `PATCH /messages/:id/sticky` route is a near-exact template; forum topic "sticky" already exists (scope v1 to flat rooms).
- **Key decisions:** who can pin (new `pin_message` perm + room owner/mod), max pins per room, keep-snapshot vs `[removed]` on moderation. **Top risk:** pinning a whisper/private message leaks it — gate with the visibility check + reject whispers.

### Events / RSVP — L
Per-server events (title/time/description, optional linked room/forum), per-identity RSVP, reminders via the Notification Center. One-off only for v1 (recurrence column reserved, no expansion).
- **Reuse:** clone `servers/announcements.ts` (module + gate) and the `runDueAnnouncements` sweep for reminders; add a `manage_events` server permission.
- **Key decisions:** timezone (store UTC, render local), single reminder-lead, per-identity vs per-account RSVP. **Top risk:** reminder fan-out storm (dedupe by user; fire once via `reminder_fired_at`).

### Per-channel notifications + unread — L
Per-user-per-room read marker + per-room mute → unread dot / mention pill in the rail + jump-to-unread.
- **Hard constraint:** unread must be an **incremental per-user socket pulse** (clone `engine.ts pulse()`), fanned only to `room_members` minus live occupants — **never** an N+1 over the room tree per poll (that's the storm we just fixed). Server is the sole source of unread to avoid double-counting.
- **Key decisions:** members-only scope, mentions-pierce-mute (soft mute). **Fit:** strong, on-ethos (passive awareness, no grind).

### Self-roles + onboarding — L
Member-selectable usergroups + a first-join onboarding modal mapping prompts (pronouns/factions/interests) → existing usergroups.
- **Reuse:** almost entirely the existing server usergroups system (`resolveUsergroupPerms` needs no change); repurpose the unwired `serverWelcomeSeen` table; onboarding config as JSON on `serverSettings`.
- **Extra cost:** the "entered server X first time" client trigger doesn't exist yet. **Key decisions:** UI picker (not reaction-roles — no reuse), onboarding soft/dismissible (don't gate access). **Top risk:** self-join must be clamped to feature perms + `memberSelectable` groups only.

### Auto-mod filters — L
Keyword/regex/link/invite/mention-cap rules with per-rule warn/delete/mute, running inline in the dispatch pipeline beside the rate-based anti-spam. **Off by default.**
- **Reuse:** the anti-spam hook point + mute/notice code verbatim; `antiSpam.ts` pure-core structure for the matcher; settings/server-settings plumbing.
- **Top risks:** **ReDoS** (admin regex on the hot path — validate + time-budget), and **false positives vs mature RP** (whole-word matching, a test/preview box, generous staff exemptions). Site-wide baseline + optional additive per-server.

### 2FA (TOTP) — L
Enroll (QR/secret) → confirm → backup codes; login gains a second step; staff-mandatory toggle. Secret encrypted at rest (AES-256-GCM via HKDF from `SESSION_SECRET`, reusing the `export/sign.ts` pattern).
- **Reuse:** intercept `/auth/login` right before `issueSession`; backup codes mirror the single-use `email_tokens` pattern; hand-rolled RFC-6238 (matches the repo's hand-rolled-crypto posture, zero new server deps) + a small web QR lib.
- **Top risks:** brute-force the 6-digit code (per-pending-token attempt cap + lockout, not just per-IP), TOTP replay (store last-used step), admin "reset 2FA" escape hatch.

### Native attachments — DEFERRED
Hosted file/image uploads are **deferred** — no storage budget, and it would add orphan-file GC, per-user quotas, EXIF stripping, and upload moderation. **Keep the current direct image-link (URL) embeds**, which already render through the media pipeline with lazy-load + the NSFW censor. Revisit only if object storage (S3/R2) is added later.

### Server search — relocated + rich — L
Three things in one: (1) **move** search out of the Menu into the main UI, (2) **widen** it from the current room to the active server, (3) **enrich** the results with per-hit context.
- **Placement:** a dedicated search container at the TOP of the room rail, **above the Forums Catalog button** ([RoomsTree.tsx:288](apps/web/src/components/RoomsTree.tsx#L288)) in its own `border-b` container matching that row. Pass `currentServerId` + the existing jump handler into `SearchBar`; remove it from the ToolPanel Menu (or leave a thin fallback — decide).
- **Rich live results:** `SearchBar` already renders a live debounced popup with snippet highlighting + author + date ([SearchBar.tsx](apps/web/src/components/SearchBar.tsx)); add **room + server** per hit (extend `MessageSearchHit` + the endpoint) so each result shows where it lives, plus a "This room / This server" scope toggle.
- **The hard part is the visible-room filter** (private membership + forum board/category locks + server moderation + blocks) — must be derived from `roomVisibilityWhere` + `forumBoardReadGate` + `serverAuthority` + `blockedUserIdsFor`, never hand-rolled. **Top risk:** a single missed class = a privacy leak.
- **Decision:** FTS5 (scales; TEXT-id/rowid workaround + triggers) vs extended LIKE (zero-maintenance; fine while retention caps live rows — ship LIKE, FTS as fast-follow).

### Announcements → per-server admin — S–M *(mostly already built)*
**Most of this already exists.** Per-server announcements are fully implemented — `servers/announcements.ts` gives community owners CRUD gated on `serverCan('manage_announcements')`, and the server console already has an Announcements tab (`server-admin/AnnouncementsTab.tsx`). The **data migration is also already done**: migration 0279 backfilled every old global announcement to `server_id = 'server_spire_system'` (the default Spire server). So "owners make their own" and "migrate existing to the default server" are both DONE.
- **What actually remains (S–M):**
  1. **Reconcile the Global Admin tab.** `admin/announcements.ts` still reads ALL announcements (no serverId filter) and creates new rows with `serverId = NULL`. Either scope it to `DEFAULT_SERVER_ID` so it manages only the default server's announcements, OR **retire the global tab** and let site staff manage the default server through the normal server console like any other server (recommended — the default server is just a server).
  2. **Server-scope the public banner read (real bug).** `GET /announcements/banners` (`routes/announcements.ts`) returns **every** enabled banner regardless of server, so a community server's announcements currently **leak to the whole site** and the marquee mixes all servers. Filter by the viewer's current server + the default/system server (site-wide). This is arguably the important half of the ask — an owner's announcement should show in *their* server, not globally.
- **Top risk:** the read change must keep the default Spire server's announcements reaching everyone (site-wide) while community ones stay scoped to their server.

### Webhooks / bot API — XL (phase it)
- **Phase 1 (~L): incoming webhooks** — `POST /hooks/:token` injects a message into a room as an attributed NPC line (reuse `addMessageDirect` + NPC voicing). Token CRUD clones the server-invite flow; store token **hashes**, reveal once.
- **Phase 2 (~L): scoped bot tokens + read API** — each read endpoint is an info-disclosure surface (must honor `roomVisibilityWhere`, blocks, private membership).
- **Phase 3 (~L): outgoing webhooks** — must use the `unfurl.ts` SSRF-safe fetcher + HMAC signing.
- **Top risks:** SSRF (outgoing), secret leakage (tokens in URLs/logs), ingress DoS (per-IP + per-token limiters).

## Cross-cutting reuse map
- **Snapshot-past-retention** → bookmarks + pins (shared).
- **Notification Center (`engine.ts`)** → events (reminders), per-channel unread (pulse).
- **Server usergroups** → self-roles + onboarding.
- **NPC voicing** → webhook/bot message identity.
- **`unfurl.ts` SSRF-safe fetcher** → outgoing webhooks.
- **Anti-spam dispatch hook + mute code** → auto-mod.
- **`export/sign.ts` HKDF + `email_tokens` single-use** → 2FA secret encryption + backup codes.
- **`serverWelcomeSeen` (0276, unwired) + `WelcomeModal`** → onboarding.

## Notes
- Every server-scoped feature ships dark behind `serversEnabled` and re-checks `serverAuthority` per action.
- All were rated a strong fit for the RP/writing niche; none violate the no-grind/no-decay participation ethos.
- Migration numbers above all say "0314" for convenience; they'd be assigned sequentially when built.
