import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type {
  AdminAffiliate,
  MyAffiliate,
  PermissionKey,
  PublicAffiliateCard,
  Role,
} from "@thekeep/shared";
import {
  AFFILIATE_LIMITS,
  affiliateLinkBackUrl,
  isValidAffiliateUrl,
  parseTagsJson,
  serializeTags,
} from "@thekeep/shared";
import { affiliateClickLog, affiliates, users } from "../db/schema.js";
import type { DbAffiliate } from "../db/schema.js";
import { computePad, type PadResult } from "../affiliates/padding.js";
import { recordAudit } from "../audit.js";
import { hasPermission } from "../auth/permissions.js";
import { originFromRequest } from "../seo.js";
import type { Db } from "../db/index.js";
import { getSessionUser } from "./auth.js";

/* ---------- zod bodies ---------- */

/** Self-service submission: partner-supplied text + URLs. Optional icon/banner. */
const submitBody = z.object({
  title: z.string().min(1).max(AFFILIATE_LIMITS.title),
  description: z.string().min(1).max(AFFILIATE_LIMITS.description),
  targetUrl: z.string().min(1).max(AFFILIATE_LIMITS.url),
  iconUrl: z.string().max(AFFILIATE_LIMITS.url).optional(),
  bannerUrl: z.string().max(AFFILIATE_LIMITS.url).optional(),
  tags: z.array(z.string()).max(50).optional(),
}).strict();

/** Owner edit: same card fields, all optional. */
const meUpdateBody = z.object({
  title: z.string().min(1).max(AFFILIATE_LIMITS.title).optional(),
  description: z.string().min(1).max(AFFILIATE_LIMITS.description).optional(),
  targetUrl: z.string().min(1).max(AFFILIATE_LIMITS.url).optional(),
  iconUrl: z.string().max(AFFILIATE_LIMITS.url).nullable().optional(),
  bannerUrl: z.string().max(AFFILIATE_LIMITS.url).nullable().optional(),
  tags: z.array(z.string()).max(50).nullable().optional(),
}).strict();

/** Admin create: an authored `card` OR a legacy raw-`html` row (back-compat). */
const adminCreateBody = z.object({
  kind: z.enum(["card", "html"]).optional(),
  // Card fields. Optional URLs accept `null` too — the admin form sends a blank
  // icon/banner up as null (so an existing one can be cleared on edit).
  title: z.string().min(1).max(AFFILIATE_LIMITS.title).optional(),
  description: z.string().min(1).max(AFFILIATE_LIMITS.description).optional(),
  targetUrl: z.string().min(1).max(AFFILIATE_LIMITS.url).optional(),
  iconUrl: z.string().max(AFFILIATE_LIMITS.url).nullable().optional(),
  bannerUrl: z.string().max(AFFILIATE_LIMITS.url).nullable().optional(),
  tags: z.array(z.string()).max(50).optional(),
  // Legacy html fields.
  label: z.string().min(1).max(80).optional(),
  html: z.string().min(1).max(8000).optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
  // Traffic padding (synthetic in/out; global-admin only).
  padInEnabled: z.boolean().optional(),
  padInMax: z.number().int().min(0).max(AFFILIATE_LIMITS.padDailyMax).optional(),
  padOutEnabled: z.boolean().optional(),
  padOutMax: z.number().int().min(0).max(AFFILIATE_LIMITS.padDailyMax).optional(),
}).strict();

