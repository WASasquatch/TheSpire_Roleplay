import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import { characterPortraits, characters, users } from "../db/schema.js";
import { sanitizeBio } from "../auth/html.js";
import { getSessionUser } from "./auth.js";
import { getSettings, parseOwnThemeJson, parseUserThemeJson } from "../settings.js";
import { broadcastPresence } from "../realtime/broadcast.js";
import type { Db } from "../db/index.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

/** Same regex used by `/char create` so the two creation paths stay in lockstep. */
const CHAR_NAME_RX = /^[\p{L}\p{N}_\-' ]{1,40}$/u;
const createCharacterBody = z.object({ name: z.string().min(1).max(40) }).strict();
const activeCharacterBody = z.object({
  /** null clears the active character (drops the user back to OOC). */
  characterId: z.string().nullable(),
}).strict();

/** Per-character portrait gallery cap. Hard upper bound; admins might tune later. */
const PORTRAIT_CAP_PER_CHARACTER = 12;
// `createPortraitBody` / `updatePortraitBody` use the same `httpUrl`
// validator the avatar field uses; both schemas are declared further down
// the file once httpUrl is in scope.

const HEX_RX = /^#[0-9a-fA-F]{6}$/;
const themeSchema = z.object({
  bg: z.string().regex(HEX_RX),
  panel: z.string().regex(HEX_RX),
  border: z.string().regex(HEX_RX),
  text: z.string().regex(HEX_RX),
  muted: z.string().regex(HEX_RX),
  action: z.string().regex(HEX_RX),
  accent: z.string().regex(HEX_RX),
  system: z.string().regex(HEX_RX),
}).strict();

const statsSchema = z.object({
  age: z.string().max(40).optional(),
  race: z.string().max(40).optional(),
  gender: z.string().max(40).optional(),
  height: z.string().max(40).optional(),
  weight: z.string().max(40).optional(),
  alignment: z.string().max(40).optional(),
  occupation: z.string().max(80).optional(),
  custom: z.record(z.string().max(40), z.string().max(200)).optional(),
}).strict();

// Restrict avatarUrl to http(s) - z.string().url() also allows
// javascript:, data:, file:, etc., which would let a hostile profile load
// payloads or leak referrers. Same shape used for both update bodies.
const httpUrl = z.string().url().max(500).refine(
  (s) => /^https?:\/\//i.test(s),
  { message: "avatarUrl must use http or https" },
);

// Bios are capped at 200KB at the schema layer (the highest the admin can
// configure); the per-deployment cap is enforced in code below so admins can
// tune it without redeploys.
const BIO_HARD_CAP = 200_000;

const updateBody = z.object({
  bioHtml: z.string().max(BIO_HARD_CAP).optional(),
  stats: statsSchema.optional(),
  avatarUrl: httpUrl.nullable().optional(),
  /** null = inherit master/default theme */
  theme: themeSchema.nullable().optional(),
  /** Public visibility - anonymous viewers can fetch this character. */
  isPublic: z.boolean().optional(),
  /** NSFW gate: forces non-public to anonymous + adds a viewer warning splash. */
  isNsfw: z.boolean().optional(),
});

const masterUpdateBody = z.object({
  bioHtml: z.string().max(BIO_HARD_CAP).optional(),
  avatarUrl: httpUrl.nullable().optional(),
  gender: z.enum(["male", "female", "nonbinary", "other", "undisclosed"]).optional(),
  /** null = revert to system default */
  theme: themeSchema.nullable().optional(),
  /**
   * Per-user theme style override. Null clears the override (user falls
   * back to the site default). Bounded to a reasonable length — actual
   * validity against the registered style catalog is checked client-
   * side; the server stores whatever string the user picked.
   */
  styleKey: z.string().min(1).max(64).nullable().optional(),
  /**
   * Free-form CSS font-family stack. Null clears the override. Capped at
   * 200 chars — long enough for any reasonable stack with multiple
   * fallbacks, short enough to refuse pathological pasted blobs. Stored
   * verbatim; CSS rejects unknown families silently, so a bad value just
   * degrades to the next font in the stack on the client side.
   */
  uiFontFamily: z.string().max(200).nullable().optional(),
  /**
   * Font-size tier. Null = inherit the default (medium / 16px). Stored as
   * the enum string so future tiers can be added without schema churn.
   */
  uiFontScale: z.enum(["small", "medium", "large", "xl"]).nullable().optional(),
  notifyPref: z.enum(["off", "mentions", "all"]).optional(),
  /**
   * Per-event sound toggles (account-level, not per-character). Each
   * maps to a bundled mp3 in apps/web/public/audio. Omitted = keep
   * current value; the route does partial updates.
   */
  soundDmEnabled: z.boolean().optional(),
  soundChatEnabled: z.boolean().optional(),
  soundAlertEnabled: z.boolean().optional(),
  isPublic: z.boolean().optional(),
  isNsfw: z.boolean().optional(),
});

const createPortraitBody = z.object({
  url: httpUrl,
  label: z.string().max(60).optional(),
  nsfw: z.boolean().optional(),
}).strict();
const updatePortraitBody = z.object({
  label: z.string().max(60).nullable().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
  nsfw: z.boolean().optional(),
}).strict();

async function checkBioCap(
  db: Db,
  reply: FastifyReply,
  bioHtml: string | undefined,
): Promise<boolean> {
  if (bioHtml === undefined) return true;
  const { maxBioLength } = await getSettings(db);
  if (bioHtml.length > maxBioLength) {
    reply.code(413);
    reply.send({ error: `bio is longer than the configured ${maxBioLength}-char limit` });
    return false;
  }
  return true;
}

export async function registerCharacterRoutes(app: FastifyInstance, db: Db, io: Io): Promise<void> {
  /** Save a character's editor body. */
  app.put<{ Params: { id: string }; Body: unknown }>(
    "/characters/:id",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }

      const c = (await db.select().from(characters).where(eq(characters.id, req.params.id)).limit(1))[0];
      if (!c || c.deletedAt) { reply.code(404); return { error: "not found" }; }
      if (c.userId !== me.id && me.role !== "admin") {
        reply.code(403);
        return { error: "not yours" };
      }

      const body = updateBody.parse(req.body);
      if (!(await checkBioCap(db, reply, body.bioHtml))) return;
      // NSFW implies non-public to anonymous viewers (server enforces this in
      // the /profiles/:name route too, but normalizing on write keeps the row
      // self-consistent so admin queries don't need to special-case the
      // implication). When NSFW flips on, force isPublic to false; when NSFW
      // flips off, leave isPublic alone (the user can re-enable separately).
      const isNsfw = body.isNsfw ?? c.isNsfw;
      const isPublic = isNsfw ? false : (body.isPublic ?? c.isPublic);
      await db
        .update(characters)
        .set({
          ...(body.bioHtml !== undefined ? { bioHtml: sanitizeBio(body.bioHtml) } : {}),
          ...(body.stats !== undefined ? { statsJson: JSON.stringify(body.stats) } : {}),
          ...(body.avatarUrl !== undefined ? { avatarUrl: body.avatarUrl } : {}),
          ...(body.theme !== undefined
            ? { themeJson: body.theme === null ? null : JSON.stringify(body.theme) }
            : {}),
          ...(body.isPublic !== undefined || body.isNsfw !== undefined ? { isPublic, isNsfw } : {}),
          updatedAt: new Date(),
        })
        .where(eq(characters.id, c.id));
      return { ok: true };
    },
  );

  /**
   * Fetch the editor view of a character. Owner-only (admins also pass) so the
   * raw row - which carries `userId` and any other internal columns - never
   * leaks across accounts. Other users should view characters through
   * `/profiles/:name`, which returns a curated `ProfileView` instead.
   */
  app.get<{ Params: { id: string } }>("/characters/:id", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const c = (await db.select().from(characters).where(eq(characters.id, req.params.id)).limit(1))[0];
    if (!c || c.deletedAt) { reply.code(404); return { error: "not found" }; }
    if (c.userId !== me.id && me.role !== "admin") {
      reply.code(403);
      return { error: "not yours - use /profiles/:name to view another character's public profile" };
    }
    return c;
  });

  app.get("/characters", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const list = await db
      .select()
      .from(characters)
      .where(and(eq(characters.userId, me.id), isNull(characters.deletedAt)));
    return { characters: list };
  });

  /**
   * Create a new character under the authenticated user. Mirrors the validation
   * in `/char create` (apps/server/src/commands/builtins/char.ts) so both paths
   * apply the same name rules, duplicate guard, and per-user limit.
   */
  app.post<{ Body: unknown }>("/characters", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    let body: { name: string };
    try { body = createCharacterBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    const name = body.name.trim();
    if (!CHAR_NAME_RX.test(name)) {
      reply.code(400);
      return { error: "Character name must be 1-40 chars: letters, numbers, spaces, _ - '" };
    }

    const existing = (await db
      .select()
      .from(characters)
      .where(and(
        eq(characters.userId, me.id),
        sql`lower(${characters.name}) = ${name.toLowerCase()}`,
        isNull(characters.deletedAt),
      ))
      .limit(1))[0];
    if (existing) {
      reply.code(409);
      return { error: `You already have a character named "${name}".` };
    }

    const countRows = await db
      .select({ n: sql<number>`count(*)` })
      .from(characters)
      .where(and(eq(characters.userId, me.id), isNull(characters.deletedAt)));
    const count = countRows[0]?.n ?? 0;
    const { maxCharactersPerUser } = await getSettings(db);
    if (count >= maxCharactersPerUser) {
      reply.code(429);
      return { error: `Limit of ${maxCharactersPerUser} characters per account.` };
    }

    const id = nanoid();
    await db.insert(characters).values({ id, userId: me.id, name });
    const c = (await db.select().from(characters).where(eq(characters.id, id)).limit(1))[0];
    reply.code(201);
    return c;
  });

  /**
   * Soft-delete a character. Mirrors the `/char delete` chat command:
   *   - sets deletedAt (history rows still resolve their snapshotted name)
   *   - if it was the user's active character, clears it and re-broadcasts
   *     presence in every room their sockets are joined to so other
   *     occupants see the rename back to OOC immediately.
   */
  app.delete<{ Params: { id: string } }>("/characters/:id", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const c = (await db.select().from(characters).where(eq(characters.id, req.params.id)).limit(1))[0];
    if (!c || c.deletedAt) { reply.code(404); return { error: "not found" }; }
    if (c.userId !== me.id && me.role !== "admin") {
      reply.code(403);
      return { error: "not yours" };
    }

    await db.update(characters).set({ deletedAt: new Date() }).where(eq(characters.id, c.id));

    // Look up the owner row so we can detect "was this their active character".
    // We use c.userId (the owner) rather than me.id because admins can delete
    // someone else's character - in that case the owner still needs the
    // active-character cleared if they had switched to it.
    const owner = (await db.select().from(users).where(eq(users.id, c.userId)).limit(1))[0];
    // Clear from DB if it was the owner's default char.
    if (owner?.activeCharacterId === c.id) {
      await db.update(users).set({ activeCharacterId: null }).where(eq(users.id, owner.id));
    }
    // Per-tab character routing: even if the owner's DB default wasn't
    // this char, some live socket of theirs may have voiced this
    // character (set via socket /char or me:switch-character). Sweep
    // every owner socket, clear the tab override on any that match, and
    // notify each so its React state drops to OOC without a poll. Same
    // sweep also feeds the presence rebroadcast — a tombstoned name
    // shouldn't linger in any occupant list the owner was visible in.
    const sockets = await io.fetchSockets();
    const affectedRooms = new Set<string>();
    for (const s of sockets) {
      if ((s.data as { userId?: string }).userId !== c.userId) continue;
      const tabCharId = (s.data as { tabCharId?: string | null }).tabCharId;
      if (tabCharId === c.id) {
        (s.data as { tabCharId?: string | null }).tabCharId = null;
        s.emit("me:character-update", { activeCharacterId: null, activeCharacterName: null });
      }
      for (const r of s.rooms) {
        if (r.startsWith("room:")) affectedRooms.add(r.slice(5));
      }
    }
    for (const roomId of affectedRooms) {
      await broadcastPresence(io, db, roomId);
    }

    return { ok: true };
  });

  /** Read your own master profile (used by the editor to populate). */
  app.get("/me/profile", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const u = (await db.select().from(users).where(eq(users.id, me.id)).limit(1))[0];
    if (!u) { reply.code(404); return { error: "not found" }; }

    // Resolve active character name (when set) so the client can do
    // self-detection on @mentions without a second roundtrip.
    let activeCharacterName: string | null = null;
    if (u.activeCharacterId) {
      const c = (await db
        .select()
        .from(characters)
        .where(eq(characters.id, u.activeCharacterId))
        .limit(1))[0];
      if (c && !c.deletedAt) activeCharacterName = c.name;
    }

    // Welcome modal audience: the user must have registered AFTER the
    // welcome's most recent edit (so existing users don't get retroactively
    // spammed when an admin sets or updates the welcome text). Plus the
    // usual "non-empty welcome" + "user hasn't acknowledged this hash" gates.
    const settings = await getSettings(db);
    const userCreatedMs = +u.createdAt;
    const wantsWelcome =
      settings.newUserWelcomeHash !== "" &&
      settings.newUserWelcomeUpdatedAt !== null &&
      userCreatedMs > settings.newUserWelcomeUpdatedAt &&
      u.welcomeSeenHash !== settings.newUserWelcomeHash;
    return {
      userId: u.id,
      username: u.username,
      bioHtml: u.bioHtml,
      avatarUrl: u.avatarUrl,
      gender: u.gender,
      chatColor: u.chatColor,
      awayMessage: u.awayMessage,
      activeCharacterId: u.activeCharacterId,
      activeCharacterName,
      // Strict parse — returns null when the user has no theme of
      // their own so the client can fall through to the live
      // `branding.defaultTheme` instead of freezing a snapshot of the
      // site default at fetch time. (Previously this used the resolving
      // parser, which made "Default" saves in the profile bake whichever
      // site theme was active at save time and stop responding to later
      // admin palette changes.)
      theme: parseOwnThemeJson(u.themeJson),
      // Per-user style override. Null means "follow the site default";
      // the client resolves user > site > hard-coded fallback. Style is
      // orthogonal to `theme` above — they compose.
      styleKey: u.styleKey,
      // Per-user UI font + size accessibility preferences. Null on either
      // means "use the application default" — the client resolves both
      // independently and applies them via CSS variables on <html>.
      uiFontFamily: u.uiFontFamily,
      uiFontScale: u.uiFontScale,
      notifyPref: u.notifyPref,
      soundDmEnabled: u.soundDmEnabled,
      soundChatEnabled: u.soundChatEnabled,
      soundAlertEnabled: u.soundAlertEnabled,
      role: u.role,
      isPublic: u.isPublic,
      isNsfw: u.isNsfw,
      welcome: wantsWelcome
        ? { html: settings.newUserWelcomeHtml, hash: settings.newUserWelcomeHash }
        : null,
      // Admin-tunable input caps surfaced to the editor so the bio counter
      // matches whatever the server will accept on save. Without these the
      // UI hardcoded "50,000" and silently lied after admin tuning.
      limits: {
        maxBioLength: settings.maxBioLength,
        maxMessageLength: settings.maxMessageLength,
      },
    };
  });

  /**
   * Mark the current welcome message as acknowledged for this user. Stores
   * the hash so future loads where the admin hasn't edited the welcome
   * skip the modal. If the hash in the request doesn't match the current
   * one (e.g. the admin updated mid-session), we still record what the
   * user actually saw - they'll get the new version on the next load.
   */
  app.post<{ Body: unknown }>("/me/welcome/dismiss", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    let body: { hash?: string } = {};
    try { body = req.body as { hash?: string }; } catch { /* tolerate */ }
    const settings = await getSettings(db);
    // Default to the current hash so a client that omits the field still
    // dismisses the live welcome. Bound the length to avoid stuffing.
    const hash = (typeof body.hash === "string" && body.hash.length <= 64)
      ? body.hash
      : settings.newUserWelcomeHash;
    await db.update(users).set({ welcomeSeenHash: hash }).where(eq(users.id, me.id));
    return { ok: true };
  });

  /* ===========================================================
   *  Character portrait gallery (multi-portrait per character)
   * =========================================================== */

  /** List portraits for a character. Owner-only; admins also pass. */
  app.get<{ Params: { id: string } }>("/characters/:id/portraits", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const c = (await db.select().from(characters).where(eq(characters.id, req.params.id)).limit(1))[0];
    if (!c || c.deletedAt) { reply.code(404); return { error: "not found" }; }
    if (c.userId !== me.id && me.role !== "admin") { reply.code(403); return { error: "not yours" }; }
    const list = await db
      .select()
      .from(characterPortraits)
      .where(eq(characterPortraits.characterId, c.id));
    list.sort((a, b) => a.sortOrder - b.sortOrder || +a.createdAt - +b.createdAt);
    return { portraits: list };
  });

  /** Add a new portrait. Validates the URL the same way avatarUrl is validated. */
  app.post<{ Params: { id: string }; Body: unknown }>("/characters/:id/portraits", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const c = (await db.select().from(characters).where(eq(characters.id, req.params.id)).limit(1))[0];
    if (!c || c.deletedAt) { reply.code(404); return { error: "not found" }; }
    if (c.userId !== me.id && me.role !== "admin") { reply.code(403); return { error: "not yours" }; }

    let body;
    try { body = createPortraitBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    const countRows = await db
      .select({ n: sql<number>`count(*)` })
      .from(characterPortraits)
      .where(eq(characterPortraits.characterId, c.id));
    const count = countRows[0]?.n ?? 0;
    if (count >= PORTRAIT_CAP_PER_CHARACTER) {
      reply.code(429);
      return { error: `Limit of ${PORTRAIT_CAP_PER_CHARACTER} extra portraits per character.` };
    }

    const id = nanoid();
    // New portraits go to the end of the gallery by default. Caller can
    // reorder via PATCH afterwards.
    const sortOrder = count;
    await db.insert(characterPortraits).values({
      id,
      characterId: c.id,
      url: body.url,
      label: body.label ?? null,
      sortOrder,
      nsfw: body.nsfw ?? false,
    });
    const row = (await db
      .select()
      .from(characterPortraits)
      .where(eq(characterPortraits.id, id))
      .limit(1))[0];
    reply.code(201);
    return row;
  });

  /** Update a portrait's label or position. */
  app.patch<{ Params: { id: string; portraitId: string }; Body: unknown }>(
    "/characters/:id/portraits/:portraitId",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const c = (await db.select().from(characters).where(eq(characters.id, req.params.id)).limit(1))[0];
      if (!c || c.deletedAt) { reply.code(404); return { error: "not found" }; }
      if (c.userId !== me.id && me.role !== "admin") { reply.code(403); return { error: "not yours" }; }

      let body;
      try { body = updatePortraitBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }

      const p = (await db
        .select()
        .from(characterPortraits)
        .where(eq(characterPortraits.id, req.params.portraitId))
        .limit(1))[0];
      if (!p || p.characterId !== c.id) { reply.code(404); return { error: "not found" }; }

      await db
        .update(characterPortraits)
        .set({
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
          ...(body.nsfw !== undefined ? { nsfw: body.nsfw } : {}),
        })
        .where(eq(characterPortraits.id, p.id));
      return { ok: true };
    },
  );

  /** Delete a portrait. */
  app.delete<{ Params: { id: string; portraitId: string } }>(
    "/characters/:id/portraits/:portraitId",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const c = (await db.select().from(characters).where(eq(characters.id, req.params.id)).limit(1))[0];
      if (!c || c.deletedAt) { reply.code(404); return { error: "not found" }; }
      if (c.userId !== me.id && me.role !== "admin") { reply.code(403); return { error: "not yours" }; }

      const p = (await db
        .select()
        .from(characterPortraits)
        .where(eq(characterPortraits.id, req.params.portraitId))
        .limit(1))[0];
      if (!p || p.characterId !== c.id) { reply.code(404); return { error: "not found" }; }

      await db.delete(characterPortraits).where(eq(characterPortraits.id, p.id));
      return { ok: true };
    },
  );

  /**
   * Switch the caller's active character (or clear it with `characterId: null`).
   * Mirrors the server-side effects of `/char switch <name>`: writes the new
   * activeCharacterId, then re-broadcasts presence in every room one of the
   * user's sockets is currently joined to so other occupants see the
   * displayName change immediately.
   */
  app.put<{ Body: unknown }>("/me/active-character", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    let body: { characterId: string | null };
    try { body = activeCharacterBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    if (body.characterId !== null) {
      const c = (await db.select().from(characters).where(eq(characters.id, body.characterId)).limit(1))[0];
      if (!c || c.deletedAt || c.userId !== me.id) {
        reply.code(404);
        return { error: "not found" };
      }
    }

    await db.update(users).set({ activeCharacterId: body.characterId }).where(eq(users.id, me.id));

    // Re-broadcast presence in every room any of this user's sockets are
    // currently in so other occupants see the rename without waiting for
    // their next interaction. Same shape as the character-delete path.
    const sockets = await io.fetchSockets();
    const rooms = new Set<string>();
    for (const s of sockets) {
      if ((s.data as { userId?: string }).userId !== me.id) continue;
      for (const r of s.rooms) {
        if (r.startsWith("room:")) rooms.add(r.slice(5));
      }
    }
    for (const roomId of rooms) {
      await broadcastPresence(io, db, roomId);
    }

    return { ok: true };
  });

  /** Master account profile editor. */
  app.put<{ Body: unknown }>("/me/profile", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const body = masterUpdateBody.parse(req.body);
    if (!(await checkBioCap(db, reply, body.bioHtml))) return;
    // Same NSFW-implies-private normalization as the character handler. We
    // need the current row to compute the resulting state when only one of
    // the two flags is in the patch.
    const current = (await db.select().from(users).where(eq(users.id, me.id)).limit(1))[0];
    const isNsfw = body.isNsfw ?? current?.isNsfw ?? false;
    const isPublic = isNsfw ? false : (body.isPublic ?? current?.isPublic ?? true);
    await db
      .update(users)
      .set({
        ...(body.bioHtml !== undefined ? { bioHtml: sanitizeBio(body.bioHtml) } : {}),
        ...(body.avatarUrl !== undefined ? { avatarUrl: body.avatarUrl } : {}),
        ...(body.gender !== undefined ? { gender: body.gender } : {}),
        ...(body.theme !== undefined
          ? { themeJson: body.theme === null ? null : JSON.stringify(body.theme) }
          : {}),
        ...(body.styleKey !== undefined ? { styleKey: body.styleKey } : {}),
        ...(body.uiFontFamily !== undefined ? { uiFontFamily: body.uiFontFamily } : {}),
        ...(body.uiFontScale !== undefined ? { uiFontScale: body.uiFontScale } : {}),
        ...(body.notifyPref !== undefined ? { notifyPref: body.notifyPref } : {}),
        ...(body.soundDmEnabled !== undefined ? { soundDmEnabled: body.soundDmEnabled } : {}),
        ...(body.soundChatEnabled !== undefined ? { soundChatEnabled: body.soundChatEnabled } : {}),
        ...(body.soundAlertEnabled !== undefined ? { soundAlertEnabled: body.soundAlertEnabled } : {}),
        ...(body.isPublic !== undefined || body.isNsfw !== undefined ? { isPublic, isNsfw } : {}),
      })
      .where(eq(users.id, me.id));
    return { ok: true };
  });
}

