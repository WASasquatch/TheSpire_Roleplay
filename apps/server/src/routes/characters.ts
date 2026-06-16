import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  CHARACTER_ATTRIBUTES_MAX,
  CHARACTER_ATTRIBUTE_LABEL_MAX,
  CHARACTER_ATTRIBUTE_VALUE_MAX,
  CHARACTER_ATTRIBUTE_VALUE_MIN,
  parseTagList,
  serializeTagList,
} from "@thekeep/shared";
import { hasPermission } from "../auth/permissions.js";
import { and, eq, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import { characterPortraits, characters, userPortraits, users } from "../db/schema.js";
import { bioHtmlForEdit, sanitizeBio } from "../auth/html.js";
import { recordAudit } from "../audit.js";
import { getSessionUser } from "./auth.js";
import { getSettings, parseOwnThemeJson, parseUserThemeJson } from "../settings.js";
import { broadcastPresence } from "../realtime/broadcast.js";
import { eqNameInsensitive } from "../lib/nameLookup.js";
import type { Db } from "../db/index.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

/** Same regex used by `/char create` so the two creation paths stay in
 *  lockstep. A non-breaking space (U+00A0) is allowed and PRESERVED, the
 *  command parser treats NBSP as a normal word character (see
 *  commands/parser.ts), so `The\u00A0Watcher` stays one token and works
 *  with /whisper, /char, etc. An ASCII space is still accepted here for
 *  backward compatibility with existing names and the `/char create`
 *  command, but the client creation UIs steer new names away from it
 *  (it splits on whitespace and breaks those same commands). */
const CHAR_NAME_RX = /^[\p{L}\p{N}_\-'\u00A0 ]{1,40}$/u;

/**
 * Mirrors `normalizeCharName` in commands/builtins/char.ts. Trims
 * surrounding whitespace (including NBSP at the edges) but PRESERVES
 * interior NBSP: folding it to an ASCII space used to defeat the whole
 * point of typing Alt+0160 for a parser-safe name, the stored value
 * came back with a real space and broke commands. Dup detection stays
 * space-insensitive via `eqNameInsensitive` below, so "John Smith" and
 * "John\u00A0Smith" still collide. Keep the two normalizers in sync.
 */
function normalizeCharName(input: string): string {
  return input.trim();
}
const createCharacterBody = z.object({ name: z.string().min(1).max(40) }).strict();
const activeCharacterBody = z.object({
  /** null clears the active character (drops the user back to OOC). */
  characterId: z.string().nullable(),
}).strict();

/** Per-identity portrait gallery cap. Hard upper bound; admins might tune
 *  later. Applies to both `/characters/:id/portraits` and `/me/portraits`. */
const PORTRAIT_CAP_PER_CHARACTER = 20;
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

// Vibe axes: bipolar 0..100 or null (unset). Each shared axis key
// gets its own optional+nullable number slot. Listing the axes
// explicitly here (rather than reflecting off CHARACTER_VIBE_AXES
// dynamically) keeps the Zod inference clean, z.object built from a
// computed record loses the per-key type info, and adding a new axis
// is still a two-touch change (shared catalog + this object), which is
// the right tradeoff for a security-relevant validator.
// Unknown axis keys are dropped by `.strict()` rather than echoed back
// to storage.
const vibeAxisValue = z.number().int().min(0).max(100).nullable();
const vibeSchema = z.object({
  combat:   vibeAxisValue.optional(),
  cunning:  vibeAxisValue.optional(),
  warmth:   vibeAxisValue.optional(),
  order:    vibeAxisValue.optional(),
  caution:  vibeAxisValue.optional(),
  outlook:  vibeAxisValue.optional(),
  social:   vibeAxisValue.optional(),
  boldness: vibeAxisValue.optional(),
}).strict().optional();

// Each attribute row: client-generated id + a labeled integer stat
// clamped to its own [min, max] bound. Negative-friendly bounds
// (-9999..9999) so D&D-style ability-score modifiers (-5..+5) and
// debuff numbers don't have to wedge into a positive-only schema.
// Server validates the per-row coherence (min <= value <= max);
// out-of-band rows get rejected so the renderer never has to defend
// against a value falling outside its own bar's range.
const attributeRowSchema = z.object({
  id: z.string().min(1).max(60),
  label: z.string().min(1).max(CHARACTER_ATTRIBUTE_LABEL_MAX),
  value: z.number().int().min(CHARACTER_ATTRIBUTE_VALUE_MIN).max(CHARACTER_ATTRIBUTE_VALUE_MAX),
  min: z.number().int().min(CHARACTER_ATTRIBUTE_VALUE_MIN).max(CHARACTER_ATTRIBUTE_VALUE_MAX),
  max: z.number().int().min(CHARACTER_ATTRIBUTE_VALUE_MIN).max(CHARACTER_ATTRIBUTE_VALUE_MAX),
}).strict().refine(
  (r) => r.min <= r.max && r.value >= r.min && r.value <= r.max,
  { message: "value must satisfy min <= value <= max" },
);

// Visibility map mirrors the shared `CharacterStatsVisibility` shape,
// each known field is an optional boolean (undefined = show by default,
// false = hide on the rendered profile, true = show).
const visibilitySchema = z.object({
  age: z.boolean().optional(),
  race: z.boolean().optional(),
  gender: z.boolean().optional(),
  height: z.boolean().optional(),
  weight: z.boolean().optional(),
  alignment: z.boolean().optional(),
  occupation: z.boolean().optional(),
  custom: z.boolean().optional(),
  vibe: z.boolean().optional(),
  attributes: z.boolean().optional(),
}).strict().optional();

const statsSchema = z.object({
  age: z.string().max(40).optional(),
  race: z.string().max(40).optional(),
  gender: z.string().max(40).optional(),
  height: z.string().max(40).optional(),
  weight: z.string().max(40).optional(),
  alignment: z.string().max(40).optional(),
  occupation: z.string().max(80).optional(),
  custom: z.record(z.string().max(40), z.string().max(200)).optional(),
  vibe: vibeSchema,
  attributes: z.array(attributeRowSchema)
    .max(CHARACTER_ATTRIBUTES_MAX)
    .refine(
      // Stable client-side id keys: two rows sharing one would cause
      // React-key collisions on the renderer side AND let a duplicate
      // post quietly overwrite an older row's data on re-save (since
      // the editor finds rows by id). Reject the whole save rather
      // than silently dedupe, a duplicate is a real bug somewhere
      // upstream and the operator wants to see the 400.
      (rows) => new Set(rows.map((r) => r.id)).size === rows.length,
      { message: "attribute row ids must be unique" },
    )
    .optional(),
  visibility: visibilitySchema,
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

/** `#rrggbb` or `#rgb` literal. Used by chat-color fields on both master and character. */
const hexColor = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "color must be a hex like #990000 or #abc");

/** Avatar zoom / pan / focal-point validator. The shared
 *  `clampAvatarCrop` snaps wild numbers to safe ranges on the way out,
 *  but we still hand-validate inputs here so a malformed body returns
 *  a 400 instead of silently snapping to defaults, clearer error
 *  feedback for the editor when something is off. */
const avatarCropSchema = z.object({
  zoom: z.number().min(1.0).max(4.0),
  offsetX: z.number().min(0).max(100),
  offsetY: z.number().min(0).max(100),
}).strict();

const updateBody = z.object({
  bioHtml: z.string().max(BIO_HARD_CAP).optional(),
  stats: statsSchema.optional(),
  avatarUrl: httpUrl.nullable().optional(),
  /** Optional crop update. Sent alongside an `avatarUrl` change or on
   *  its own (the picker can fine-tune the crop without re-uploading
   *  the URL). Omitted = keep current. */
  avatarCrop: avatarCropSchema.optional(),
  /** Per-character "show avatar at the head of the gallery" opt-in.
   *  See users / characters schema for the synthetic-portrait rationale. */
  includeAvatarInGallery: z.boolean().optional(),
  /** null = inherit master/default theme */
  theme: themeSchema.nullable().optional(),
  /**
   * Per-character chat color override. Null = inherit the master
   * account's chat color (existing behavior). When set, messages
   * authored AS this character render in this color regardless of the
   * tab's `/color` state, so Character A and Character B can keep
   * distinct chat colors under one account without having to
   * re-issue `/color` after every `/char switch`.
   */
  chatColor: hexColor.nullable().optional(),
  /**
   * Per-character theme STYLE override (medieval/modern/scifi). Null =
   * inherit through the chain (master → theme-pinned design → site
   * default). Same semantics as master's styleKey; bounded length to
   * keep the column small, catalog validity is checked client-side.
   */
  styleKey: z.string().min(1).max(64).nullable().optional(),
  /** Public visibility - anonymous viewers can fetch this character. */
  isPublic: z.boolean().optional(),
  /** NSFW gate: forces non-public to anonymous + adds a viewer warning splash. */
  isNsfw: z.boolean().optional(),
  /**
   * Public-profile backdrop image URL. Same validator as avatarUrl,
   * http(s), length-capped. Null clears the override (profile modal
   * falls back to the default spire splash). Empty string also reads
   * as "clear", normalized to null on write so the column stays
   * single-shaped.
   */
  publicProfileBgUrl: httpUrl.nullable().optional(),
  /** Display mode for `publicProfileBgUrl`. See PublicProfileBgMode in @thekeep/shared. */
  publicProfileBgMode: z.enum(["cover", "contain", "tile", "stretch"]).optional(),
  /**
   * Per-character Direct Messenger opt-in. Defaults to false at
   * character-creation; existing characters with prior friendships /
   * conversations were backfilled to true by migration 0183. Editing
   * this from the profile editor flips the visibility of this
   * character to friend-request lookups and DM recipient pickers
   * across the whole site, see characters.directMessengerEnabled
   * column comment for the gate semantics.
   */
  directMessengerEnabled: z.boolean().optional(),
});

const masterUpdateBody = z.object({
  bioHtml: z.string().max(BIO_HARD_CAP).optional(),
  avatarUrl: httpUrl.nullable().optional(),
  /** Same shape as the character schema's avatarCrop. Optional,
   *  omit to keep the existing crop. */
  avatarCrop: avatarCropSchema.optional(),
  /** OOC-side counterpart of the character flag; same semantics. */
  includeAvatarInGallery: z.boolean().optional(),
  gender: z.enum(["male", "female", "nonbinary", "other", "undisclosed"]).optional(),
  /** null = revert to system default */
  theme: themeSchema.nullable().optional(),
  /**
   * Per-user theme style override. Null clears the override (user falls
   * back to the site default). Bounded to a reasonable length, actual
   * validity against the registered style catalog is checked client-
   * side; the server stores whatever string the user picked.
   */
  styleKey: z.string().min(1).max(64).nullable().optional(),
  /**
   * Free-form CSS font-family stack. Null clears the override. Capped at
   * 200 chars, long enough for any reasonable stack with multiple
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
  soundWhisperEnabled: z.boolean().optional(),
  /**
   * Input-behavior opt-outs. Default off (= features stay on) so
   * existing users don't notice a change until they tick the box.
   * Both are account-wide, switching characters doesn't reset them.
   */
  disableInputHistory: z.boolean().optional(),
  disableThesaurus: z.boolean().optional(),
  /**
   * Scriptorium catalog prefs (Phase 9). `storyShowNsfw` opts the
   * caller into R / NC-17 cards in the in-app catalog (anonymous
   * viewers are still gated server-side regardless). `storyCwBlocklist`
   * is a content-warning blocklist that hides cards entirely.
   */
  storyShowNsfw: z.boolean().optional(),
  storyCwBlocklist: z
    .array(z.string().min(1).max(32))
    .max(50)
    .optional(),
  /**
   * Userlist display preference, render the rank sigil instead of
   * the gender glyph in rooms-tree rows. Self-hides when the user
   * has no resolved rank. Default false. (Legacy field, kept for
   * back-compat; the actual rank-icon swap is now unconditional.)
   */
  useRankAsUserlistIcon: z.boolean().optional(),
  /**
   * Per-surface rank visibility. Both default true (rank shown). When
   * off, the corresponding render skips the rank gem. Userlist takes
   * effect immediately via a presence re-broadcast; chat takes effect
   * on the user's NEXT send (past messages keep their snapshotted
   * rank).
   */
  showRankInUserlist: z.boolean().optional(),
  showRankInChat: z.boolean().optional(),
  /**
   * Per-metric profile privacy. When true, the matching ProfileMetrics
   * field returns null and the modal renders "private" instead of the
   * real count. Mirrors `user_earning.hide_currency_count` /
   * `hide_xp_count` for the activity counters.
   */
  hideChatMessageCount: z.boolean().optional(),
  hideForumTopicCount: z.boolean().optional(),
  hideForumReplyCount: z.boolean().optional(),
  /**
   * Master / OOC chat color. Drives the chat color for OOC messages
   * AND acts as the fallback for any character whose own chat color
   * is null. Null = system default.
   */
  chatColor: hexColor.nullable().optional(),
  isPublic: z.boolean().optional(),
  isNsfw: z.boolean().optional(),
  /** Master-profile public backdrop. Same shape as the character-level field. */
  publicProfileBgUrl: httpUrl.nullable().optional(),
  publicProfileBgMode: z.enum(["cover", "contain", "tile", "stretch"]).optional(),
});

const createPortraitBody = z.object({
  url: httpUrl,
  label: z.string().max(60).optional(),
  nsfw: z.boolean().optional(),
}).strict();
const updatePortraitBody = z.object({
  /** Allow URL edits in place so the card-based editor can repair
   *  typos without forcing a delete + re-add (which would invalidate
   *  the row id and break any references). Same validator as the
   *  POST body, http(s) only, length-capped. */
  url: httpUrl.optional(),
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
      if (c.userId !== me.id && !(await hasPermission(me, "edit_others_character", db))) {
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
          ...(body.avatarCrop !== undefined
            ? {
                avatarZoom: body.avatarCrop.zoom,
                avatarOffsetX: body.avatarCrop.offsetX,
                avatarOffsetY: body.avatarCrop.offsetY,
              }
            : {}),
          ...(body.includeAvatarInGallery !== undefined
            ? { includeAvatarInGallery: body.includeAvatarInGallery }
            : {}),
          ...(body.theme !== undefined
            ? { themeJson: body.theme === null ? null : JSON.stringify(body.theme) }
            : {}),
          // Chat color is partial-update friendly: a present `null` clears
          // the override (character falls back to master); a present hex
          // sets it; an absent key leaves the existing value alone. The
          // same shape the rest of this body uses.
          ...(body.chatColor !== undefined ? { chatColor: body.chatColor } : {}),
          // Same partial-update shape as theme/chatColor: present null
          // clears the override (character falls back through master →
          // theme-pinned → site default); present string sets it; absent
          // leaves it alone.
          ...(body.styleKey !== undefined ? { styleKey: body.styleKey } : {}),
          ...(body.isPublic !== undefined || body.isNsfw !== undefined ? { isPublic, isNsfw } : {}),
          ...(body.publicProfileBgUrl !== undefined
            ? { publicProfileBgUrl: body.publicProfileBgUrl }
            : {}),
          ...(body.publicProfileBgMode !== undefined
            ? { publicProfileBgMode: body.publicProfileBgMode }
            : {}),
          ...(body.directMessengerEnabled !== undefined
            ? { directMessengerEnabled: body.directMessengerEnabled }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(characters.id, c.id));
      // If the character's chat color changed, every room this user is
      // currently parked in needs its userlist re-broadcast so other
      // viewers see the new color metadata on the occupant row. Mirrors
      // the broadcast the /color slash command already does, without
      // this, a color set via the editor only shows up to others on
      // their next message-driven render.
      if (body.chatColor !== undefined) {
        const sockets = await io.fetchSockets();
        const rooms = new Set<string>();
        for (const s of sockets) {
          if ((s.data as { userId?: string }).userId !== c.userId) continue;
          for (const r of s.rooms) if (r.startsWith("room:")) rooms.add(r.slice(5));
        }
        const { broadcastPresence } = await import("../realtime/broadcast.js");
        for (const roomId of rooms) await broadcastPresence(io, db, roomId);
      }
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
    if (c.userId !== me.id && !(await hasPermission(me, "edit_others_character", db))) {
      reply.code(403);
      return { error: "not yours - use /profiles/:name to view another character's public profile" };
    }
    // This endpoint feeds the bio editor's textarea, undo the
    // paragraph-break `<br>` tags the save pass adds so the writer sees
    // clean source text instead of literal `<br>` strings. Viewer-facing
    // profile reads go through /profiles/:name and keep the persisted
    // HTML as-is for rendering.
    return {
      ...c,
      bioHtml: bioHtmlForEdit(c.bioHtml),
      // Wrap the three avatar-crop columns into the AvatarCrop wire
      // shape the editor expects (mirrors the master /me/profile
      // endpoint above). The flat columns are still spread for
      // backwards compatibility with anything reading them directly.
      avatarCrop: {
        zoom: c.avatarZoom,
        offsetX: c.avatarOffsetX,
        offsetY: c.avatarOffsetY,
      },
    };
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

    const name = normalizeCharName(body.name);
    if (!CHAR_NAME_RX.test(name)) {
      reply.code(400);
      return { error: "Character name must be 1-40 chars: letters, numbers, spaces, _ - '" };
    }

    // Space-insensitive dup check, uses the same helper the friend /
    // DM / whisper paths use, so a creating user can't sneak around an
    // existing "William Wallace" by retyping it with NBSP between the
    // words (or vice-versa). Pairs with `normalizeCharName` above which
    // already folds NBSP→space on the incoming side; this guards
    // against legacy rows that may have been stored with NBSP before
    // the normalization landed.
    const existing = (await db
      .select()
      .from(characters)
      .where(and(
        eq(characters.userId, me.id),
        eqNameInsensitive(characters.name, name),
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
    if (c.userId !== me.id && !(await hasPermission(me, "edit_others_character", db))) {
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
    // sweep also feeds the presence rebroadcast, a tombstoned name
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
      // Reverse the paragraph-break `<br>` tags the save pass adds so
      // the editor's textarea shows clean prose. Viewer-facing master
      // profiles go through /profiles/:name and keep the persisted HTML.
      bioHtml: bioHtmlForEdit(u.bioHtml),
      avatarUrl: u.avatarUrl,
      avatarCrop: {
        zoom: u.avatarZoom,
        offsetX: u.avatarOffsetX,
        offsetY: u.avatarOffsetY,
      },
      includeAvatarInGallery: u.includeAvatarInGallery,
      gender: u.gender,
      chatColor: u.chatColor,
      awayMessage: u.awayMessage,
      activeCharacterId: u.activeCharacterId,
      activeCharacterName,
      // Strict parse, returns null when the user has no theme of
      // their own so the client can fall through to the live
      // `branding.defaultTheme` instead of freezing a snapshot of the
      // site default at fetch time. (Previously this used the resolving
      // parser, which made "Default" saves in the profile bake whichever
      // site theme was active at save time and stop responding to later
      // admin palette changes.)
      theme: parseOwnThemeJson(u.themeJson),
      // Per-user style override. Null means "follow the site default";
      // the client resolves user > site > hard-coded fallback. Style is
      // orthogonal to `theme` above, they compose.
      styleKey: u.styleKey,
      // Per-user UI font + size accessibility preferences. Null on either
      // means "use the application default", the client resolves both
      // independently and applies them via CSS variables on <html>.
      uiFontFamily: u.uiFontFamily,
      uiFontScale: u.uiFontScale,
      notifyPref: u.notifyPref,
      soundDmEnabled: u.soundDmEnabled,
      soundChatEnabled: u.soundChatEnabled,
      soundAlertEnabled: u.soundAlertEnabled,
      soundWhisperEnabled: u.soundWhisperEnabled,
      disableInputHistory: u.disableInputHistory,
      disableThesaurus: u.disableThesaurus,
      // Scriptorium catalog prefs (Phase 9). Editor's Privacy tab
      // reads these so the toggles round-trip cleanly.
      storyShowNsfw: u.storyShowNsfw,
      storyCwBlocklist: parseTagList(u.storyCwBlocklist),
      useRankAsUserlistIcon: u.useRankAsUserlistIcon,
      showRankInUserlist: u.showRankInUserlist,
      showRankInChat: u.showRankInChat,
      hideChatMessageCount: u.hideChatMessageCount,
      hideForumTopicCount: u.hideForumTopicCount,
      hideForumReplyCount: u.hideForumReplyCount,
      role: u.role,
      isPublic: u.isPublic,
      isNsfw: u.isNsfw,
      // Public-profile backdrop image + display mode. Editor reads
      // these to seed its BG controls; viewer surfaces (the modal)
      // read them from `/profiles/:name` instead. Null URL = no
      // override, default mode "cover".
      publicProfileBgUrl: u.publicProfileBgUrl,
      publicProfileBgMode: u.publicProfileBgMode as "cover" | "contain" | "tile" | "stretch",
      welcome: wantsWelcome
        ? { html: settings.newUserWelcomeHtml, hash: settings.newUserWelcomeHash }
        : null,
      // Admin-tunable input caps surfaced to the editor so the bio counter
      // matches whatever the server will accept on save. Without these the
      // UI hardcoded "50,000" and silently lied after admin tuning.
      limits: {
        maxBioLength: settings.maxBioLength,
        maxMessageLength: settings.maxMessageLength,
        maxDirectMessageLength: settings.maxDirectMessageLength,
        maxForumPostLength: settings.maxForumPostLength,
        maxForumTopicTitleLength: settings.maxForumTopicTitleLength,
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
    if (c.userId !== me.id && !(await hasPermission(me, "edit_others_character", db))) {
      reply.code(403); return { error: "not yours" };
    }
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
    if (c.userId !== me.id && !(await hasPermission(me, "edit_others_character", db))) {
      reply.code(403); return { error: "not yours" };
    }

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
      if (c.userId !== me.id && !(await hasPermission(me, "edit_others_character", db))) {
        reply.code(403); return { error: "not yours" };
      }

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
          ...(body.url !== undefined ? { url: body.url } : {}),
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
      if (c.userId !== me.id && !(await hasPermission(me, "edit_others_character", db))) {
        reply.code(403); return { error: "not yours" };
      }

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

  /* ===========================================================
   *  Master / OOC portrait gallery (multi-portrait per user)
   *
   *  Mirrors the character-portraits routes above but keys on the
   *  authenticated user instead of a character id. Same per-portrait
   *  shape (url, label, nsfw, sortOrder), same validators
   *  (createPortraitBody / updatePortraitBody), same cap. Lets a
   *  user maintain a gallery on their OOC profile without
   *  attaching the portraits to a character.
   * =========================================================== */

  /** List the caller's master gallery portraits. */
  app.get("/me/portraits", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const list = await db
      .select()
      .from(userPortraits)
      .where(eq(userPortraits.userId, me.id));
    list.sort((a, b) => a.sortOrder - b.sortOrder || +a.createdAt - +b.createdAt);
    return { portraits: list };
  });

  /** Add a new master gallery portrait. */
  app.post<{ Body: unknown }>("/me/portraits", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    let body;
    try { body = createPortraitBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    const countRows = await db
      .select({ n: sql<number>`count(*)` })
      .from(userPortraits)
      .where(eq(userPortraits.userId, me.id));
    const count = countRows[0]?.n ?? 0;
    if (count >= PORTRAIT_CAP_PER_CHARACTER) {
      reply.code(429);
      return { error: `Limit of ${PORTRAIT_CAP_PER_CHARACTER} extra portraits per profile.` };
    }

    const id = nanoid();
    const sortOrder = count;
    await db.insert(userPortraits).values({
      id,
      userId: me.id,
      url: body.url,
      label: body.label ?? null,
      sortOrder,
      nsfw: body.nsfw ?? false,
    });
    const row = (await db
      .select()
      .from(userPortraits)
      .where(eq(userPortraits.id, id))
      .limit(1))[0];
    reply.code(201);
    return row;
  });

  /** Update a master gallery portrait's label / order / nsfw flag. */
  app.patch<{ Params: { portraitId: string }; Body: unknown }>(
    "/me/portraits/:portraitId",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }

      let body;
      try { body = updatePortraitBody.parse(req.body); }
      catch { reply.code(400); return { error: "invalid body" }; }

      const p = (await db
        .select()
        .from(userPortraits)
        .where(eq(userPortraits.id, req.params.portraitId))
        .limit(1))[0];
      if (!p) { reply.code(404); return { error: "not found" }; }
      // Owner edits freely; a moderator holding `edit_others_user` can also
      // patch someone else's master portrait (the use case is flagging a
      // gallery image NSFW from the profile modal). Mirrors how the
      // character-portrait route above honors `edit_others_character`.
      if (p.userId !== me.id && !(await hasPermission(me, "edit_others_user", db))) {
        reply.code(403); return { error: "not yours" };
      }

      await db
        .update(userPortraits)
        .set({
          ...(body.url !== undefined ? { url: body.url } : {}),
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
          ...(body.nsfw !== undefined ? { nsfw: body.nsfw } : {}),
        })
        .where(eq(userPortraits.id, p.id));
      return { ok: true };
    },
  );

  /** Delete a master gallery portrait. */
  app.delete<{ Params: { portraitId: string } }>(
    "/me/portraits/:portraitId",
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      if (!me) { reply.code(401); return { error: "auth" }; }
      const p = (await db
        .select()
        .from(userPortraits)
        .where(eq(userPortraits.id, req.params.portraitId))
        .limit(1))[0];
      if (!p || p.userId !== me.id) { reply.code(404); return { error: "not found" }; }
      await db.delete(userPortraits).where(eq(userPortraits.id, p.id));
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
        ...(body.avatarCrop !== undefined
          ? {
              avatarZoom: body.avatarCrop.zoom,
              avatarOffsetX: body.avatarCrop.offsetX,
              avatarOffsetY: body.avatarCrop.offsetY,
            }
          : {}),
        ...(body.includeAvatarInGallery !== undefined
          ? { includeAvatarInGallery: body.includeAvatarInGallery }
          : {}),
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
        ...(body.soundWhisperEnabled !== undefined ? { soundWhisperEnabled: body.soundWhisperEnabled } : {}),
        ...(body.disableInputHistory !== undefined ? { disableInputHistory: body.disableInputHistory } : {}),
        ...(body.disableThesaurus !== undefined ? { disableThesaurus: body.disableThesaurus } : {}),
        ...(body.storyShowNsfw !== undefined ? { storyShowNsfw: body.storyShowNsfw } : {}),
        ...(body.storyCwBlocklist !== undefined
          ? { storyCwBlocklist: serializeTagList(body.storyCwBlocklist) }
          : {}),
        ...(body.useRankAsUserlistIcon !== undefined ? { useRankAsUserlistIcon: body.useRankAsUserlistIcon } : {}),
        ...(body.showRankInUserlist !== undefined ? { showRankInUserlist: body.showRankInUserlist } : {}),
        ...(body.showRankInChat !== undefined ? { showRankInChat: body.showRankInChat } : {}),
        ...(body.hideChatMessageCount !== undefined ? { hideChatMessageCount: body.hideChatMessageCount } : {}),
        ...(body.hideForumTopicCount !== undefined ? { hideForumTopicCount: body.hideForumTopicCount } : {}),
        ...(body.hideForumReplyCount !== undefined ? { hideForumReplyCount: body.hideForumReplyCount } : {}),
        // Master chat color. Mirrors the `/color` slash command's
        // master-scope write, this is the value that drives OOC
        // messages and acts as the fallback for any character whose
        // own override is null. Partial update (null clears, hex sets,
        // absent leaves alone).
        ...(body.chatColor !== undefined ? { chatColor: body.chatColor } : {}),
        ...(body.isPublic !== undefined || body.isNsfw !== undefined ? { isPublic, isNsfw } : {}),
        ...(body.publicProfileBgUrl !== undefined
          ? { publicProfileBgUrl: body.publicProfileBgUrl }
          : {}),
        ...(body.publicProfileBgMode !== undefined
          ? { publicProfileBgMode: body.publicProfileBgMode }
          : {}),
      })
      .where(eq(users.id, me.id));
    if (
      body.chatColor !== undefined ||
      body.useRankAsUserlistIcon !== undefined ||
      body.showRankInUserlist !== undefined
    ) {
      // Same userlist re-broadcast as the character PUT does, keeps
      // every viewer's occupant row in sync with the new metadata.
      // useRankAsUserlistIcon needs the same treatment: a fresh toggle
      // has to repaint every viewer's rail (the rank sigil takes over
      // the icon slot for this user's rows everywhere), otherwise the
      // change wouldn't show until the next presence event a room
      // happens to fire (a join, a leave, a /char switch by someone
      // else).
      const sockets = await io.fetchSockets();
      const rooms = new Set<string>();
      for (const s of sockets) {
        if ((s.data as { userId?: string }).userId !== me.id) continue;
        for (const r of s.rooms) if (r.startsWith("room:")) rooms.add(r.slice(5));
      }
      const { broadcastPresence } = await import("../realtime/broadcast.js");
      for (const roomId of rooms) await broadcastPresence(io, db, roomId);
    }
    return { ok: true };
  });

  /**
   * Moderator bio edit for ANOTHER user's master (OOC) profile. The
   * self-edit path is `PUT /me/profile` above; this is the moderation
   * variant gated by `edit_others_user`, used by the "Edit Bio" button on
   * the profile modal. Scope is deliberately narrow, ONLY `bioHtml`, the
   * same sanitize + cap pipeline as the owner path. Character bios go
   * through `PUT /characters/:id` (which already honors
   * `edit_others_character`), so this only covers the master profile.
   */
  app.put<{ Params: { id: string }; Body: unknown }>("/users/:id/profile", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    if (!(await hasPermission(me, "edit_others_user", db))) {
      reply.code(403); return { error: "missing permission: edit_others_user" };
    }
    const body = z.object({ bioHtml: z.string().max(BIO_HARD_CAP) }).parse(req.body);
    const target = (await db.select().from(users).where(eq(users.id, req.params.id)).limit(1))[0];
    if (!target) { reply.code(404); return { error: "not found" }; }
    if (!(await checkBioCap(db, reply, body.bioHtml))) return;
    await db
      .update(users)
      .set({ bioHtml: sanitizeBio(body.bioHtml) })
      .where(eq(users.id, target.id));
    await recordAudit(db, {
      actorUserId: me.id,
      action: "user_bio_edit_admin",
      targetUserId: target.id,
    });
    return { ok: true };
  });
}