/** Admin edit: any field, incl. review state + visibility. */
const adminUpdateBody = z.object({
  title: z.string().min(1).max(AFFILIATE_LIMITS.title).optional(),
  description: z.string().min(1).max(AFFILIATE_LIMITS.description).optional(),
  targetUrl: z.string().min(1).max(AFFILIATE_LIMITS.url).nullable().optional(),
  iconUrl: z.string().max(AFFILIATE_LIMITS.url).nullable().optional(),
  bannerUrl: z.string().max(AFFILIATE_LIMITS.url).nullable().optional(),
  label: z.string().min(1).max(80).optional(),
  html: z.string().min(1).max(8000).nullable().optional(),
  status: z.enum(["pending", "approved", "rejected", "disabled"]).optional(),
  reviewNote: z.string().max(500).nullable().optional(),
  tags: z.array(z.string()).max(50).nullable().optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
  // Traffic padding (synthetic in/out; global-admin only). `resetPad` wipes the
  // accumulated synthetic totals back to zero.
  padInEnabled: z.boolean().optional(),
  padInMax: z.number().int().min(0).max(AFFILIATE_LIMITS.padDailyMax).optional(),
  padOutEnabled: z.boolean().optional(),
  padOutMax: z.number().int().min(0).max(AFFILIATE_LIMITS.padDailyMax).optional(),
  resetPad: z.boolean().optional(),
}).strict();

interface SessionUserCtx {
  id: string;
  role: Role;
}

/** Turn a failed zod parse into a human reason, so a rejected save tells the
 *  admin/member WHICH field was wrong instead of a bare "invalid body". */
function badBody(err: unknown): string {
  if (err instanceof z.ZodError) {
    const first = err.issues[0];
    if (first) return `invalid body: ${first.path.join(".") || "body"} ${first.message}`;
  }
  return "invalid body";
}

async function requireAdmin(
  req: FastifyRequest,
  db: Db,
  key: PermissionKey,
): Promise<SessionUserCtx | null> {
  const me = await getSessionUser(req, db);
  if (!me || !(await hasPermission(me, key, db))) return null;
  return me;
}

/** Re-select a row we just wrote by id. It always exists (we own the id), so
 *  this narrows the `[0]` off `T | undefined` for the mappers. */
async function loadRow(db: Db, id: string): Promise<DbAffiliate> {
  const row = (await db.select().from(affiliates).where(eq(affiliates.id, id)).limit(1))[0];
  if (!row) throw new Error(`affiliate ${id} vanished after write`);
  return row;
}

/* ---------- traffic padding ---------- */

/**
 * Settle a card's padding at `now`: compute the effective (real + synthetic)
 * counts and, when the day rolled over (or padding was just (re)configured),
 * persist the rollover patch — at most once per day per card. Mutates `row` in
 * place with the persisted values so the mappers see a consistent snapshot.
 */
async function applyPad(db: Db, row: DbAffiliate, now: Date): Promise<PadResult> {
  const res = computePad(row, now);
  if (res.patch) {
    await db.update(affiliates).set(res.patch).where(eq(affiliates.id, row.id));
    Object.assign(row, res.patch);
  }
  return res;
}

/* ---------- shape mappers ---------- */

/** Public card projection (no owner/PII); only approved `card` rows reach it.
 *  `clicksIn`/`clicksOut` carry the SHOWN totals (real + any synthetic pad). */
function toPublicCard(r: DbAffiliate, pad: PadResult): PublicAffiliateCard {
  return {
    id: r.id,
    title: r.title ?? "",
    description: r.description ?? "",
    iconUrl: r.iconUrl ?? null,
    bannerUrl: r.bannerUrl ?? null,
    clicksIn: pad.effIn,
    clicksOut: pad.effOut,
    tags: parseTagsJson(r.tagsJson),
  };
}

/** Owner projection: adds status + link-back (present only once approved). */
function toMyAffiliate(r: DbAffiliate, origin: string, pad: PadResult): MyAffiliate {
  return {
    ...toPublicCard(r, pad),
    status: r.status,
    targetUrl: r.targetUrl ?? "",
    reviewNote: r.reviewNote ?? null,
    hash: r.hash ?? null,
    linkBackUrl:
      r.status === "approved" && r.hash ? affiliateLinkBackUrl(origin, r.hash) : null,
    createdAt: +r.createdAt,
  };
}

