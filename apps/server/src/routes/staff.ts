import type { FastifyInstance } from "fastify";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { clampAvatarCrop, roleRank } from "@thekeep/shared";
import {
  userActiveCosmetics,
  userEarning,
  userOwnedFreeformBorders,
  userOwnedNameStyles,
  users,
} from "../db/schema.js";
import type { Db } from "../db/index.js";
import { getSessionUser } from "./auth.js";

/** Roles that appear on the Staff page, masteradmin first. */
const STAFF_ROLES = ["mod", "admin", "masteradmin"] as const;

/** Card field caps. Mirrored client-side; the server is authoritative. */
const MAX_STAFF_BIO = 120;
const MAX_STAFF_INTRO = 256;

const staffCardBody = z
  .object({
    // `null` / "" clears the field. Trimmed + capped below.
    bio: z.string().max(MAX_STAFF_BIO * 2).nullable().optional(),
    intro: z.string().max(MAX_STAFF_INTRO * 2).nullable().optional(),
  })
  .strict();

function parseConfig(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function registerStaffRoutes(app: FastifyInstance, db: Db): Promise<void> {
  /* ---------- Staff directory ---------- */
  app.get("/staff", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }

    // The team: every non-disabled mod/admin/masteradmin. Master
    // (OOC) identities only, staff status is an account-level fact and
    // the card shows the person behind the keep, not a character.
    const rows = await db
      .select()
      .from(users)
      .where(and(inArray(users.role, [...STAFF_ROLES]), isNull(users.disabledAt)));
    if (rows.length === 0) return { staff: [] };

    const ids = rows.map((u) => u.id);

    // Equipped cosmetics, batched. Avatar/crop ride on the user row;
    // name style + border come from the same tables the userlist and
    // profile reads use, so a staff card matches how the person appears
    // everywhere else.
    const cosmeticRows = await db
      .select({
        userId: userActiveCosmetics.userId,
        nameStyleKey: userActiveCosmetics.activeNameStyleKey,
      })
      .from(userActiveCosmetics)
      .where(inArray(userActiveCosmetics.userId, ids));
    const nameStyleByUser = new Map(cosmeticRows.map((r) => [r.userId, r.nameStyleKey]));

    const borderRows = await db
      .select({
        userId: userEarning.userId,
        borderRankKey: userEarning.selectedBorderRankKey,
        freeformBorderKey: userEarning.selectedFreeformBorderKey,
      })
      .from(userEarning)
      .where(inArray(userEarning.userId, ids));
    const borderByUser = new Map(borderRows.map((r) => [r.userId, r]));

    // Per-user owned name-style + freeform-border config blobs (the
    // color customizations). Keyed by `${userId}::${key}` so we pick the
    // config for the equipped key only.
    const ownedStyleRows = await db
      .select({
        userId: userOwnedNameStyles.userId,
        styleKey: userOwnedNameStyles.styleKey,
        configJson: userOwnedNameStyles.configJson,
      })
      .from(userOwnedNameStyles)
      .where(inArray(userOwnedNameStyles.userId, ids));
    const styleConfigByUserKey = new Map(
      ownedStyleRows.map((r) => [`${r.userId}::${r.styleKey}`, r.configJson]),
    );
    const ownedBorderRows = await db
      .select({
        userId: userOwnedFreeformBorders.userId,
        borderKey: userOwnedFreeformBorders.borderKey,
        configJson: userOwnedFreeformBorders.configJson,
      })
      .from(userOwnedFreeformBorders)
      .where(inArray(userOwnedFreeformBorders.userId, ids));
    const borderConfigByUserKey = new Map(
      ownedBorderRows.map((r) => [`${r.userId}::${r.borderKey}`, r.configJson]),
    );

    const staff = rows
      .map((u) => {
        const nameStyleKey = nameStyleByUser.get(u.id) ?? null;
        const border = borderByUser.get(u.id);
        const borderRankKey = border?.borderRankKey ?? null;
        const freeformBorderKey = border?.freeformBorderKey ?? null;
        return {
          userId: u.id,
          username: u.username,
          role: u.role,
          avatarUrl: u.avatarUrl,
          avatarCrop: clampAvatarCrop({
            zoom: u.avatarZoom,
            offsetX: u.avatarOffsetX,
            offsetY: u.avatarOffsetY,
          }),
          borderRankKey,
          freeformBorderKey,
          freeformConfig: freeformBorderKey
            ? parseConfig(borderConfigByUserKey.get(`${u.id}::${freeformBorderKey}`) ?? null)
            : null,
          nameStyleKey,
          nameStyleConfig: nameStyleKey
            ? parseConfig(styleConfigByUserKey.get(`${u.id}::${nameStyleKey}`) ?? null)
            : null,
          bio: u.staffBio ?? null,
          intro: u.staffIntro ?? null,
          // The viewer owns this card, the client surfaces an inline edit
          // affordance only on their own. The PUT re-checks server-side.
          canEdit: u.id === me.id,
        };
      })
      // Highest tier first (masteradmin → admin → mod), then alphabetical
      // so the ordering reads as a clear hierarchy.
      .sort((a, b) => {
        const r = roleRank(b.role) - roleRank(a.role);
        return r !== 0 ? r : a.username.localeCompare(b.username);
      });

    return { staff };
  });

  /* ---------- Edit own staff card ---------- */
  app.put<{ Body: unknown }>("/me/staff-card", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    // Only staff have a card to edit.
    if (roleRank(me.role) < roleRank("mod")) {
      reply.code(403);
      return { error: "not staff" };
    }
    let body;
    try { body = staffCardBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    // Trim + cap. Empty after trim clears the field (null), so a staff
    // member can blank their card back out.
    const norm = (v: string | null | undefined, max: number): string | null => {
      if (v == null) return null;
      const t = v.trim();
      if (!t) return null;
      return t.length > max ? t.slice(0, max) : t;
    };
    const patch: { staffBio?: string | null; staffIntro?: string | null } = {};
    if ("bio" in body) patch.staffBio = norm(body.bio, MAX_STAFF_BIO);
    if ("intro" in body) patch.staffIntro = norm(body.intro, MAX_STAFF_INTRO);
    if (Object.keys(patch).length === 0) return { ok: true };

    await db.update(users).set(patch).where(eq(users.id, me.id));
    return {
      ok: true,
      bio: patch.staffBio ?? null,
      intro: patch.staffIntro ?? null,
    };
  });
}
