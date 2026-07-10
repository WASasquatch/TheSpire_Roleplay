import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import { markdownToHtml, DEFAULT_FAQS } from "@thekeep/shared";
import {
  emoticonSheets,
  faqs,
  forums,
  messages,
  rooms,
  serverMembers,
  serverSettings,
  servers,
  sessions,
  siteSettings,
  users,
  worldPages,
  worlds,
} from "./db/schema.js";
import { hashPassword } from "./auth/passwords.js";
import { ensureDefaultUsergroup } from "./servers/usergroups.js";
import { ensureSiteSettings, getServerSettings, getSettings, setWorldsSeedVersion } from "./settings.js";
import { DEFAULT_SERVER_ID } from "./earning/pool.js";
import { recordAudit } from "./audit.js";
import { sanitizeBio } from "./auth/html.js";
import { DEFAULT_WORLDS, WORLDS_SEED_VERSION } from "./seed_worlds.js";
import type { Db } from "./db/index.js";
import { sqliteHandle } from "./db/index.js";
import { runBackfillIfNeeded } from "./earning/backfill.js";
import { backfillRoomSlugs } from "./lib/roomSlug.js";
import { schedulePresenceSweep } from "./earning/sweeps.js";
import { scheduleEidolonNudgeSweep } from "./earning/eidolonNudge.js";
import { pruneSnapshots } from "./backup/snapshots.js";
import { archiveDoomedBookmarks } from "./retention/archiveBookmarks.js";
import { ensureForumStarterBoards } from "./forums/starter.js";

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

  // The Spire Forums (system forum container, plan.md Forums Phase 0).
  // Always-on + idempotent (keys on a fixed id, can never duplicate).
  // Migration 0229 already created it on installs that had an admin at
  // migration time; this covers fresh installs where migrations ran
  // before any user existed.
  await ensureSystemForum(db);

  // The Spire (system DEFAULT server, Servers Lift Phase 1/2). Always-on +
  // idempotent (fixed id, can never duplicate). Migration 0279 creates it on
  // installs that had an admin at migration time; this covers fresh installs
  // where migrations ran before any user existed (and, as a safe superset,
  // converges to the same end state as 0279 on a fresh DB — see the function
  // doc). Runs AFTER ensureSystemForum so a same-boot fresh install already
  // has the system forum to re-home under the new default server if needed.
  await ensureSystemServer(db);

  // Platform FAQ starter set — the default FAQ that ships with the app, inserted
  // as real, admin-editable rows so it's a first-class part of the FAQ system
  // (shown on /faqs in-app + public, manageable/removable in the FAQ admin tab).
  // MUST run AFTER ensureSystemServer: `faqs.server_id` FKs to servers(id) with
  // foreign_keys=ON, so the default server row has to exist before we can insert
  // server-scoped rows. Always-on + idempotent (adopts orphans, seeds only when
  // empty) — ungated by SKIP_DEFAULT_SEED like the other ensure* helpers.
  await ensureDefaultFaqs(db);

  // Bare-forum repair: forums provisioned before the approve path seeded
  // starter furniture (or later emptied of every board) are dead ends — no
  // board means no New Topic affordance and nothing for the posting tour to
  // point at. Idempotent (only fires on zero-live-board forums); shares the
  // exact seeder the approve path uses.
  await ensureForumStarterBoards(db);

  // Force-reseed the `{icon}` placeholder on item-message templates
  // when the deploy script (remote-deploy.sh) staged the flag. Always
  // ungated by SKIP_DEFAULT_SEED, that flag governs the room-rename
  // edge case; item-template policy is a separate concern.
  await maybeReseedItemTemplates(db);

  // Backfill room slugs (migration 0260). Runs AFTER every room-creating
  // seed above (default rooms + system forum boards) so freshly-seeded
  // rooms get a slug the same boot. Idempotent + cheap when there's
  // nothing to fill (a single SELECT). Also catches any runtime create
  // path that didn't set a slug, so {room:<slug>} links never miss.
  await backfillRoomSlugs(db);

  // Boot-time server data-integrity asserts (plan.md §9.7). LOG-and-continue
  // ONLY — never throws — so a violated invariant surfaces loudly in the logs
  // without bricking startup. Runs LAST so it observes the post-seed end state
  // (ensureSystemServer + its adoption/backfill above have already settled).
  assertServerInvariants(db);
}

