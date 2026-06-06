import { and, eq, lt, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import { emoticonSheets, messages, rooms, sessions, users, worldPages, worlds } from "./db/schema.js";
import { hashPassword } from "./auth/passwords.js";
import { ensureSiteSettings, getSettings, setWorldsSeedVersion } from "./settings.js";
import { recordAudit } from "./audit.js";
import { sanitizeBio } from "./auth/html.js";
import { DEFAULT_WORLDS, WORLDS_SEED_VERSION } from "./seed_worlds.js";
import type { Db } from "./db/index.js";
import { runBackfillIfNeeded } from "./earning/backfill.js";
import { schedulePresenceSweep } from "./earning/sweeps.js";
import { pruneSnapshots } from "./backup/snapshots.js";

/**
 * Default system rooms shipped on every fresh install. Each one is a
 * permanent, public, isSystem=true room that survives auto-expiry and admin
 * sweeps. The Spire itself is the canonical landing room - sockets auto-join
 * it on connect - and the others are thematic gathering places that give
 * roleplayers somewhere to go beyond the entry point.
 *
 * Re-running the seed is idempotent: if a room with the same name already
 * exists we leave it alone so admin edits to topic / description / type are
 * preserved across restarts.
 */
const DEFAULT_ROOMS: Array<{
  name: string;
  topic: string;
  description: string;
}> = [
  {
    name: "The_Spire",
    topic: "The beacon-tower where the universe arrives. New here? Step out and explore.",
    description:
      "The Spire is an ancient beacon-tower where entities from across the universe are summoned into being. Those who appear at its base often arrive disoriented, displaced from distant worlds, timelines, or realms, with some retaining only fragments of memory while others remember nothing of who they were or where they came from. It stands as both a gateway and a mystery, a place of arrival, loss, and uncertain purpose.",
  },
  {
    name: "Tavern",
    topic: "A warm corner beneath the Spire. Drinks, stories, and strangers-turned-friends.",
    description:
      "The Tavern stands at the crossroads beneath the Spire, its windows warm with lantern-light and the air thick with woodsmoke, spiced wine, and the cadence of stories told and retold. Travelers from every realm gather here to trade rumors over scarred wooden tables, to drink away memories they cannot quite recall, or to forge new bonds with strangers who, like them, arrived with no clear road ahead.",
  },
  {
    name: "Library",
    topic: "A quiet sanctum of vaulted stone - lore, fragments, forgotten histories.",
    description:
      "The Library is a quiet sanctum of vaulted stone, its endless shelves lined with tomes, scrolls, and stranger relics gathered from countless arrivals. Some volumes catalogue the histories of vanished worlds; others record fragments brought by those who came before. Lamplight flickers on dust-laden pages, and the silence carries a weight - as if the books themselves are listening.",
  },
  {
    name: "Garden",
    topic: "A still place beneath the Spire's eastern flank. For walking, remembering, forgetting.",
    description:
      "The Garden lies at the Spire's eastern flank, a hidden grove of moss-soft paths and slow-flowing water. Trees from a hundred worlds grow side by side here, their leaves whispering memories that aren't quite anyone's. Many come to walk in stillness, to remember, or simply to forget the weight of their arrival for a while.",
  },
  {
    name: "Bazaar",
    topic: "Trade in goods, names, and half-remembered things.",
    description:
      "The Bazaar sprawls along the Spire's outer terraces in a riot of colored awnings, ringing bells, and competing tongues. Merchants barter in coin and curiosity alike - pieces of broken realms, half-remembered songs, an hour of someone else's name. If something exists, the Bazaar has it for sale; if it doesn't, someone here is willing to invent it.",
  },
];

/**
 * System rows we always need to exist (system user, default rooms, settings).
 *
 * Env opt-out: setting `SKIP_DEFAULT_SEED=1` skips the default-rooms loop and
 * the legacy MainHall→The_Spire rename. The system sentinel user and the
 * site-settings singleton are still ensured (both are insert-if-missing and
 * never overwrite admin customization). Use this when an admin has renamed
 * default rooms - without the flag, the seed sees no room called "Tavern"
 * and re-creates one alongside the renamed copy. Toggle via the ship script:
 *   pnpm ship "msg" --no-seed     # set the flag (persists until unset)
 *   pnpm ship "msg" --reseed      # clear the flag
 */
export async function ensureSystemSeeds(db: Db): Promise<void> {
  // System sentinel user - owns server-authored messages, never logs in.
  const sys = (await db.select().from(users).where(eq(users.username, "system")).limit(1))[0];
  if (!sys) {
    await db.insert(users).values({
      id: "system",
      email: "system@thekeep.local",
      username: "system",
      passwordHash: await hashPassword(nanoid(64)),
      role: "admin",
      bioHtml: "",
      disabledAt: new Date(0), // effectively unlogin-able
    });
  }

  const skipDefaults = /^(1|true|yes)$/i.test(process.env.SKIP_DEFAULT_SEED ?? "");
  if (!skipDefaults) {
    // One-time migration: existing installs were seeded with a room called
    // "MainHall" before The Spire became the canonical landing. If it still
    // exists as a system room, rename it in place so message history,
    // memberships, bans, etc. (all keyed on roomId, not name) survive.
    // Topic + description are overwritten because the new lore replaces the
    // old generic welcome - admins who customized those will need to re-edit.
    const legacy = (await db.select().from(rooms).where(eq(rooms.name, "MainHall")).limit(1))[0];
    const alreadyHasSpire = (await db.select().from(rooms).where(eq(rooms.name, "The_Spire")).limit(1))[0];
    if (legacy && legacy.isSystem && !alreadyHasSpire) {
      const spireDefaults = DEFAULT_ROOMS.find((r) => r.name === "The_Spire")!;
      await db.update(rooms).set({
        name: spireDefaults.name,
        topic: spireDefaults.topic,
        description: spireDefaults.description,
      }).where(eq(rooms.id, legacy.id));
    }

    // Create any missing default rooms. The unique index on lower(name) makes
    // the existence check authoritative; admin customizations to topic /
    // description / type on already-present rooms are preserved. (Admins who
    // *renamed* a default room would still trigger a duplicate here on next
    // boot - hence the SKIP_DEFAULT_SEED escape hatch above.)
    for (const def of DEFAULT_ROOMS) {
      const existing = (await db.select().from(rooms).where(eq(rooms.name, def.name)).limit(1))[0];
      if (existing) continue;
      await db.insert(rooms).values({
        id: nanoid(),
        name: def.name,
        type: "public",
        isSystem: true,
        // The Spire is the canonical landing on a fresh install. Admin
        // can move the flag elsewhere later; the partial unique index in
        // the schema enforces "exactly one default" at the DB layer.
        isDefault: def.name === "The_Spire",
        ownerId: null,
        topic: def.topic,
        description: def.description,
      });
    }

    // Legacy installs that pre-date the is_default flag: if no room
    // carries the flag but The_Spire exists, flip it on so the new
    // findCanonicalLanding logic stays consistent with the old behavior.
    const hasDefault = (await db.select().from(rooms).where(eq(rooms.isDefault, true)).limit(1))[0];
    if (!hasDefault) {
      const spire = (await db.select().from(rooms).where(eq(rooms.name, "The_Spire")).limit(1))[0];
      if (spire) {
        await db.update(rooms).set({ isDefault: true }).where(eq(rooms.id, spire.id));
      }
    }
  }

  // Always ensure the singleton settings row exists. ensureSiteSettings is
  // insert-if-missing only - it never overwrites customized values - so it's
  // safe to run regardless of SKIP_DEFAULT_SEED.
  await ensureSiteSettings(db);

  // Default open worlds. Always-on, intentionally NOT gated by
  // SKIP_DEFAULT_SEED. The flag exists to handle the rooms-renamed case
  // (where a re-seed would create a duplicate "Tavern" alongside an admin's
  // renamed "The Bar"). Worlds key on slug instead of display name, so the
  // insert-if-missing-per-slug loop can never duplicate or overwrite a
  // world that's already there - even after admin edits, even if the
  // world's name was changed entirely. The system simply ships any
  // newly-added DEFAULT_WORLDS entries on the next boot and leaves
  // everything else alone.
  await ensureDefaultWorlds(db);

  // Default emoticon sheets. Always-on, ungated by SKIP_DEFAULT_SEED:
  // sheets key on slug so re-running the seed is a no-op once they're
  // installed. Admins can replace the image or re-label cells freely
  // afterwards; the seeder doesn't try to "fix" their edits.
  await ensureDefaultEmoticonSheets(db);

  // Force-reseed the `{icon}` placeholder on item-message templates
  // when the deploy script (remote-deploy.sh) staged the flag. Always
  // ungated by SKIP_DEFAULT_SEED, that flag governs the room-rename
  // edge case; item-template policy is a separate concern.
  await maybeReseedItemTemplates(db);
}

/**
 * Insert the system-owned default worlds. Idempotent on (owner=system, slug):
 *   - Existing world (any data)  -> skip entirely. Pages may have been edited;
 *     we never touch them.
 *   - World missing entirely     -> insert world + all starter pages.
 *
 * The "world missing entirely" check is keyed on slug, so a renamed default
 * world appears as missing and gets re-seeded next boot. SKIP_DEFAULT_SEED
 * (the existing rooms escape hatch) also gates this, so admins who renamed
 * defaults can flip the flag to stop the duplicate from coming back.
 */
async function ensureDefaultWorlds(db: Db): Promise<void> {
  const settings = await getSettings(db);
  // Decide once up front whether this boot needs to overwrite. The
  // SEED_VERSION constant in seed_worlds.ts is bumped whenever a content
  // refresh ships; the stored value tracks the last applied version on
  // this install. The "missing world" path runs regardless so renamed
  // defaults still come back, but the overwrite-existing path only fires
  // when the code is ahead. Admins who customized system worlds and
  // don't want the refresh: clone the world to your own ownership (the
  // refresh only ever touches owner = "system") or rename the system
  // copy out of the way.
  const shouldOverwrite = settings.worldsSeedVersion < WORLDS_SEED_VERSION;

  for (const def of DEFAULT_WORLDS) {
    const existing = (await db
      .select({ id: worlds.id })
      .from(worlds)
      .where(and(eq(worlds.ownerUserId, "system"), eq(worlds.slug, def.slug)))
      .limit(1))[0];

    if (!existing) {
      // Missing → fresh insert + starter pages.
      const worldId = nanoid();
      await db.insert(worlds).values({
        id: worldId,
        ownerUserId: "system",
        slug: def.slug,
        name: def.name,
        description: def.description,
        visibility: "open",
        // Catalog metadata. Falls back to the DB column defaults
        // ("other", empty strings, "active", null) when the seed entry
        // hasn't been classified yet. Tags + content warnings are
        // joined into the canonical comma-separated form here so the
        // read-side `parseTagList` round-trips them cleanly.
        genre: def.genre ?? "other",
        tags: def.tags ? def.tags.join(",") : "",
        contentWarnings: def.contentWarnings ? def.contentWarnings.join(",") : "",
        pacing: def.pacing ?? null,
      });
      let sortOrder = 0;
      for (const page of def.pages) {
        await db.insert(worldPages).values({
          id: nanoid(),
          worldId,
          parentPageId: null,
          slug: page.slug,
          title: page.title,
          bodyHtml: sanitizeBio(page.bodyHtml),
          sortOrder,
        });
        sortOrder += 1;
      }
      continue;
    }

    if (!shouldOverwrite) continue;

    // Update path: refresh name + description + catalog metadata, wipe
    // existing pages, re-insert from the seed. The world's id (and
    // therefore its members, room links, primary-world references) is
    // preserved so anyone affiliated with a system world keeps that
    // affiliation across content updates.
    //
    // Status is intentionally NOT overwritten, an admin who's
    // promoted a system world to `featured` shouldn't lose that on a
    // version bump.
    await db
      .update(worlds)
      .set({
        name: def.name,
        description: def.description,
        genre: def.genre ?? "other",
        tags: def.tags ? def.tags.join(",") : "",
        contentWarnings: def.contentWarnings ? def.contentWarnings.join(",") : "",
        pacing: def.pacing ?? null,
        updatedAt: new Date(),
      })
      .where(eq(worlds.id, existing.id));
    await db.delete(worldPages).where(eq(worldPages.worldId, existing.id));
    let sortOrder = 0;
    for (const page of def.pages) {
      await db.insert(worldPages).values({
        id: nanoid(),
        worldId: existing.id,
        parentPageId: null,
        slug: page.slug,
        title: page.title,
        bodyHtml: sanitizeBio(page.bodyHtml),
        sortOrder,
      });
      sortOrder += 1;
    }
  }

  if (shouldOverwrite) {
    await setWorldsSeedVersion(db, WORLDS_SEED_VERSION);
  }
}

/**
 * Default emoticon sheets. The sticker sheets shipped under
 * `apps/web/public/assets/emoticons/` are registered as DB rows so
 * the picker can list them like any admin-uploaded sheet. The image
 * URLs point at the bundled assets path; admins can later replace a
 * sheet's image via the admin route (which re-points the URL at
 * /uploads/emoticons/...) without disturbing existing reactions.
 *
 * Keyed on slug so re-running is a no-op once installed, admin edits
 * to name / labels / image are preserved on subsequent boots.
 *
 * `sortOrder` is explicit per row (not derived from array index)
 * because the picker orders by `sortOrder asc, createdAt asc`. The
 * `female/male/kaal` trio shipped first and landed at 0/1/2. When the
 * `basic-*` sheets were added later, they were given NEGATIVE
 * sortOrders so they land at the front of the drawer without
 * requiring an UPDATE of the pre-existing rows (admins may have
 * already customized them, and the seed is deliberately
 * insert-if-missing only).
 *
 * Default cell grid per the project spec:
 *   row 1: happy, laughing, angry, sad
 *   row 2: crying, surprised, embarrassed, smug
 *   row 3: sleepy, lovestruck, confused, determined
 *   row 4: empty, empty, empty, empty
 */
const DEFAULT_EMOTICON_CELLS: string[] = [
  "happy", "laughing", "angry", "sad",
  "crying", "surprised", "embarrassed", "smug",
  "sleepy", "lovestruck", "confused", "determined",
  "", "", "", "",
];
const DEFAULT_EMOTICON_SHEETS: Array<{ slug: string; name: string; imageUrl: string; sortOrder: number }> = [
  { slug: "basic-female-default", name: "Basic Female", imageUrl: "/assets/emoticons/basic_female_emoticon_sheet.png", sortOrder: -2 },
  { slug: "basic-male-default",   name: "Basic Male",   imageUrl: "/assets/emoticons/basic_male_emoticon_sheet.png",   sortOrder: -1 },
  { slug: "female-default",       name: "Female",       imageUrl: "/assets/emoticons/female_emoticon_sheet.png",       sortOrder: 0 },
  { slug: "male-default",         name: "Male",         imageUrl: "/assets/emoticons/male_emoticon_sheet.png",         sortOrder: 1 },
  { slug: "kaal-default",         name: "Kaal",         imageUrl: "/assets/emoticons/kaal_emoticon_sheet.png",         sortOrder: 2 },
];

async function ensureDefaultEmoticonSheets(db: Db): Promise<void> {
  for (const def of DEFAULT_EMOTICON_SHEETS) {
    const existing = (await db
      .select({ id: emoticonSheets.id })
      .from(emoticonSheets)
      .where(eq(emoticonSheets.slug, def.slug))
      .limit(1))[0];
    if (existing) continue;
    await db.insert(emoticonSheets).values({
      id: nanoid(),
      slug: def.slug,
      name: def.name,
      imageUrl: def.imageUrl,
      cells: JSON.stringify(DEFAULT_EMOTICON_CELLS),
      sortOrder: def.sortOrder,
      createdByUserId: null,
    });
  }
}

/**
 * Force-refresh the `{icon}` placeholder on every item's command
 * message templates. Idempotent: the double-REPLACE first strips any
 * existing `{icon} {item_name}` back to `{item_name}`, then re-inserts
 * `{icon} {item_name}`. Running it twice produces the same final
 * state, so booting the same image repeatedly is safe.
 *
 * Triggered by the `FORCE_ITEM_TEMPLATES_RESEED` env var, which
 * `remote-deploy.sh` stages with a fresh timestamp on every deploy.
 * Means: if an admin removed `{icon}` from a template via the live
 * admin UI, the next remote-deploy.sh run puts it back. The rest of
 * the template text (admin-edited flavor copy) is preserved, only
 * the icon prefix is re-asserted.
 *
 * SCOPE: this function touches the `items` table ONLY, and only the
 * three message-JSON columns on it. Name styles
 * (`name_styles` / `user_owned_name_styles` /
 * `character_owned_name_styles`), themes, rooms, worlds, custom
 * commands, admin-edited site settings, and every other admin-
 * customizable cosmetic are NEVER touched by this code path.
 * Migration 0080+ name-style seeds run once via the `_migrations`
 * table tracking in `apply-migrations.mjs`; once an installation has
 * recorded them, admin edits to those styles persist across every
 * future deploy. If you ever need to refresh name styles, do it via
 * a NEW migration file (idempotent UPDATE), not by extending this
 * function's scope.
 *
 * Why a timestamp rather than a sticky `1`: the env var being newer
 * than the last-applied value is what indicates "this boot came from
 * a deploy" rather than an OOM auto-restart. We don't compare here
 * (every boot just re-runs the idempotent sweep), the timestamp is
 * the deploy-side signal; the server-side execution is unconditional
 * whenever the var is set. Cheap: a single UPDATE statement, no-op
 * SQL when every template already has the prefix.
 *
 * Doesn't restore the rest of the canonical template text. Admins
 * who renamed "hands" to "gives" keep their edit; only `{icon}`
 * placement is enforced.
 */
async function maybeReseedItemTemplates(db: Db): Promise<void> {
  const force = process.env.FORCE_ITEM_TEMPLATES_RESEED?.trim();
  if (!force) return;
  await db.run(sql`
    UPDATE items SET
      give_messages_json  = REPLACE(REPLACE(give_messages_json,  '{icon} {item_name}', '{item_name}'), '{item_name}', '{icon} {item_name}'),
      throw_messages_json = REPLACE(REPLACE(throw_messages_json, '{icon} {item_name}', '{item_name}'), '{item_name}', '{icon} {item_name}'),
      drop_messages_json  = REPLACE(REPLACE(drop_messages_json,  '{icon} {item_name}', '{item_name}'), '{item_name}', '{icon} {item_name}'),
      updated_at = (unixepoch() * 1000)
  `);
}

/**
 * Periodic janitor - split into two cadences so idle session expiry is
 * detected promptly without burning DB writes on the slower retention sweep:
 *
 *   - Session sweep runs every 60 seconds. Deletes any session whose
 *     `expiresAt` is in the past and force-disconnects connected sockets
 *     whose underlying row was just swept. With sliding-idle expiry, a
 *     truly idle user gets kicked within a minute of their idle window
 *     elapsing, instead of having to wait for the next chat:input.
 *
 *   - Retention sweep runs hourly. Deletes messages older than the
 *     admin-configured retention window. No-op when retention is 0 (forever).
 *
 * `io` is optional so test harnesses can pass `null`; in production, the
 * live IoServer is passed in so the session sweep can boot expired sockets.
 */
export function startJanitor(
  db: Db,
  log: { info: (...a: unknown[]) => void; error: (...a: unknown[]) => void },
  io: IoServer<ClientToServerEvents, ServerToClientEvents> | null = null,
): () => void {
  async function sweepSessions() {
    try {
      const expired = await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
      if (expired.changes > 0) log.info(`[janitor] cleared ${expired.changes} expired sessions`);

      if (io && expired.changes > 0) {
        const liveSids = new Set(
          (await db.select({ id: sessions.id }).from(sessions)).map((r) => r.id),
        );
        const liveSockets = await io.fetchSockets();
        let kicked = 0;
        for (const s of liveSockets) {
          const sid = (s.data as { sid?: string }).sid;
          if (sid && !liveSids.has(sid)) {
            s.emit("auth:expired");
            s.disconnect(true);
            kicked += 1;
          }
        }
        if (kicked > 0) log.info(`[janitor] booted ${kicked} sockets whose sessions expired`);
      }
    } catch (err) {
      log.error({ err }, "[janitor] session sweep failed");
    }
  }

  async function sweepMessages() {
    try {
      const { messageRetentionMs } = await getSettings(db);
      if (messageRetentionMs > 0) {
        const cutoff = new Date(Date.now() - messageRetentionMs);
        // Nested-mode rooms are forum threads, by design persistent
        // ("Persistent forum topics for long-lived games"). Exempt them
        // unconditionally so the global retention sweep can never gut a
        // forum overnight regardless of how short the site retention is
        // configured. Flipping a room from flat → nested is the admin's
        // signal that its history must not be auto-purged.
        const r = await db.delete(messages).where(
          and(
            lt(messages.createdAt, cutoff),
            sql`${messages.roomId} NOT IN (SELECT id FROM ${rooms} WHERE ${rooms.replyMode} = 'nested')`,
          ),
        );
        if (r.changes > 0) log.info(`[janitor] purged ${r.changes} messages older than retention window`);
      }

      // Per-room expiry sweep. Only rooms with messageExpiryMinutes set
      // participate; the global sweep above already covers the rest.
      // We process room-by-room because each one has its own cutoff and
      // the alternative (a CTE / correlated subquery) doesn't buy us much
      // at chat-size scale and complicates the SQL. Nested-mode rooms are
      // still exempt, same invariant as the global sweep.
      const expiringRooms = await db
        .select({ id: rooms.id, name: rooms.name, mins: rooms.messageExpiryMinutes, replyMode: rooms.replyMode })
        .from(rooms)
        .where(sql`${rooms.messageExpiryMinutes} IS NOT NULL`);
      for (const room of expiringRooms) {
        if (room.replyMode === "nested") continue;
        const mins = room.mins;
        if (!mins || mins <= 0) continue;
        const cutoff = new Date(Date.now() - mins * 60 * 1000);
        const r = await db
          .delete(messages)
          .where(and(eq(messages.roomId, room.id), lt(messages.createdAt, cutoff)));
        if (r.changes > 0) log.info(`[janitor] purged ${r.changes} messages from "${room.name}" older than ${mins}m`);
      }
    } catch (err) {
      log.error({ err }, "[janitor] message sweep failed");
    }
  }

  /**
   * Auto-promote `user` accounts to `trusted` when they pass low-spam, low-
   * abuse thresholds. Cheap heuristic: account age + message count + no open
   * reports + not currently muted or banned anywhere. Manual demote remains
   * available via the admin user editor.
   *
   * Thresholds are constants for v1; making them admin-tunable is a follow-up.
   */
  const TRUST_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const TRUST_MIN_MESSAGES = 50;
  async function sweepTrustPromotions() {
    try {
      const cutoff = Date.now() - TRUST_AGE_MS;
      // One SQL pass picks all eligible accounts. The NOT EXISTS clauses
      // intentionally use string literals because the enum values aren't
      // user input. Mute "until" is in epoch ms; checking > now skips
      // already-expired mutes that haven't been swept yet.
      const eligible = await db.all<{ id: string; username: string }>(sql`
        SELECT u.id AS id, u.username AS username
        FROM users u
        WHERE u.role = 'user'
          AND u.disabled_at IS NULL
          AND u.created_at < ${cutoff}
          AND u.username != 'system'
          AND (
            SELECT COUNT(*) FROM messages m
            WHERE m.user_id = u.id
              AND m.kind IN ('say', 'me', 'ooc')
          ) >= ${TRUST_MIN_MESSAGES}
          AND NOT EXISTS (
            SELECT 1 FROM reports r
            INNER JOIN messages m2 ON m2.id = r.message_id
            WHERE m2.user_id = u.id
              AND r.status = 'open'
          )
          AND NOT EXISTS (
            SELECT 1 FROM mutes mu
            WHERE mu.user_id = u.id
              AND mu.until > ${Date.now()}
          )
          AND NOT EXISTS (
            SELECT 1 FROM bans b
            WHERE b.user_id = u.id
              AND (b.until IS NULL OR b.until > ${Date.now()})
          )
      `);
      if (eligible.length === 0) return;
      for (const row of eligible) {
        await db.update(users).set({ role: "trusted" }).where(eq(users.id, row.id));
        await recordAudit(db, {
          actorUserId: row.id, // self-attributed; no human actor
          action: "auto_promote_trusted",
          targetUserId: row.id,
          metadata: { trigger: "janitor", thresholdAgeDays: 7, thresholdMessages: TRUST_MIN_MESSAGES },
        });
      }
      log.info(`[janitor] auto-promoted ${eligible.length} users to trusted`);
    } catch (err) {
      log.error({ err }, "[janitor] trust sweep failed");
    }
  }

  /**
   * Snapshot retention sweep. Each backup endpoint already prunes
   * the bucket it just wrote into, but a separate periodic sweep
   * catches buckets where the last write happened long ago (e.g.
   * an install with no recent imports but lots of old manual
   * snapshots). Cheap: synchronous fs stat + a handful of unlinks
   * per call. No-op when the directory doesn't exist.
   */
  function sweepSnapshots() {
    try {
      const r = pruneSnapshots();
      if (r.removed > 0) log.info(`[janitor] removed ${r.removed} aged backup snapshots`);
    } catch (err) {
      log.error({ err }, "[janitor] snapshot prune failed");
    }
  }

  // Run all four immediately on startup so the first sweep doesn't have to wait.
  void sweepSessions();
  void sweepMessages();
  void sweepTrustPromotions();
  sweepSnapshots();
  const sessionId = setInterval(() => void sweepSessions(), 60 * 1000);
  const messageId = setInterval(() => void sweepMessages(), 60 * 60 * 1000);
  const trustId = setInterval(() => void sweepTrustPromotions(), 60 * 60 * 1000);
  const snapshotId = setInterval(() => sweepSnapshots(), 6 * 60 * 60 * 1000);

  // Earning, one-shot historical XP backfill + recurring presence sweep.
  //
  // Backfill is idempotent: the function self-skips when
  // `earningConfig.backfill.completedAt` is already set OR when the
  // configured rate is zero. Failures inside log + continue so a
  // backfill hiccup doesn't block the rest of the janitor.
  //
  // Presence sweep is `null`-tolerant for io so the no-io test path
  // (passed when running migrations without booting socket.io) just
  // skips the schedule.
  void runBackfillIfNeeded(db, log).catch((err) => log.error({ err }, "[earning] backfill failed"));
  let cancelPresence: (() => void) | null = null;
  if (io) {
    void schedulePresenceSweep(db, io, log).then((cancel) => {
      cancelPresence = cancel;
    }).catch((err) => log.error({ err }, "[earning] presence sweep scheduling failed"));
  }

  return () => {
    clearInterval(sessionId);
    clearInterval(messageId);
    clearInterval(trustId);
    clearInterval(snapshotId);
    if (cancelPresence) cancelPresence();
  };
}
