import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq, isNull, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  FLAIR_PROFILE_MARQUEE_KEY,
  FLAIR_PROFILE_VISITORS_KEY,
  PROFILE_MARQUEE_MAX_QUOTES,
  PROFILE_MARQUEE_QUOTE_MAX_LEN,
  parseProfileMarqueeQuotes,
  serializeProfileMarqueeQuotes,
  type ProfileMarqueeConfig,
  type ProfileVisitorOwnerSummary,
  type ProfileVisitorStats,
} from "@thekeep/shared";
import {
  characterEarning,
  characters,
  earningLedger,
  profileViews,
  userEarning,
  users,
} from "../db/schema.js";
import type { Db } from "../db/index.js";
import { getSessionUser } from "./auth.js";
import { recordAudit } from "../audit.js";

/**
 * Two profile-customization Flair surfaces (migration 0192):
 *
 *   `flair_profile_visitors` — profile view tracking + a counter
 *     widget the owner can show or hide on their public profile.
 *
 *   `flair_profile_marquee` — rotating-quote strip between the
 *     profile header and the body sections.
 *
 * Endpoints here are split into three layers:
 *
 *   - **Public read**   (`GET /profiles/:name/marquee`,
 *     `GET /profiles/:name/visitor-stats`) — viewer-facing fetches
 *     the client paints on the public profile. Respect the owner's
 *     visibility toggle for the visitor count; the marquee fetch
 *     simply returns empty when the owner doesn't own the flair.
 *
 *   - **Public write**  (`POST /profiles/:name/view`) — log the
 *     viewer once per day per identity. Always-on regardless of
 *     whether the owner has the flair, so the counter has data
 *     the moment they equip it.
 *
 *   - **Owner CRUD**    (`GET / PUT /me/profile-flair`) — bundle
 *     ownership + current quotes + visibility + stats in one shot
 *     for the editor. Save accepts a single PUT that updates both
 *     the marquee body + visibility toggle on the right identity
 *     (master vs character) per the `characterId` query string.
 */