/**
 * Ensure "The Spire Forums" — the site-owned system forum that anchors the
 * Forums Catalog — exists. Mirrors migration 0229 exactly (same fixed id,
 * slug, copy) so whichever of the two runs first wins and the other no-ops.
 *
 * Owner = the oldest masteradmin (falling back to the oldest admin). When
 * neither exists yet (fresh install before first registration), we skip and
 * retry on the next boot — the catalog requires the forum but nothing
 * crashes without it, and installs promote a masteradmin almost
 * immediately. NOT keyed on SKIP_DEFAULT_SEED: that flag exists for the
 * renamed-default-rooms case; a fixed-id insert can never duplicate.
 *
 * Deliberately does NOT adopt nested rooms (0229 does that once for
 * existing installs): re-adopting on every boot would yank a standalone
 * nested room a user created via /replymode into the public forum.
 */
async function ensureSystemForum(db: Db): Promise<void> {
  const existing = (await db.select({ id: forums.id }).from(forums)
    .where(eq(forums.id, "forum_spire_system")).limit(1))[0];
  if (existing) return;
  const owner = (await db.select({ id: users.id }).from(users)
    .where(sql`${users.role} IN ('masteradmin', 'admin')`)
    .orderBy(sql`CASE ${users.role} WHEN 'masteradmin' THEN 0 ELSE 1 END`, users.createdAt)
    .limit(1))[0];
  if (!owner) return; // retried next boot once an admin exists
  await db.insert(forums).values({
    id: "forum_spire_system",
    slug: "spire",
    name: "The Spire Forums",
    tagline: "The Spire's town square: announcements, roleplay boards, and community talk.",
    ownerUserId: owner.id,
    isSystem: true,
    status: "active",
    visibility: "public",
    postingMode: "open",
  });
}

/**
 * Ensure "The Spire" — the site-owned system DEFAULT server that every signed-in
 * user is implicitly a member of (Servers Lift Phase 1/2, plan.md §6.5). A clone
 * of {@link ensureSystemForum}: fixed id `server_spire_system`, `is_system` +
 * `is_default`, public, open-join, owner re-resolved to the oldest real admin.
 *
 * Owner = the oldest masteradmin, falling back to the oldest admin (excluding the
 * `system` sentinel). When NO admin exists yet (fresh install before the first
 * registration) we skip and log — a later boot re-resolves it once an admin is
 * promoted, exactly as ensureSystemForum does. Nothing crashes without the
 * server: serverAuthority treats a missing/NULL server_id as the default at the
 * application layer, so single-tenant behavior is unchanged until it lands.
 *
 * SAFE SUPERSET OF MIGRATION 0279. On an install that already had an admin at
 * migration time, 0279 inserts the row (and seeds settings / usergroup / owner
 * member row / adopts orphan rooms+forums); this function then no-ops on the
 * fixed id. On a FRESH install (migrations ran before any user existed, so 0279
 * inserted ZERO rows), 0279 left nothing behind — so when WE create the row here
 * we must converge to the same end state 0279 would have produced:
 *   (1) seed server_settings from the singleton (the re-homed behavior slice);
 *   (2) ensure the default usergroup (full FEATURE baseline);
 *   (3) write the owner's explicit server_members row (role 'owner');
 *   (4) adopt any rooms / forums still server_id NULL into the default server.
 * All four steps are insert-if-missing / NULL-only updates, so re-running is a
 * no-op and the 0279-already-ran path is never disturbed.
 *
 * NOT keyed on SKIP_DEFAULT_SEED: that flag exists for the renamed-default-rooms
 * case; a fixed-id insert can never duplicate.
 */