/** Full admin projection: every column plus the joined owner display name and the
 *  real-vs-padded traffic breakdown + pad config. */
function toAdminAffiliate(
  r: DbAffiliate,
  ownerName: string | null,
  origin: string,
  pad: PadResult,
): AdminAffiliate {
  return {
    ...toMyAffiliate(r, origin, pad),
    kind: r.kind,
    label: r.label,
    html: r.html ?? null,
    enabled: r.enabled,
    sortOrder: r.sortOrder,
    ownerUserId: r.ownerUserId ?? null,
    ownerName,
    reviewedBy: r.reviewedBy ?? null,
    reviewedAt: r.reviewedAt ? +r.reviewedAt : null,
    updatedAt: +r.updatedAt,
    padInEnabled: r.padInEnabled,
    padInMax: r.padInMax,
    padOutEnabled: r.padOutEnabled,
    padOutMax: r.padOutMax,
    realClicksIn: r.clicksIn,
    realClicksOut: r.clicksOut,
    padClicksIn: pad.padIn,
    padClicksOut: pad.padOut,
  };
}

/* ---------- click throttle (§9) ---------- */

/**
 * Count a link-back hit at most once per (affiliate, direction, IP) inside the
 * throttle window, so a refresh loop can't inflate the top-sites counters. When
 * a fresh hit lands we log it and bump the matching `clicks_in`/`clicks_out`;
 * a repeat inside the window is silently skipped. Best-effort — a logging hiccup
 * never blocks the redirect (the caller still 302s).
 */
async function countClick(
  db: Db,
  affiliateId: string,
  direction: "in" | "out",
  ip: string,
): Promise<void> {
  try {
    const since = new Date(Date.now() - AFFILIATE_LIMITS.clickThrottleMs);
    const recent = (await db
      .select({ id: affiliateClickLog.id })
      .from(affiliateClickLog)
      .where(and(
        eq(affiliateClickLog.affiliateId, affiliateId),
        eq(affiliateClickLog.direction, direction),
        eq(affiliateClickLog.ip, ip),
        gt(affiliateClickLog.at, since),
      ))
      .limit(1))[0];
    if (recent) return; // already counted this IP/direction inside the window.

    await db.insert(affiliateClickLog).values({
      id: nanoid(),
      affiliateId,
      direction,
      ip,
    });
    // Atomic `column = column + 1` so concurrent hits don't clobber each other
    // through a read-modify-write race — the increment stays inside SQLite.
    await db
      .update(affiliates)
      .set(
        direction === "in"
          ? { clicksIn: sql`${affiliates.clicksIn} + 1` }
          : { clicksOut: sql`${affiliates.clicksOut} + 1` },
      )
      .where(eq(affiliates.id, affiliateId));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[affiliates] click count failed", { affiliateId, direction, err });
  }
}

/**
 * Low-level Fastify-version-independent 302 (raw code + Location header) so we
 * don't depend on `reply.redirect()` argument order. Always send an absolute or
 * root-relative target we control.
 */
function redirect(reply: FastifyReply, to: string): FastifyReply {
  return reply.code(302).header("location", to).send();
}

/**
 * Affiliate / partner / sponsor management — Affiliates v2 "Roleplay
 * Communities" mini top-sites / webring.
 *
 * Public:
 *   `GET  /affiliates`              - approved `card` rows → PublicAffiliateCard[].
 *   `GET  /a/:hash`                 - inbound link-back; count 'in', 302 → "/".
 *   `GET  /affiliates/out/:id`      - outbound; count 'out', 302 → targetUrl.
 *
 * Self-service (logged-in member owns the entry):
 *   `POST   /affiliates/submit`     - submit a card (status='pending').
 *   `GET    /me/affiliates`         - owner's entries (+ link-back once approved).
 *   `PATCH  /me/affiliates/:id`     - owner edit (approved → back to pending).
 *   `DELETE /me/affiliates/:id`     - owner withdraw.
 *
 * Admin (`view_admin_affiliates` read / `manage_affiliates` write):
 *   `GET    /admin/affiliates`      - ALL rows (incl. pending + legacy html).
 *   `POST   /admin/affiliates`      - admin card OR legacy html create.
 *   `PATCH  /admin/affiliates/:id`  - any field incl. status/sortOrder/enabled.
 *   `DELETE /admin/affiliates/:id`  - delete (cascades click log).
 *
 * Trust posture: `card` rows are structured data rendered only as text +
 * `<img>`/`<a>` (URLs validated http/https), so no XSS surface. Legacy `html`
 * rows keep the admin-trusted raw-HTML contract (same as customHeadHtml).
 */