export async function registerProfileFlairRoutes(
  app: FastifyInstance,
  db: Db,
): Promise<void> {
  /* ---------- Public reads ---------- */

  // Marquee body. Returns the (sanitized-on-write) quotes the owner
  // configured, OR an empty array when:
  //   - the lookup name doesn't resolve to any profile
  //   - the owner doesn't own `flair_profile_marquee`
  //   - the profile is non-public OR flagged NSFW AND the caller
  //     isn't signed in (mirrors the existing /profiles/:name
  //     visibility gate so quote content doesn't leak past the
  //     auth-wall a private profile already enforces)
  app.get<{ Params: { name: string }; Querystring: { characterId?: string } }>(
    "/profiles/:name/marquee",
    async (req) => {
      const identity = await resolveProfileIdentity(db, req.params.name, req.query.characterId ?? null);
      if (!identity) return { quotes: [] satisfies string[] };
      const me = await getSessionUser(req, db);
      if (!(await callerMayReadProfile(db, identity, me?.id ?? null))) {
        return { quotes: [] satisfies string[] };
      }
      const owns = await ownsFlair(db, FLAIR_PROFILE_MARQUEE_KEY, identity);
      if (!owns) return { quotes: [] satisfies string[] };
      const row = await readEarningRow(db, identity);
      return { quotes: parseProfileMarqueeQuotes(row?.profileMarqueeQuotesJson ?? null) };
    },
  );

  // Visitor counts. The owner's visibility toggle gates the
  // PUBLIC payload — when off, non-owner callers see `visible:
  // false` and zero counts. Same visibility gate as the marquee
  // above so a private profile doesn't leak a "5 people viewed"
  // signal through the API even when the owner has flipped the
  // counter on for the in-app audience.
  app.get<{ Params: { name: string }; Querystring: { characterId?: string } }>(
    "/profiles/:name/visitor-stats",
    async (req) => {
      const identity = await resolveProfileIdentity(db, req.params.name, req.query.characterId ?? null);
      if (!identity) return emptyStatsPayload();
      const me = await getSessionUser(req, db);
      if (!(await callerMayReadProfile(db, identity, me?.id ?? null))) {
        return emptyStatsPayload();
      }
      const owns = await ownsFlair(db, FLAIR_PROFILE_VISITORS_KEY, identity);
      if (!owns) return emptyStatsPayload();
      const row = await readEarningRow(db, identity);
      const visible = row?.showProfileVisitorsCount ?? false;
      if (!visible) return emptyStatsPayload();
      return {
        visible: true,
        stats: await computeVisitorStats(db, identity),
      };
    },
  );

  /* ---------- Public write: view logging ---------- */

  // Log a view with day-bucket dedupe. ALWAYS-ON (we count even when
  // the owner hasn't bought the flair yet so the moment they do, the
  // count has data). Caller never sees the result of the dedupe;
  // every successful call returns `ok:true` regardless of whether
  // a row was actually inserted. Self-views (owner viewing their
  // own profile) are NOT logged.
  app.post<{ Params: { name: string }; Querystring: { characterId?: string } }>(
    "/profiles/:name/view",
    async (req) => {
      const identity = await resolveProfileIdentity(db, req.params.name, req.query.characterId ?? null);
      if (!identity) return { ok: false as const, reason: "not_found" };
      const me = await getSessionUser(req, db);
      // Owner self-view never counts — keeps the metric honest.
      if (me && me.id === identity.userId) return { ok: true as const, self: true as const };
      // Embed profile context (master vs which character) into the
      // viewer key so the UNIQUE constraint can dedupe a master
      // profile view independently from a character profile view
      // by the SAME viewer on the SAME day. Without this fold,
      // the constraint sat on a nullable column and SQLite's
      // NULL-distinct semantics let master profile views log
      // multiple times per day.
      const profileSuffix = identity.characterId ? `c:${identity.characterId}` : "m";
      const viewerKey = `${me?.id ?? anonymousFingerprint(req)}#${profileSuffix}`;
      const now = Date.now();
      const dayBucket = Math.floor(now / 86_400_000);
      try {
        // `INSERT OR IGNORE` makes the dedupe a no-op on conflict;
        // the unique constraint over (profile, viewer_key, day) is
        // what makes "F5 spam" a one-time count.
        await db
          .insert(profileViews)
          .values({
            id: nanoid(),
            profileUserId: identity.userId,
            profileCharacterId: identity.characterId,
            viewerUserId: me?.id ?? null,
            viewerKey,
            dayBucket,
          })
          .onConflictDoNothing();
      } catch {
        /* swallow — log-only path; client shouldn't see this */
      }
      return { ok: true as const };
    },
  );

  /* ---------- Owner CRUD ---------- */

  // Owner-side bundle the editor reads. Carries ownership flags +
  // current quotes + the visibility toggle + the always-on count
  // (the owner sees their stats whether visibility is on or off,
  // because the toggle gates PUBLIC display, not their own view).
  app.get<{ Querystring: { characterId?: string } }>(
    "/me/profile-flair",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const identity = await resolveOwnerIdentity(db, me.id, req.query.characterId ?? null);
      if (!identity) { reply.code(404); return { error: "no identity" }; }
      const ownsMarquee = await ownsFlair(db, FLAIR_PROFILE_MARQUEE_KEY, identity);
      const ownsVisitors = await ownsFlair(db, FLAIR_PROFILE_VISITORS_KEY, identity);
      const row = await readEarningRow(db, identity);
      const stats = await computeVisitorStats(db, identity);
      const visible = row?.showProfileVisitorsCount ?? false;
      const quotes = parseProfileMarqueeQuotes(row?.profileMarqueeQuotesJson ?? null);
      const marquee: ProfileMarqueeConfig = { quotes, ownsFlair: ownsMarquee };
      const visitors: ProfileVisitorOwnerSummary = {
        ...stats,
        visible,
        ownsFlair: ownsVisitors,
      };
      return { marquee, visitors };
    },
  );

  // Owner save — combined PUT covers both quotes + visibility.
  // Each field is independently optional + each gated on its OWN
  // flair ownership. So an owner of just the marquee can still
  // PUT a quotes update; the visibility field rejects (gracefully)
  // if they don't own the visitors flair.
  const saveSchema = z.object({
    quotes: z.array(z.string().max(PROFILE_MARQUEE_QUOTE_MAX_LEN)).max(PROFILE_MARQUEE_MAX_QUOTES).optional(),
    showVisitorsCount: z.boolean().optional(),
  }).strict();

  app.put<{ Querystring: { characterId?: string }; Body: unknown }>(
    "/me/profile-flair",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const identity = await resolveOwnerIdentity(db, me.id, req.query.characterId ?? null);
      if (!identity) { reply.code(404); return { error: "no identity" }; }
      const body = saveSchema.parse(req.body);

      const patch: Record<string, unknown> = { updatedAt: new Date() };

      if (body.quotes !== undefined) {
        if (!(await ownsFlair(db, FLAIR_PROFILE_MARQUEE_KEY, identity))) {
          reply.code(403);
          return { error: "You don't own the Profile Quote Marquee Flair." };
        }
        patch.profileMarqueeQuotesJson = serializeProfileMarqueeQuotes(body.quotes);
      }

      if (body.showVisitorsCount !== undefined) {
        if (!(await ownsFlair(db, FLAIR_PROFILE_VISITORS_KEY, identity))) {
          reply.code(403);
          return { error: "You don't own the Profile Visitor Counter Flair." };
        }
        patch.showProfileVisitorsCount = body.showVisitorsCount;
      }

      // Upsert: most identities already have an earning row from a
      // prior award, but a brand-new character may not. The bare
      // insert covers that case, and `onConflictDoUpdate` flips to
      // the patch shape on existing rows.
      await upsertEarningRow(db, identity, patch);

      // Audit — one row per touched surface so the log reflects the
      // owner's exact intent rather than a vague "they saved their
      // profile flair." Lets admins separate marquee vandalism
      // reports from visibility-toggle abuse without re-reading
      // every metadata blob.
      if (body.quotes !== undefined) {
        await recordAudit(db, {
          actorUserId: me.id,
          action: "profile_marquee_update",
          metadata: {
            characterId: identity.characterId,
            quoteCount: (patch.profileMarqueeQuotesJson as string | null | undefined)
              ? body.quotes.filter((q) => q.trim().length > 0).length
              : 0,
          },
        });
      }
      if (body.showVisitorsCount !== undefined) {
        await recordAudit(db, {
          actorUserId: me.id,
          action: "profile_visitors_visibility_update",
          metadata: {
            characterId: identity.characterId,
            visible: body.showVisitorsCount,
          },
        });
      }
      return { ok: true as const };
    },
  );
}