async function ensureSystemServer(db: Db): Promise<void> {
  const existing = (await db.select({ id: servers.id }).from(servers)
    .where(eq(servers.id, "server_spire_system")).limit(1))[0];
  if (existing) return; // 0279 (or a prior boot) already created it.

  // Oldest masteradmin, else oldest admin. Exclude the `system` sentinel
  // explicitly: it carries role 'admin' but must never own a server.
  const owner = (await db.select({ id: users.id }).from(users)
    .where(sql`${users.role} IN ('masteradmin', 'admin') AND ${users.username} != 'system' AND ${users.id} != 'system'`)
    .orderBy(sql`CASE ${users.role} WHEN 'masteradmin' THEN 0 ELSE 1 END`, users.createdAt)
    .limit(1))[0];
  if (!owner) {
    // Fresh install before the first admin exists. Skip and let a later boot
    // re-resolve the owner — mirrors ensureSystemForum's retry posture.
    console.warn("[server-invariant] system server not created yet: no admin exists to own it (will retry next boot)");
    return;
  }

  // Create the fixed-id default server. featured = catalog-pinned at the top;
  // is_system + is_default mark it undeletable and the auto-join target.
  await db.insert(servers).values({
    id: "server_spire_system",
    slug: "the-spire",
    name: "The Spire",
    tagline: "The beacon-tower where the universe arrives.",
    ownerUserId: owner.id,
    isSystem: true,
    isDefault: true,
    status: "featured",
    visibility: "public",
    joinMode: "open",
  });

  // (1) Seed the per-server behavior settings from the singleton so the default
  // server is byte-identical to the legacy global config (the re-homed slice
  // 0276 split out). Copying the concrete values (rather than leaving NULL =
  // inherit) makes the default server's numbers survive a later singleton edit
  // exactly as 0279 freezes them at backfill time.
  const site = (await db.select().from(siteSettings).where(eq(siteSettings.id, "singleton")).limit(1))[0];
  if (site) {
    await db.insert(serverSettings).values({
      serverId: "server_spire_system",
      messageRetentionMs: site.messageRetentionMs,
      maxRoomsPerOwner: site.maxRoomsPerOwner,
      maxMessageLength: site.maxMessageLength,
      editGraceMs: site.editGraceMs,
      defaultThemeJson: site.defaultThemeJson,
      defaultStyleKey: site.defaultStyleKey,
      themeDesignMap: site.themeDesignMap,
      rulesHtml: site.rulesHtml,
      securityNoticeHtml: site.securityNoticeHtml,
      newUserWelcomeHtml: site.newUserWelcomeHtml,
      maxForumPostLength: site.maxForumPostLength,
      forumTopicsPerPage: site.forumTopicsPerPage,
      earningConfigJson: site.earningConfigJson,
    }).onConflictDoNothing();
  }

  // (2) Default usergroup (full FEATURE baseline) so ungrouped members keep
  // post / create-room / upload / emoticon / invite, exactly like every fresh
  // server. ensureDefaultUsergroup is itself conflict-safe + insert-if-missing.
  await ensureDefaultUsergroup(db, "server_spire_system");

  // (3) Owner's explicit server_members row. The default server's access is the
  // implicit is_system rule (serverAuthority short-circuits), so this row is a
  // management-enumeration convenience — but the owner needs role='owner' to
  // appear in their own roster / pass requireServerOwner. INSERT OR IGNORE.
  await db.insert(serverMembers).values({
    serverId: "server_spire_system",
    userId: owner.id,
    role: "owner",
  }).onConflictDoNothing();

  // (4) Adopt every still-orphaned room + forum into the default server (the
  // 0279 backfill on a fresh DB). NULL-only so a room/forum already homed to
  // another server is never yanked. On a truly fresh install this is the set of
  // rooms ensureSystemSeeds just created + the system forum's boards.
  await db.update(rooms).set({ serverId: "server_spire_system" }).where(sql`${rooms.serverId} IS NULL`);
  await db.update(forums).set({ serverId: "server_spire_system" }).where(sql`${forums.serverId} IS NULL`);
}