export async function registerAffiliateRoutes(app: FastifyInstance, db: Db): Promise<void> {
  /* ---------------- public ---------------- */

  /**
   * Approved `card` rows only, topsite-ranked (busiest first by inbound +
   * outbound traffic, newest as the tiebreak — no manual sort order). Legacy
   * `html` rows are NOT surfaced here; they're archival, managed only from the
   * admin panel.
   */
  // Public Top Communities board: anonymous, polled, and it does a per-row
  // padding compute (with a conditional write) over every approved card. Cap
  // per-IP so a loop/poll can't amplify those reads+writes on the SQLite loop.
  app.get("/affiliates", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async () => {
    const cards = await db
      .select()
      .from(affiliates)
      .where(and(eq(affiliates.kind, "card"), eq(affiliates.status, "approved")));
    // Rank by the SHOWN totals (real + synthetic pad), busiest first, newest as
    // the tiebreak. Sorting in JS because the padded amount is computed per-read.
    const now = new Date();
    const items: Array<{ card: PublicAffiliateCard; total: number; createdAt: number }> = [];
    for (const r of cards) {
      const pad = await applyPad(db, r, now);
      items.push({ card: toPublicCard(r, pad), total: pad.effIn + pad.effOut, createdAt: +r.createdAt });
    }
    items.sort((a, b) => b.total - a.total || a.createdAt - b.createdAt);
    return { affiliates: items.map((i) => i.card) };
  });

  /**
   * Inbound link-back. The partner pastes this on their site. Count an `in`
   * hit for the owning card, then always 302 → "/" — even on a miss, so we
   * don't leak which hashes are valid.
   */
  app.get<{ Params: { hash: string } }>("/a/:hash", async (req, reply) => {
    const row = (await db
      .select()
      .from(affiliates)
      .where(eq(affiliates.hash, req.params.hash))
      .limit(1))[0];
    // Only count for live cards; a rejected/disabled row still redirects but
    // doesn't accrue traffic.
    if (row && row.kind === "card" && row.status === "approved") {
      await countClick(db, row.id, "in", req.ip);
    }
    return redirect(reply, "/");
  });

  /**
   * Outbound click-through from one of our cards. Count an `out` hit, then 302
   * → the card's target. On a miss / non-approved / missing target, fall back
   * to "/".
   */
  app.get<{ Params: { id: string } }>("/affiliates/out/:id", async (req, reply) => {
    const row = (await db
      .select()
      .from(affiliates)
      .where(eq(affiliates.id, req.params.id))
      .limit(1))[0];
    if (
      !row ||
      row.kind !== "card" ||
      row.status !== "approved" ||
      !row.targetUrl ||
      !isValidAffiliateUrl(row.targetUrl)
    ) {
      return redirect(reply, "/");
    }
    await countClick(db, row.id, "out", req.ip);
    return redirect(reply, row.targetUrl);
  });

  /* ---------------- self-service ---------------- */

  /** Submit a card. Enforces per-user total + pending caps and URL safety. */
  app.post<{ Body: unknown }>("/affiliates/submit", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "unauthorized" }; }

    let body;
    try { body = submitBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: badBody(err) }; }

    // URL safety — target is required, icon/banner optional.
    if (!isValidAffiliateUrl(body.targetUrl)) {
      reply.code(400); return { error: "invalid target url" };
    }
    if (body.iconUrl && !isValidAffiliateUrl(body.iconUrl)) {
      reply.code(400); return { error: "invalid icon url" };
    }
    if (body.bannerUrl && !isValidAffiliateUrl(body.bannerUrl)) {
      reply.code(400); return { error: "invalid banner url" };
    }

    // Submission limits (§9): total owned + simultaneous un-reviewed.
    const mine = await db
      .select({ status: affiliates.status })
      .from(affiliates)
      .where(eq(affiliates.ownerUserId, me.id));
    if (mine.length >= AFFILIATE_LIMITS.maxPerUser) {
      reply.code(429);
      return { error: `You can list up to ${AFFILIATE_LIMITS.maxPerUser} communities.` };
    }
    const pending = mine.filter((r) => r.status === "pending").length;
    if (pending >= AFFILIATE_LIMITS.maxPendingPerUser) {
      reply.code(429);
      return { error: `You already have ${AFFILIATE_LIMITS.maxPendingPerUser} submissions awaiting review.` };
    }

    const id = nanoid();
    const title = body.title.trim();
    await db.insert(affiliates).values({
      id,
      kind: "card",
      status: "pending",
      ownerUserId: me.id,
      // `label` is the admin-only nickname; seed it from the title.
      label: title,
      html: "",
      title,
      description: body.description.trim(),
      iconUrl: body.iconUrl?.trim() || null,
      bannerUrl: body.bannerUrl?.trim() || null,
      targetUrl: body.targetUrl.trim(),
      tagsJson: serializeTags(body.tags ?? []),
      hash: nanoid(10),
      sortOrder: 0,
    });
    const row = await loadRow(db, id);
    const pad = await applyPad(db, row, new Date());
    reply.code(201);
    return toMyAffiliate(row, originFromRequest(req), pad);
  });

  /** Owner's own entries, newest first, with link-back once approved. */
  app.get("/me/affiliates", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "unauthorized" }; }
    const rows = await db
      .select()
      .from(affiliates)
      .where(eq(affiliates.ownerUserId, me.id))
      .orderBy(desc(affiliates.createdAt));
    const origin = originFromRequest(req);
    const now = new Date();
    const out: MyAffiliate[] = [];
    for (const r of rows) {
      const pad = await applyPad(db, r, now);
      out.push(toMyAffiliate(r, origin, pad));
    }
    return { affiliates: out };
  });

  /**
   * Owner edit. Editing an approved card sends it back through review
   * (status → pending, review note cleared) since the public copy changed.
   */
  app.patch<{ Params: { id: string }; Body: unknown }>("/me/affiliates/:id", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "unauthorized" }; }

    let body;
    try { body = meUpdateBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: badBody(err) }; }

    const existing = (await db
      .select()
      .from(affiliates)
      .where(eq(affiliates.id, req.params.id))
      .limit(1))[0];
    // 404 (not 403) when not the owner — don't reveal others' entries exist.
    if (!existing || existing.ownerUserId !== me.id) { reply.code(404); return { error: "not found" }; }

    // URL safety on any supplied URL.
    if (body.targetUrl !== undefined && !isValidAffiliateUrl(body.targetUrl)) {
      reply.code(400); return { error: "invalid target url" };
    }
    if (body.iconUrl != null && body.iconUrl !== "" && !isValidAffiliateUrl(body.iconUrl)) {
      reply.code(400); return { error: "invalid icon url" };
    }
    if (body.bannerUrl != null && body.bannerUrl !== "" && !isValidAffiliateUrl(body.bannerUrl)) {
      reply.code(400); return { error: "invalid banner url" };
    }

    const patch: Partial<DbAffiliate> = { updatedAt: new Date() };
    if (body.title !== undefined) { patch.title = body.title.trim(); patch.label = body.title.trim(); }
    if (body.description !== undefined) patch.description = body.description.trim();
    if (body.targetUrl !== undefined) patch.targetUrl = body.targetUrl.trim();
    if (body.iconUrl !== undefined) patch.iconUrl = body.iconUrl ? body.iconUrl.trim() : null;
    if (body.bannerUrl !== undefined) patch.bannerUrl = body.bannerUrl ? body.bannerUrl.trim() : null;
    if (body.tags !== undefined) patch.tagsJson = serializeTags(body.tags ?? []);

    // An edit to an already-approved card re-opens review.
    if (existing.status === "approved") {
      patch.status = "pending";
      patch.reviewNote = null;
    }

    await db.update(affiliates).set(patch).where(eq(affiliates.id, existing.id));
    const row = await loadRow(db, existing.id);
    const pad = await applyPad(db, row, new Date());
    return toMyAffiliate(row, originFromRequest(req), pad);
  });

  /** Owner withdraw. */
  app.delete<{ Params: { id: string } }>("/me/affiliates/:id", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "unauthorized" }; }
    const existing = (await db
      .select()
      .from(affiliates)
      .where(eq(affiliates.id, req.params.id))
      .limit(1))[0];
    if (!existing || existing.ownerUserId !== me.id) { reply.code(404); return { error: "not found" }; }
    await db.delete(affiliates).where(eq(affiliates.id, existing.id));
    return { ok: true };
  });

  /* ---------------- admin ---------------- */

  /**
   * ALL rows (incl. pending + legacy html) with the joined owner display name.
   * Pending first (the approval queue), then sortOrder / created_at.
   */
  app.get("/admin/affiliates", async (req, reply) => {
    const me = await requireAdmin(req, db, "view_admin_affiliates");
    if (!me) { reply.code(403); return { error: "forbidden", missing: "view_admin_affiliates" }; }
    // Owner display name is the account username (the master/login name;
    // there is no per-account display name column on `users`).
    const rows = await db
      .select({ affiliate: affiliates, ownerName: users.username })
      .from(affiliates)
      .leftJoin(users, eq(users.id, affiliates.ownerUserId));
    const origin = originFromRequest(req);
    const now = new Date();
    const items: Array<{ a: AdminAffiliate; total: number; createdAt: number }> = [];
    for (const r of rows) {
      const pad = await applyPad(db, r.affiliate, now);
      items.push({
        a: toAdminAffiliate(r.affiliate, r.ownerName ?? null, origin, pad),
        total: pad.effIn + pad.effOut,
        createdAt: +r.affiliate.createdAt,
      });
    }
    // Busiest first by SHOWN traffic (real + pad), newest as tiebreak; then a
    // stable pass floats pending rows to the top as the approval queue.
    items.sort((x, y) => y.total - x.total || x.createdAt - y.createdAt);
    const mapped = items.map((i) => i.a);
    mapped.sort((a, b) => (a.status === "pending" ? 0 : 1) - (b.status === "pending" ? 0 : 1));
    return { affiliates: mapped };
  });

  /** Admin-authored card OR a legacy raw-html row (discriminated by `kind`). */
  app.post<{ Body: unknown }>("/admin/affiliates", async (req, reply) => {
    const me = await requireAdmin(req, db, "manage_affiliates");
    if (!me) { reply.code(403); return { error: "forbidden", missing: "manage_affiliates" }; }

    let body;
    try { body = adminCreateBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: badBody(err) }; }

    const kind = body.kind ?? "card";
    const id = nanoid();

    if (kind === "html") {
      // Legacy path: keep the {label, html} contract, back-compat with 0027.
      if (!body.label || !body.html) {
        reply.code(400); return { error: "label and html required for html kind" };
      }
      await db.insert(affiliates).values({
        id,
        kind: "html",
        status: (body.enabled ?? true) ? "approved" : "disabled",
        label: body.label.trim(),
        html: body.html,
        enabled: body.enabled ?? true,
        sortOrder: body.sortOrder ?? 0,
      });
    } else {
      // Admin card path: mirrors submit but auto-approved, no owner, hashed.
      if (!body.title || !body.description || !body.targetUrl) {
        reply.code(400); return { error: "title, description and targetUrl required for card kind" };
      }
      if (!isValidAffiliateUrl(body.targetUrl)) { reply.code(400); return { error: "invalid target url" }; }
      if (body.iconUrl && !isValidAffiliateUrl(body.iconUrl)) { reply.code(400); return { error: "invalid icon url" }; }
      if (body.bannerUrl && !isValidAffiliateUrl(body.bannerUrl)) { reply.code(400); return { error: "invalid banner url" }; }
      const title = body.title.trim();
      await db.insert(affiliates).values({
        id,
        kind: "card",
        status: "approved",
        ownerUserId: null,
        label: title,
        html: "",
        title,
        description: body.description.trim(),
        iconUrl: body.iconUrl?.trim() || null,
        bannerUrl: body.bannerUrl?.trim() || null,
        targetUrl: body.targetUrl.trim(),
        tagsJson: serializeTags(body.tags ?? []),
        hash: nanoid(10),
        reviewedBy: me.id,
        reviewedAt: new Date(),
        enabled: body.enabled ?? true,
        sortOrder: body.sortOrder ?? 0,
        padInEnabled: body.padInEnabled ?? false,
        padInMax: body.padInMax ?? 0,
        padOutEnabled: body.padOutEnabled ?? false,
        padOutMax: body.padOutMax ?? 0,
      });
    }

    await recordAudit(db, {
      actorUserId: me.id,
      action: "settings_update",
      metadata: { kind: "affiliate_create", id, affiliateKind: kind },
    });
    const row = await loadRow(db, id);
    const pad = await applyPad(db, row, new Date());
    reply.code(201);
    return toAdminAffiliate(row, null, originFromRequest(req), pad);
  });

  /**
   * Admin edit — any field, incl. review state + visibility. Approving stamps
   * reviewer + timestamp and mints a hash if the row lacks one; rejecting
   * records the note. Every change is audited.
   */
  app.patch<{ Params: { id: string }; Body: unknown }>("/admin/affiliates/:id", async (req, reply) => {
    const me = await requireAdmin(req, db, "manage_affiliates");
    if (!me) { reply.code(403); return { error: "forbidden", missing: "manage_affiliates" }; }

    let body;
    try { body = adminUpdateBody.parse(req.body); }
    catch (err) { reply.code(400); return { error: badBody(err) }; }

    const existing = (await db
      .select()
      .from(affiliates)
      .where(eq(affiliates.id, req.params.id))
      .limit(1))[0];
    if (!existing) { reply.code(404); return { error: "not found" }; }

    // URL safety on any supplied URL.
    if (body.targetUrl != null && body.targetUrl !== "" && !isValidAffiliateUrl(body.targetUrl)) {
      reply.code(400); return { error: "invalid target url" };
    }
    if (body.iconUrl != null && body.iconUrl !== "" && !isValidAffiliateUrl(body.iconUrl)) {
      reply.code(400); return { error: "invalid icon url" };
    }
    if (body.bannerUrl != null && body.bannerUrl !== "" && !isValidAffiliateUrl(body.bannerUrl)) {
      reply.code(400); return { error: "invalid banner url" };
    }

    const patch: Partial<DbAffiliate> = { updatedAt: new Date() };
    if (body.title !== undefined) patch.title = body.title.trim();
    if (body.description !== undefined) patch.description = body.description.trim();
    if (body.targetUrl !== undefined) patch.targetUrl = body.targetUrl ? body.targetUrl.trim() : null;
    if (body.iconUrl !== undefined) patch.iconUrl = body.iconUrl ? body.iconUrl.trim() : null;
    if (body.bannerUrl !== undefined) patch.bannerUrl = body.bannerUrl ? body.bannerUrl.trim() : null;
    if (body.tags !== undefined) patch.tagsJson = serializeTags(body.tags ?? []);
    if (body.label !== undefined) patch.label = body.label.trim();
    if (body.html !== undefined) patch.html = body.html ?? "";
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    if (body.sortOrder !== undefined) patch.sortOrder = body.sortOrder;

    // Traffic padding config. On ANY pad change, fold the currently-shown
    // synthetic total (banked + the in-period partial under the OLD config) into
    // banked and clear the period anchor, so the next read opens a fresh rolling
    // 24h period that ramps from 0 — a reconfigure never drops the visible count.
    // `resetPad` wipes the accumulated totals entirely.
    if (body.padInEnabled !== undefined) patch.padInEnabled = body.padInEnabled;
    if (body.padInMax !== undefined) patch.padInMax = body.padInMax;
    if (body.padOutEnabled !== undefined) patch.padOutEnabled = body.padOutEnabled;
    if (body.padOutMax !== undefined) patch.padOutMax = body.padOutMax;
    const padTouched =
      body.padInEnabled !== undefined || body.padInMax !== undefined ||
      body.padOutEnabled !== undefined || body.padOutMax !== undefined;
    if (padTouched) {
      const realized = computePad(existing, new Date());
      patch.padInBanked = realized.padIn;
      patch.padOutBanked = realized.padOut;
      patch.padInTarget = 0;
      patch.padOutTarget = 0;
      patch.padPeriodStart = null;
    }
    if (body.resetPad) {
      patch.padInBanked = 0;
      patch.padOutBanked = 0;
      patch.padInTarget = 0;
      patch.padOutTarget = 0;
      patch.padPeriodStart = null;
    }

    if (body.status !== undefined) {
      patch.status = body.status;
      if (body.status === "approved") {
        patch.reviewedBy = me.id;
        patch.reviewedAt = new Date();
        patch.reviewNote = null;
        // Every approved card needs a link-back token.
        if (!existing.hash) patch.hash = nanoid(10);
      } else if (body.status === "rejected") {
        patch.reviewedBy = me.id;
        patch.reviewedAt = new Date();
        if (body.reviewNote !== undefined) patch.reviewNote = body.reviewNote;
      }
    }
    // Allow setting/clearing the review note independent of a status change.
    if (body.reviewNote !== undefined && patch.reviewNote === undefined) {
      patch.reviewNote = body.reviewNote;
    }

    await db.update(affiliates).set(patch).where(eq(affiliates.id, existing.id));
    await recordAudit(db, {
      actorUserId: me.id,
      action: "settings_update",
      metadata: {
        kind: "affiliate_update",
        id: existing.id,
        keys: Object.keys(body),
        ...(body.status !== undefined ? { status: body.status } : {}),
      },
    });
    const row = await loadRow(db, existing.id);
    const pad = await applyPad(db, row, new Date());
    return toAdminAffiliate(row, null, originFromRequest(req), pad);
  });

  /** Admin delete (cascades the click log). */
  app.delete<{ Params: { id: string } }>("/admin/affiliates/:id", async (req, reply) => {
    const me = await requireAdmin(req, db, "manage_affiliates");
    if (!me) { reply.code(403); return { error: "forbidden", missing: "manage_affiliates" }; }
    const existing = (await db.select().from(affiliates).where(eq(affiliates.id, req.params.id)).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "not found" }; }
    await db.delete(affiliates).where(eq(affiliates.id, existing.id));
    await recordAudit(db, {
      actorUserId: me.id,
      action: "settings_update",
      metadata: { kind: "affiliate_delete", id: existing.id, label: existing.label },
    });
    return { ok: true };
  });
}