/* ============================================================
 *  Identity resolution + helpers
 * ============================================================ */

interface ProfileIdentity {
  /** Master account id. ALWAYS populated. */
  userId: string;
  /** Character id when the lookup resolved to a character profile;
   *  null = master/OOC profile. */
  characterId: string | null;
}

/** Resolve a public `/p/<name>` lookup to a master+character pair.
 *  Optional `characterIdQs` lets the client say "the character
 *  view of this username" when a master + character share names
 *  (rare, but possible). */
async function resolveProfileIdentity(
  db: Db,
  rawName: string,
  characterIdQs: string | null,
): Promise<ProfileIdentity | null> {
  // Character match takes precedence so `/p/<charname>` lands on
  // the character row. Fall back to master lookup when no live
  // character matches. Mirrors the existing lookupProfile posture.
  const name = decodeURIComponent(rawName).trim();
  if (characterIdQs) {
    const c = (await db
      .select({ id: characters.id, userId: characters.userId })
      .from(characters)
      .where(eq(characters.id, characterIdQs))
      .limit(1))[0];
    if (c) return { userId: c.userId, characterId: c.id };
  }
  const c = (await db
    .select({ id: characters.id, userId: characters.userId })
    .from(characters)
    .where(and(
      sql`lower(${characters.name}) = lower(${name})`,
      isNull(characters.deletedAt),
    ))
    .limit(1))[0];
  if (c) return { userId: c.userId, characterId: c.id };

  const u = (await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.username}) = lower(${name})`)
    .limit(1))[0];
  if (u) return { userId: u.id, characterId: null };
  return null;
}

/** Owner-side identity resolution. The querystring is the
 *  authoritative selector here (the user can be voicing any of
 *  their characters or OOC). */
async function resolveOwnerIdentity(
  db: Db,
  userId: string,
  characterIdQs: string | null,
): Promise<ProfileIdentity | null> {
  if (!characterIdQs) return { userId, characterId: null };
  const c = (await db
    .select({ id: characters.id })
    .from(characters)
    .where(and(
      eq(characters.id, characterIdQs),
      eq(characters.userId, userId),
      isNull(characters.deletedAt),
    ))
    .limit(1))[0];
  if (!c) return null;
  return { userId, characterId: c.id };
}

/**
 * Visibility gate mirroring the existing `/profiles/:name`
 * `restricted && !me` rule: a non-public OR NSFW-flagged profile
 * is invisible to anonymous callers, so its derived flair surfaces
 * (marquee, visitor counter) must also stay invisible. The owner
 * themselves AND any signed-in viewer pass through — same posture
 * the main profile endpoint uses for the "members can see" tier.
 *
 * Reads the row's flags off the master (`users.isPublic` /
 * `users.isNsfw`) for master profiles, off the matching
 * `characters` row for character profiles. NULLs default to
 * "public" so the gate stays permissive when a column is missing
 * (existing rows pre-flag-column).
 */
async function callerMayReadProfile(
  db: Db,
  identity: ProfileIdentity,
  viewerUserId: string | null,
): Promise<boolean> {
  if (viewerUserId) return true; // any signed-in viewer satisfies "members can see"
  if (identity.characterId) {
    const c = (await db
      .select({ isPublic: characters.isPublic, isNsfw: characters.isNsfw })
      .from(characters)
      .where(eq(characters.id, identity.characterId))
      .limit(1))[0];
    if (!c) return false;
    return !!c.isPublic && !c.isNsfw;
  }
  const u = (await db
    .select({ isPublic: users.isPublic, isNsfw: users.isNsfw })
    .from(users)
    .where(eq(users.id, identity.userId))
    .limit(1))[0];
  if (!u) return false;
  return !!u.isPublic && !u.isNsfw;
}

/** Ownership check — looks for the `purchase_<key>` ledger row
 *  scoped to the right pool. Mirrors the convention every other
 *  flair uses. */
async function ownsFlair(db: Db, key: string, identity: ProfileIdentity): Promise<boolean> {
  const reason = `purchase_${key}`;
  if (identity.characterId) {
    const row = (await db
      .select({ id: earningLedger.id })
      .from(earningLedger)
      .where(and(
        eq(earningLedger.scope, "character"),
        eq(earningLedger.ownerId, identity.characterId),
        eq(earningLedger.reason, reason),
      ))
      .limit(1))[0];
    return !!row;
  }
  const row = (await db
    .select({ id: earningLedger.id })
    .from(earningLedger)
    .where(and(
      eq(earningLedger.scope, "user"),
      eq(earningLedger.ownerId, identity.userId),
      eq(earningLedger.reason, reason),
    ))
    .limit(1))[0];
  return !!row;
}

interface EarningRowSnapshot {
  profileMarqueeQuotesJson: string | null;
  showProfileVisitorsCount: boolean;
}
async function readEarningRow(db: Db, identity: ProfileIdentity): Promise<EarningRowSnapshot | null> {
  if (identity.characterId) {
    const r = (await db
      .select({
        profileMarqueeQuotesJson: characterEarning.profileMarqueeQuotesJson,
        showProfileVisitorsCount: characterEarning.showProfileVisitorsCount,
      })
      .from(characterEarning)
      .where(eq(characterEarning.characterId, identity.characterId))
      .limit(1))[0];
    return r ?? null;
  }
  const r = (await db
    .select({
      profileMarqueeQuotesJson: userEarning.profileMarqueeQuotesJson,
      showProfileVisitorsCount: userEarning.showProfileVisitorsCount,
    })
    .from(userEarning)
    .where(eq(userEarning.userId, identity.userId))
    .limit(1))[0];
  return r ?? null;
}

async function upsertEarningRow(
  db: Db,
  identity: ProfileIdentity,
  patch: Record<string, unknown>,
): Promise<void> {
  if (identity.characterId) {
    const existing = (await db
      .select({ id: characterEarning.characterId })
      .from(characterEarning)
      .where(eq(characterEarning.characterId, identity.characterId))
      .limit(1))[0];
    if (existing) {
      await db
        .update(characterEarning)
        .set(patch)
        .where(eq(characterEarning.characterId, identity.characterId));
    } else {
      // Bare insert — the earning row carries lots of NOT-NULL
      // columns with defaults, so the patch keys + the FK key are
      // enough for SQLite to fill the rest from column defaults.
      await db.insert(characterEarning).values({
        characterId: identity.characterId,
        ...patch,
      } as typeof characterEarning.$inferInsert);
    }
    return;
  }
  const existing = (await db
    .select({ id: userEarning.userId })
    .from(userEarning)
    .where(eq(userEarning.userId, identity.userId))
    .limit(1))[0];
  if (existing) {
    await db.update(userEarning).set(patch).where(eq(userEarning.userId, identity.userId));
  } else {
    await db.insert(userEarning).values({
      userId: identity.userId,
      ...patch,
    } as typeof userEarning.$inferInsert);
  }
}

/** Distinct-viewer counts since launch. Members = rows with
 *  `viewer_user_id IS NOT NULL`; external = the rest. */
async function computeVisitorStats(db: Db, identity: ProfileIdentity): Promise<ProfileVisitorStats> {
  const baseWhere = identity.characterId
    ? and(
        eq(profileViews.profileUserId, identity.userId),
        eq(profileViews.profileCharacterId, identity.characterId),
      )
    : and(
        eq(profileViews.profileUserId, identity.userId),
        isNull(profileViews.profileCharacterId),
      );

  // SQLite count via raw SQL — drizzle's count helper would need
  // a separate filtered subquery for each bucket.
  const memberRow = await db
    .select({ n: sql<number>`count(distinct ${profileViews.viewerKey})` })
    .from(profileViews)
    .where(and(baseWhere, sql`${profileViews.viewerUserId} IS NOT NULL`));
  const externalRow = await db
    .select({ n: sql<number>`count(distinct ${profileViews.viewerKey})` })
    .from(profileViews)
    .where(and(baseWhere, sql`${profileViews.viewerUserId} IS NULL`));
  const members = memberRow[0]?.n ?? 0;
  const external = externalRow[0]?.n ?? 0;
  return { members, external, total: members + external };
}

function emptyStatsPayload(): { visible: false; stats: ProfileVisitorStats } {
  return { visible: false as const, stats: { members: 0, external: 0, total: 0 } };
}

/**
 * Stable hash for anonymous viewers. We bucket on IP + UA so a
 * shared proxy + shared browser counts as one viewer (close enough),
 * while a different browser on the same IP counts as a new viewer
 * (mobile vs desktop on a home network). Hashed so we don't store
 * raw IPs.
 */
function anonymousFingerprint(req: FastifyRequest): string {
  const ip = req.ip || "0.0.0.0";
  const ua = req.headers["user-agent"] ?? "";
  return "anon:" + createHash("sha256").update(`${ip}|${ua}`).digest("hex").slice(0, 24);
}