/**
 * Seed the platform (default server) FAQ — the default FAQ that ships with the
 * app. Idempotent + always-on:
 *   (1) Adopt any orphaned platform FAQ (server_id NULL — a pre-per-server seed
 *       or a global-admin create that didn't set it) onto the default server so
 *       it becomes visible on /faqs (which scopes to DEFAULT_SERVER_ID).
 *   (2) Seed the shared DEFAULT_FAQS starter set ONLY when the default server has
 *       no FAQ yet, so a fresh install ships real, admin-editable /faqs content
 *       and any admin edit / reorder / delete on later boots is never clobbered.
 *
 * The rows are REAL FAQ entries (not a display fallback): they show on /faqs
 * in-app + public and are fully manageable in the FAQ admin tab. Delete them all
 * and /faqs is genuinely empty — nothing resurrects them.
 *
 * MUST run AFTER ensureSystemServer: faqs.server_id FKs to servers(id) with
 * foreign_keys=ON, so we no-op safely when the default server isn't there yet
 * (a truly fresh install with no admin to own it — retried next boot). This
 * ordering is the whole fix: the old inline block ran BEFORE ensureSystemServer,
 * so on a boot where the row didn't pre-exist it silently skipped and /faqs
 * stayed blank. Markdown → sanitized HTML mirrors the FAQ admin route. NOT gated
 * by SKIP_DEFAULT_SEED (that flag is for the renamed-default-rooms case; keyed
 * inserts can't duplicate).
 */
async function ensureDefaultFaqs(db: Db): Promise<void> {
  const defaultServerRow = (await db
    .select({ id: servers.id })
    .from(servers)
    .where(eq(servers.id, DEFAULT_SERVER_ID))
    .limit(1))[0];
  if (!defaultServerRow) {
    console.warn("[seed] default FAQ not seeded yet: system server row is missing (will retry next boot)");
    return; // FK guard: no default server yet.
  }

  // (1) Adopt orphaned platform FAQs (idempotent: only touches NULL rows).
  await db.update(faqs).set({ serverId: DEFAULT_SERVER_ID }).where(isNull(faqs.serverId));

  // (2) Seed the starter set only when the default server has none yet.
  const hasDefaultFaq = (await db
    .select({ id: faqs.id })
    .from(faqs)
    .where(eq(faqs.serverId, DEFAULT_SERVER_ID))
    .limit(1))[0];
  if (hasDefaultFaq) return;

  let faqOrder = 0;
  for (const def of DEFAULT_FAQS) {
    await db.insert(faqs).values({
      id: nanoid(),
      slug: def.slug,
      question: def.question,
      answerMarkdown: def.answerMarkdown,
      answerHtml: sanitizeBio(markdownToHtml(def.answerMarkdown)),
      category: def.category,
      sortOrder: faqOrder++,
      enabled: true,
      createdByUserId: "system",
      serverId: DEFAULT_SERVER_ID,
    }).onConflictDoNothing();
  }
  console.log(`[seed] seeded ${DEFAULT_FAQS.length} default FAQ entries for the platform server`);
}

/**
 * Boot-time server data-integrity asserts (plan.md §9.7). Verifies the four
 * post-migration / post-seed invariants and LOGS each violation with a clear
 * `[server-invariant]` prefix. CRITICAL: this NEVER throws — a violated
 * invariant is a loud log line, not a startup crash, so a single bad row can't
 * brick the whole site. Every check is wrapped so even an unexpected SQL error
 * (e.g. a column the migration didn't add yet) degrades to a warning.
 *
 * Synchronous on purpose (the §9.7 signature): it reaches the raw better-sqlite3
 * handle ({@link sqliteHandle}, the documented escape hatch for PRAGMA /
 * one-off integrity SQL) rather than the async drizzle wrapper, so the whole
 * sweep runs inline at the tail of ensureSystemSeeds with no awaits.
 *
 * The four invariants:
 *   (1) ZERO rooms with BOTH server_id NULL AND forum_id NULL — every room must
 *       be reachable through some server (directly, or via its forum's server).
 *   (2) AT MOST ONE is_default room per server (the partial unique index already
 *       enforces this, but we re-assert in case a legacy index drop regressed).
 *   (3) server_spire_system EXISTS and is is_system=1 — the default server the
 *       whole NULL-adoption story depends on.
 *   (4) Every one of the nine 0278 discriminator columns is PRESENT (the
 *       baseline-trap guard from §9.3 — a partial 0278 apply would silently
 *       skip later ADD COLUMNs).
 */
