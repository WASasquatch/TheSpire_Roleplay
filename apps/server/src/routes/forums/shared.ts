/**
 * Forums routes — shared scaffolding for the sub-registrars.
 *
 * The forum route surface was split into cohesive sub-registrars (catalog,
 * applications + membership, boards/console, moderation, notifications/topics),
 * each invoked by the thin `registerForumRoutes` entry point in
 * `../forums.ts`. This module homes the pieces they share: the `Io` type,
 * the per-server topic-author flair resolver (also re-exported from
 * `../forums.ts` for `rooms.ts`), the content-hashed image write/unlink
 * helpers, and the owner / permission / target gate helpers.
 *
 * The gate + image helpers are plain functions that take `db` (and the
 * forums upload dir) as their first parameter; each sub-registrar wraps them
 * in a thin closure so the route handler bodies stay byte-for-byte identical
 * to the pre-split originals.
 */
import type { Server as IoServer } from "socket.io";
import { and, eq, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import type { ClientToServerEvents, ForumModPermission, ServerToClientEvents } from "@thekeep/shared";
import {
  characterEarning,
  characterOwnedFreeformBorders,
  characterOwnedNameStyles,
  userActiveCosmetics,
  userEarning,
  userOwnedFreeformBorders,
  userOwnedNameStyles,
} from "../../db/schema.js";
import type { Db } from "../../db/index.js";
import { getSessionUser } from "../auth.js";
import { forumAuthority, forumCan } from "../../forums/authority.js";
import { resolveIdentityArg } from "../../commands/identityArg.js";

export type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

/** Sort: the system forum first, then featured, then name A→Z. The rail
 *  reads top-to-bottom as "home, curated picks, everything else". */
export function catalogRank(f: { isSystem: boolean; status: string }): number {
  if (f.isSystem) return 0;
  if (f.status === "featured") return 1;
  return 2;
}

/** Board-name shape shared by the create/rename console endpoints. */
export const FORUM_BOARD_NAME_RX = /^[\p{L}\p{N}_\-' ]{1,40}$/u;

/* =====================================================================
 *  Image upload helpers — same posture as the emoticon pipeline: base64
 *  data-URL bodies, a small magic-byte whitelist, per-purpose byte caps,
 *  content-hashed filenames under /uploads/forums/ so re-uploads dedupe
 *  and replacements bust caches with a fresh URL.
 * ===================================================================== */
const FORUM_IMAGE_TYPES: Array<{ mime: string; ext: string; magic: number[] }> = [
  { mime: "image/png", ext: "png", magic: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "image/jpeg", ext: "jpg", magic: [0xff, 0xd8, 0xff] },
  { mime: "image/webp", ext: "webp", magic: [0x52, 0x49, 0x46, 0x46] },
  { mime: "image/gif", ext: "gif", magic: [0x47, 0x49, 0x46, 0x38] },
];

function decodeForumDataUrl(dataUrl: string, maxBytes: number): Buffer | { error: string } {
  const m = /^data:image\/[a-z+]+;base64,(.+)$/i.exec(dataUrl.trim());
  if (!m) return { error: "expected a base64 image data URL" };
  let bytes: Buffer;
  try { bytes = Buffer.from(m[1]!, "base64"); }
  catch { return { error: "bad base64 payload" }; }
  if (bytes.length === 0) return { error: "empty image" };
  if (bytes.length > maxBytes) return { error: `image too large (max ${Math.round(maxBytes / 1024)}KB)` };
  return bytes;
}

function sniffForumImage(bytes: Buffer): { mime: string; ext: string } | null {
  for (const t of FORUM_IMAGE_TYPES) {
    if (bytes.length >= t.magic.length && t.magic.every((b, i) => bytes[i] === b)) return t;
  }
  return null;
}

/** Write a content-hashed forum image; returns its public URL. */
export async function writeForumImage(
  forumsDir: string,
  prefix: string,
  dataUrl: string,
  maxBytes: number,
): Promise<{ url: string } | { error: string; status: number }> {
  const decoded = decodeForumDataUrl(dataUrl, maxBytes);
  if ("error" in decoded) return { error: decoded.error, status: 400 };
  const detected = sniffForumImage(decoded);
  if (!detected) return { error: "unsupported image type (png, jpg, webp, gif only)", status: 415 };
  const hash = createHash("sha256").update(decoded).digest("hex").slice(0, 16);
  const filename = `${prefix}-${hash}.${detected.ext}`;
  await mkdir(forumsDir, { recursive: true });
  await writeFile(join(forumsDir, filename), decoded);
  return { url: `/uploads/forums/${filename}` };
}

/** Best-effort removal of a replaced /uploads/forums/ file. */
export function unlinkForumImage(forumsDir: string, url: string | null | undefined): void {
  if (!url?.startsWith("/uploads/forums/")) return;
  const filename = url.slice("/uploads/forums/".length);
  if (filename) unlink(join(forumsDir, filename)).catch(() => { /* best-effort */ });
}

/* =====================================================================
 *  Per-server topic-card author flair (Servers Lift).
 *
 *  Resolves each topic author's rank sigil, avatar-border frame, and
 *  name style from the cosmetics they earned/equipped ON THE SERVER THE
 *  FORUM IS AFFILIATED TO (`forums.serverId`). This is the SAME per-
 *  server read `realtime/broadcast.ts` `currentOccupants` runs for the
 *  chat userlist, lifted to the forum topic list and BATCHED over the
 *  set of (userId, characterId) author identities so a 30-card page is
 *  a fixed handful of queries, not N+1.
 *
 *  Scope rule mirrors the rest of the engine: a topic authored AS a
 *  character reads the character pool (`character_earning` + the
 *  character-owned cosmetic tables); an OOC topic (characterId null)
 *  reads the master pool (`user_earning` / `user_active_cosmetics` +
 *  the user-owned cosmetic tables). Every read is scoped
 *  `eq(serverId, sid)`.
 *
 *  CALLER CONTRACT: only call this when the forum HAS a server
 *  affiliation. A forum with `serverId === null` ships NO flair (the
 *  card renders bare) — that gate lives at the call site.
 * ===================================================================== */
interface TopicAuthorFlair {
  rankKey: string | null;
  tier: number | null;
  selectedBorderRankKey: string | null;
  selectedFreeformBorderKey: string | null;
  freeformBorderConfig: Record<string, string> | null;
  nameStyleKey: string | null;
  nameStyleConfig: Record<string, unknown> | null;
}

function parseStyleConfig(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try { return JSON.parse(json) as Record<string, unknown>; }
  catch { return null; }
}

function parseFreeformBorderConfig(json: string | null): Record<string, string> | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && v.length > 0) out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch { return null; }
}

/**
 * Batch-resolve per-server flair for a set of topic authors, keyed by the
 * `${userId}::${characterId ?? ""}` identity tuple. Returns an empty map
 * when there are no authors. Identities absent from a given cosmetic
 * table simply resolve to null for that slot (fresh / unequipped on this
 * server), so a card always renders gracefully.
 */
export async function resolveTopicAuthorFlair(
  db: Db,
  sid: string,
  authors: ReadonlyArray<{ userId: string; characterId: string | null }>,
): Promise<Map<string, TopicAuthorFlair>> {
  const out = new Map<string, TopicAuthorFlair>();
  if (!authors.length) return out;

  // Dedupe the identity set; the page can repeat an author across cards.
  const seen = new Set<string>();
  const ids: Array<{ userId: string; characterId: string | null }> = [];
  for (const a of authors) {
    const key = `${a.userId}::${a.characterId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push(a);
  }
  const userIds = [...new Set(ids.map((i) => i.userId))];
  const charIds = [...new Set(ids.map((i) => i.characterId).filter((v): v is string => !!v))];

  /* ---- Master (OOC) pool: user_earning + user_active_cosmetics ---- */
  const userEarningRows = userIds.length
    ? await db
        .select({
          userId: userEarning.userId,
          rankKey: userEarning.rankKey,
          tier: userEarning.tier,
          selectedBorderRankKey: userEarning.selectedBorderRankKey,
          selectedFreeformBorderKey: userEarning.selectedFreeformBorderKey,
        })
        .from(userEarning)
        .where(and(eq(userEarning.serverId, sid), inArray(userEarning.userId, userIds)))
    : [];
  const userEarningBy = new Map(userEarningRows.map((r) => [r.userId, r]));
  // user_active_cosmetics is ALSO per-server partitioned (migration 0285),
  // so scope to `sid` — without it the identity-keyed map below would
  // collapse multiple servers' rows for the same user (last write wins).
  const userActiveRows = userIds.length
    ? await db
        .select({ userId: userActiveCosmetics.userId, activeNameStyleKey: userActiveCosmetics.activeNameStyleKey })
        .from(userActiveCosmetics)
        .where(and(eq(userActiveCosmetics.serverId, sid), inArray(userActiveCosmetics.userId, userIds)))
    : [];
  const masterStyleKeyByUser = new Map(
    userActiveRows
      .filter((r): r is { userId: string; activeNameStyleKey: string } => r.activeNameStyleKey !== null)
      .map((r) => [r.userId, r.activeNameStyleKey]),
  );

  /* ---- Character pool: character_earning ---- */
  const charEarningRows = charIds.length
    ? await db
        .select({
          characterId: characterEarning.characterId,
          rankKey: characterEarning.rankKey,
          tier: characterEarning.tier,
          selectedBorderRankKey: characterEarning.selectedBorderRankKey,
          selectedFreeformBorderKey: characterEarning.selectedFreeformBorderKey,
          activeNameStyleKey: characterEarning.activeNameStyleKey,
        })
        .from(characterEarning)
        .where(and(eq(characterEarning.serverId, sid), inArray(characterEarning.characterId, charIds)))
    : [];
  const charEarningBy = new Map(charEarningRows.map((r) => [r.characterId, r]));

  /* ---- Owned name-style configs. These ownership tables are ALSO
   *      per-server partitioned (migration 0285, serverId in the PK), so
   *      we scope the config read to `sid` — an identity may have tuned a
   *      style's colors differently per server, and scoping also keeps the
   *      `(identity, styleKey)`-keyed map from collapsing two servers'
   *      rows into one. ---- */
  const usersWithStyle = [...masterStyleKeyByUser.keys()];
  const charsWithStyle = charEarningRows
    .filter((r) => r.activeNameStyleKey !== null)
    .map((r) => r.characterId);
  const masterStyleRows = usersWithStyle.length
    ? await db
        .select({ userId: userOwnedNameStyles.userId, styleKey: userOwnedNameStyles.styleKey, configJson: userOwnedNameStyles.configJson })
        .from(userOwnedNameStyles)
        .where(and(eq(userOwnedNameStyles.serverId, sid), inArray(userOwnedNameStyles.userId, usersWithStyle)))
    : [];
  const charStyleRows = charsWithStyle.length
    ? await db
        .select({ characterId: characterOwnedNameStyles.characterId, styleKey: characterOwnedNameStyles.styleKey, configJson: characterOwnedNameStyles.configJson })
        .from(characterOwnedNameStyles)
        .where(and(eq(characterOwnedNameStyles.serverId, sid), inArray(characterOwnedNameStyles.characterId, charsWithStyle)))
    : [];
  const styleConfigByKey = new Map<string, Record<string, unknown> | null>();
  for (const r of masterStyleRows) styleConfigByKey.set(`u::${r.userId}::${r.styleKey}`, parseStyleConfig(r.configJson));
  for (const r of charStyleRows) styleConfigByKey.set(`c::${r.characterId}::${r.styleKey}`, parseStyleConfig(r.configJson));

  /* ---- Owned free-form border color configs (same ownership rule). ---- */
  const usersWithFreeform = userEarningRows
    .filter((r) => r.selectedFreeformBorderKey !== null)
    .map((r) => r.userId);
  const charsWithFreeform = charEarningRows
    .filter((r) => r.selectedFreeformBorderKey !== null)
    .map((r) => r.characterId);
  const masterBorderRows = usersWithFreeform.length
    ? await db
        .select({ userId: userOwnedFreeformBorders.userId, borderKey: userOwnedFreeformBorders.borderKey, configJson: userOwnedFreeformBorders.configJson })
        .from(userOwnedFreeformBorders)
        .where(and(eq(userOwnedFreeformBorders.serverId, sid), inArray(userOwnedFreeformBorders.userId, usersWithFreeform)))
    : [];
  const charBorderRows = charsWithFreeform.length
    ? await db
        .select({ characterId: characterOwnedFreeformBorders.characterId, borderKey: characterOwnedFreeformBorders.borderKey, configJson: characterOwnedFreeformBorders.configJson })
        .from(characterOwnedFreeformBorders)
        .where(and(eq(characterOwnedFreeformBorders.serverId, sid), inArray(characterOwnedFreeformBorders.characterId, charsWithFreeform)))
    : [];
  const freeformConfigByKey = new Map<string, Record<string, string> | null>();
  for (const r of masterBorderRows) freeformConfigByKey.set(`u::${r.userId}::${r.borderKey}`, parseFreeformBorderConfig(r.configJson));
  for (const r of charBorderRows) freeformConfigByKey.set(`c::${r.characterId}::${r.borderKey}`, parseFreeformBorderConfig(r.configJson));

  /* ---- Assemble one flair record per author identity. ---- */
  for (const id of ids) {
    const key = `${id.userId}::${id.characterId ?? ""}`;
    if (id.characterId) {
      const e = charEarningBy.get(id.characterId);
      const styleKey = e?.activeNameStyleKey ?? null;
      const freeformKey = e?.selectedFreeformBorderKey ?? null;
      out.set(key, {
        rankKey: e?.rankKey ?? null,
        tier: e?.tier ?? null,
        selectedBorderRankKey: e?.selectedBorderRankKey ?? null,
        selectedFreeformBorderKey: freeformKey,
        freeformBorderConfig: freeformKey ? (freeformConfigByKey.get(`c::${id.characterId}::${freeformKey}`) ?? null) : null,
        nameStyleKey: styleKey,
        nameStyleConfig: styleKey ? (styleConfigByKey.get(`c::${id.characterId}::${styleKey}`) ?? null) : null,
      });
    } else {
      const e = userEarningBy.get(id.userId);
      const styleKey = masterStyleKeyByUser.get(id.userId) ?? null;
      const freeformKey = e?.selectedFreeformBorderKey ?? null;
      out.set(key, {
        rankKey: e?.rankKey ?? null,
        tier: e?.tier ?? null,
        selectedBorderRankKey: e?.selectedBorderRankKey ?? null,
        selectedFreeformBorderKey: freeformKey,
        freeformBorderConfig: freeformKey ? (freeformConfigByKey.get(`u::${id.userId}::${freeformKey}`) ?? null) : null,
        nameStyleKey: styleKey,
        nameStyleConfig: styleKey ? (styleConfigByKey.get(`u::${id.userId}::${styleKey}`) ?? null) : null,
      });
    }
  }
  return out;
}

/* =====================================================================
 *  Gate helpers shared across the console + moderation + membership
 *  sub-registrars. Each takes `db` + the raw request so a sub-registrar
 *  can wrap it in a thin closure and keep its handler bodies verbatim.
 * ===================================================================== */

/** Owner-or-staff gate shared by the console endpoints. */
export async function requireForumOwner(
  db: Db,
  req: Parameters<typeof getSessionUser>[0],
  forumId: string,
) {
  const me = await getSessionUser(req, db);
  if (!me) return { fail: { code: 401 as const, error: "auth" } };
  const a = await forumAuthority(db, me, forumId);
  if (!a.forum) return { fail: { code: 404 as const, error: "no forum" } };
  if (!a.isOwner) return { fail: { code: 403 as const, error: "forum owner only" } };
  return { me, forum: a.forum, authority: a };
}

/** Gate for an action a mod CAN be granted: passes for the owner/staff
 *  (who hold every key) OR a mod holding the specific granular permission.
 *  Returns the resolved authority so the handler can reason further. */
export async function requireForumPermission(
  db: Db,
  req: Parameters<typeof getSessionUser>[0],
  forumId: string,
  key: ForumModPermission,
) {
  const me = await getSessionUser(req, db);
  if (!me) return { fail: { code: 401 as const, error: "auth" } };
  const a = await forumAuthority(db, me, forumId);
  if (!a.forum) return { fail: { code: 404 as const, error: "no forum" } };
  if (!forumCan(a, key)) return { fail: { code: 403 as const, error: "you don't have that forum permission" } };
  return { me, forum: a.forum, authority: a };
}

/** Resolve a mod/ban target to a user account. Accepts `@id:`/`@cid:`
 *  tokens and bare names (the same resolver every command uses);
 *  ambiguous names get a "paste the token" message. */
export async function resolveForumTarget(db: Db, raw: string): Promise<
  | { ok: true; userId: string; username: string }
  | { ok: false; error: string }
> {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "Name or @id:/@cid: token required." };
  const res = await resolveIdentityArg(db, trimmed);
  if (res.kind === "none") return { ok: false, error: `No one matches "${trimmed}".` };
  if (res.kind === "ambiguous") {
    return { ok: false, error: `"${trimmed}" matches several identities - paste their @id: token from the profile.` };
  }
  return { ok: true, userId: res.target.userId, username: res.target.masterUsername };
}