function assertServerInvariants(db: Db): void {
  // `db` is accepted for signature symmetry with the other seed helpers; the
  // checks deliberately use the raw sync handle so this stays a plain function.
  void db;
  const warn = (msg: string) => console.warn(`[server-invariant] ${msg}`);

  // (1) Rooms with neither a server nor a forum home.
  try {
    const row = sqliteHandle
      .prepare("SELECT COUNT(*) AS n FROM rooms WHERE server_id IS NULL AND forum_id IS NULL")
      .get() as { n: number } | undefined;
    if (row && row.n > 0) {
      warn(`${row.n} room(s) have BOTH server_id NULL AND forum_id NULL — unreachable by any server (expected 0)`);
    }
  } catch (err) {
    warn(`could not check rooms-without-home invariant: ${(err as Error).message}`);
  }

  // (2) More than one is_default room within a single server.
  try {
    const rows = sqliteHandle
      .prepare(
        "SELECT server_id AS s, COUNT(*) AS n FROM rooms WHERE is_default = 1 AND server_id IS NOT NULL GROUP BY server_id HAVING COUNT(*) > 1",
      )
      .all() as Array<{ s: string; n: number }>;
    for (const r of rows) {
      warn(`server ${r.s} has ${r.n} is_default rooms (expected at most 1)`);
    }
  } catch (err) {
    warn(`could not check one-default-room-per-server invariant: ${(err as Error).message}`);
  }

  // (3) The system DEFAULT server exists and is flagged is_system.
  try {
    const row = sqliteHandle
      .prepare("SELECT is_system AS isSystem FROM servers WHERE id = 'server_spire_system'")
      .get() as { isSystem: number } | undefined;
    if (!row) {
      // Expected on a fresh install before the first admin exists (the server is
      // created on a later boot); still worth surfacing so a persistent absence
      // on an admin'd install is visible.
      warn("server_spire_system is missing (will be created on a later boot once an admin exists)");
    } else if (row.isSystem !== 1) {
      warn("server_spire_system exists but is NOT is_system=1 — the default-server NULL-adoption story is broken");
    }
  } catch (err) {
    warn(`could not check system-server invariant: ${(err as Error).message}`);
  }

  // (3b) The system DEFAULT server stays SFW (age plan, Phase 2). The
  // flagship partition puts the adult side in a SIBLING "NSFW" server; the
  // home server 18+ would strand minors with no landing anywhere. The
  // settings route refuses the write — this catches a manual DB edit. Like
  // every invariant here it WARNS and self-heals rather than crashing:
  // clearing the flag is always the safe direction (it only widens access
  // back to the documented state).
  try {
    const row = sqliteHandle
      .prepare("SELECT is_nsfw AS isNsfw FROM servers WHERE id = 'server_spire_system'")
      .get() as { isNsfw: number } | undefined;
    if (row && row.isNsfw === 1) {
      warn("server_spire_system was flagged is_nsfw=1 — the home server must stay SFW; clearing it");
      sqliteHandle.prepare("UPDATE servers SET is_nsfw = 0 WHERE id = 'server_spire_system'").run();
    }
  } catch (err) {
    warn(`could not check system-server SFW invariant: ${(err as Error).message}`);
  }

  // (4) Every 0278 discriminator column present (the §9.3 baseline-trap guard).
  // table -> the server_id-bearing discriminator added in 0278a..0278i.
  const DISCRIMINATOR_TABLES = [
    "audit_log", // 0278a
    "mod_cases", // 0278b
    "reports", // 0278c
    "announcement_banners", // 0278d
    "scheduled_announcements", // 0278e
    "faqs", // 0278f
    "emoticon_sheets", // 0278g
    "custom_commands", // 0278h
    "title_kinds", // 0278i
  ];
  for (const table of DISCRIMINATOR_TABLES) {
    try {
      // PRAGMA arg can't be bound, but the table name is a hard-coded literal
      // from the list above (never user input), so the interpolation is safe.
      const cols = sqliteHandle.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (cols.length === 0) {
        warn(`table ${table} not found while checking for its server_id discriminator column`);
        continue;
      }
      if (!cols.some((c) => c.name === "server_id")) {
        warn(`table ${table} is MISSING its 0278 server_id discriminator column (partial migration apply?)`);
      }
    } catch (err) {
      warn(`could not check server_id column on ${table}: ${(err as Error).message}`);
    }
  }
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
      // Retention is now PER-SERVER: each server's rooms purge at that server's
      // own `messageRetentionMs` (NULL override inherits the platform default).
      // We bucket the live, non-nested rooms by their effective server (a NULL
      // `rooms.serverId`, legacy/standalone, homes to DEFAULT_SERVER_ID) and run
      // one scoped DELETE per server with that server's cutoff. With the flag
      // off there is only the system server, whose seeded settings equal the
      // platform values, so this purges exactly what the old single global
      // sweep did — byte-identical.
      //
      // Nested-mode rooms are forum threads, by design persistent ("Persistent
      // forum topics for long-lived games"). Exempt them unconditionally so a
      // retention sweep can never gut a forum overnight regardless of how short
      // a server's retention is configured. Flipping a room flat → nested is
      // the admin's signal that its history must not be auto-purged.
      const sweepRooms = await db
        .select({ id: rooms.id, serverId: rooms.serverId })
        .from(rooms)
        .where(sql`${rooms.replyMode} != 'nested' OR ${rooms.replyMode} IS NULL`);
      const roomsByServer = new Map<string, string[]>();
      for (const room of sweepRooms) {
        const sid = room.serverId ?? DEFAULT_SERVER_ID;
        const list = roomsByServer.get(sid);
        if (list) list.push(room.id);
        else roomsByServer.set(sid, [room.id]);
      }
      for (const [serverId, roomIds] of roomsByServer) {
        const { messageRetentionMs } = await getServerSettings(db, serverId);
        if (messageRetentionMs <= 0 || roomIds.length === 0) continue;
        const cutoff = new Date(Date.now() - messageRetentionMs);
        const doomed = and(
          lt(messages.createdAt, cutoff),
          inArray(messages.roomId, roomIds),
        );
        // Snapshot-archive bookmarks BEFORE the hard delete drops the rows.
        await archiveDoomedBookmarks(db, doomed);
        const r = await db.delete(messages).where(doomed);
        if (r.changes > 0) log.info(`[janitor] purged ${r.changes} messages older than retention window (server ${serverId})`);
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
        const doomed = and(eq(messages.roomId, room.id), lt(messages.createdAt, cutoff));
        // Snapshot-archive bookmarks BEFORE the hard delete drops the rows.
        await archiveDoomedBookmarks(db, doomed);
        const r = await db.delete(messages).where(doomed);
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
            SELECT 1 FROM account_mutes am
            WHERE am.user_id = u.id
              AND am.until > ${Date.now()}
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
  let cancelEidolonNudge: (() => void) | null = null;
  if (io) {
    void schedulePresenceSweep(db, io, log).then((cancel) => {
      cancelPresence = cancel;
    }).catch((err) => log.error({ err }, "[earning] presence sweep scheduling failed"));
    void scheduleEidolonNudgeSweep(db, io, log).then((cancel) => {
      cancelEidolonNudge = cancel;
    }).catch((err) => log.error({ err }, "[eidolon] nudge sweep scheduling failed"));
  }

  return () => {
    clearInterval(sessionId);
    clearInterval(messageId);
    clearInterval(trustId);
    clearInterval(snapshotId);
    if (cancelPresence) cancelPresence();
    if (cancelEidolonNudge) cancelEidolonNudge();
  };
}
