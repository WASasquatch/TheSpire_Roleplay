import { createHash } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { and, asc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { WorldEntityMapRef, WorldMapLinkableEvent, WorldMapMarkerEvent } from "@thekeep/shared";
import {
  BUILTIN_ENTITY_KIND_KEYS,
  BUILTIN_MAP_MARKER_KINDS,
  LORE_KIND_KEY,
  WORLD_MAPS_CAP,
  WORLD_MAP_DESCRIPTION_MAX,
  WORLD_MAP_MARKERS_CAP,
  WORLD_MAP_MARKER_BODY_MAX,
  WORLD_MAP_MARKER_LABEL_MAX,
  WORLD_MAP_NAME_MAX,
  WORLD_MAP_UPLOADS_PER_WORLD_CAP,
  WORLD_MAP_UPLOAD_MAX_BYTES,
  deriveSlug,
  expandOccurrences,
  parseEventRecurrence,
} from "@thekeep/shared";
import { tFor } from "../../i18n.js";
import { getSessionUser } from "../auth.js";
import {
  serverEventRsvps,
  serverEvents,
  servers,
  worldEntityKinds,
  worldMapMarkers,
  worldMaps,
  worlds,
} from "../../db/schema.js";
import { sanitizeBio } from "../../auth/html.js";
import { areServersEnabled, getSettings } from "../../settings.js";
import { serverAuthority } from "../../servers/authority.js";
import type { Db } from "../../db/index.js";
import {
  SLUG_RX,
  resolveWorld,
  canEditWorld,
  mapRowToWire,
  markerRowToWire,
} from "./shared.js";
import type { Io } from "./shared.js";

/** Accepted upload magic bytes. SVG is deliberately absent: stored files are
 *  served same-origin under `'self'`, and an uploaded SVG opened directly
 *  would be a stored-XSS vector. SVG maps stay external-URL-only, where the
 *  <img> renderer keeps scripts inert. */
const MAP_IMAGE_TYPES: Array<{ mime: string; ext: string; magic: number[]; magicAt?: { offset: number; bytes: number[] } }> = [
  { mime: "image/png", ext: "png", magic: [0x89, 0x50, 0x4e, 0x47] },
  { mime: "image/jpeg", ext: "jpg", magic: [0xff, 0xd8, 0xff] },
  // RIFF alone also matches WAV/AVI; the "WEBP" fourcc at offset 8 keeps
  // the RIFF family's non-image members out.
  { mime: "image/webp", ext: "webp", magic: [0x52, 0x49, 0x46, 0x46], magicAt: { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] } },
  { mime: "image/gif", ext: "gif", magic: [0x47, 0x49, 0x46, 0x38] },
];

/** How far ahead marker-linked events resolve occurrences (matches the
 *  events list route's expansion horizon). */
const EVENT_HORIZON_MS = 90 * 24 * 60 * 60_000;
/** Occurrences that started within the last hour still count as "next"
 *  (the member panel's just-started grace). */
const EVENT_GRACE_MS = 60 * 60_000;

export async function registerWorldMapRoutes(app: FastifyInstance, db: Db, _io: Io, uploadsRoot: string): Promise<void> {
  /* ===================================================== *
   *  World maps — an https map image + fractional markers.
   *  Same CRUD idiom as the knowledge base: resolveWorld →
   *  canEditWorld → Zod .strict → cap 409 → slug derive →
   *  sort append → nanoid insert → worlds.updatedAt bump.
   * ===================================================== */

  // Anonymous visitors on public worlds hit the map GET, so it takes the
  // public-surface rate limit rather than riding auth.
  const publicLimit = { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } } as const;

  // Map images render exclusively via <img>, but the URL itself is still
  // locked to https: no data:/javascript:/file:, and no plain-http
  // downgrade (mixed content would break under the site's CSP anyway).
  const mapImageUrl = z
    .string().trim().min(1).max(500)
    .refine(
      (s) => { try { return new URL(s).protocol === "https:"; } catch { return false; } },
      { message: "imageUrl must use https" },
    );

  // Uploaded map image, as a base64 data URL (the codebase-wide no-multipart
  // posture). 6MB raw ≈ 8MB base64; the string cap only stops absurd bodies,
  // the real byte cap lives in decodeMapDataUrl.
  const mapImageDataUrl = z.string().min(32).max(9 * 1024 * 1024);

  const createMapBody = z.object({
    name: z.string().min(1).max(WORLD_MAP_NAME_MAX),
    slug: z.string().optional(),
    description: z.string().max(WORLD_MAP_DESCRIPTION_MAX * 4).optional(),
    imageUrl: mapImageUrl.optional(),
    imageDataUrl: mapImageDataUrl.optional(),
  }).strict()
    // Exactly one image source: an external https link or an upload.
    .refine((b) => (b.imageUrl != null) !== (b.imageDataUrl != null), {
      message: "exactly one of imageUrl / imageDataUrl",
    });
  const updateMapBody = z.object({
    name: z.string().min(1).max(WORLD_MAP_NAME_MAX).optional(),
    slug: z.string().optional(),
    description: z.string().max(WORLD_MAP_DESCRIPTION_MAX * 4).optional(),
    imageUrl: mapImageUrl.optional(),
    imageDataUrl: mapImageDataUrl.optional(),
    // Natural-dimension hints, PATCHed back by the editor after the
    // image's first load. Bounded so a bogus client can't store junk.
    width: z.number().int().min(1).max(50_000).nullable().optional(),
    height: z.number().int().min(1).max(50_000).nullable().optional(),
    sortOrder: z.number().int().optional(),
  }).strict()
    .refine((b) => b.imageUrl == null || b.imageDataUrl == null, {
      message: "at most one of imageUrl / imageDataUrl",
    });

  /* ---------- Uploaded map images (admin-gated, default off) ---------- */

  const worldmapsDir = join(uploadsRoot, "worldmaps");

  /** Decode + bound a map-image data URL. Size overruns are 413 (the body
   *  passed the HTTP layer but the image itself is over the 6MB cap);
   *  malformed payloads are 400. */
  function decodeMapDataUrl(dataUrl: string, locale: string | null): Buffer | { error: string; status: number } {
    const m = /^data:image\/[a-z+.-]+;base64,(.+)$/i.exec(dataUrl.trim());
    if (!m) return { error: tFor(locale, "errors:server.upload.expectedImageDataUrl"), status: 400 };
    let bytes: Buffer;
    try { bytes = Buffer.from(m[1]!, "base64"); }
    catch { return { error: tFor(locale, "errors:server.upload.badBase64"), status: 400 }; }
    if (bytes.length === 0) return { error: tFor(locale, "errors:server.upload.emptyImage"), status: 400 };
    if (bytes.length > WORLD_MAP_UPLOAD_MAX_BYTES) {
      return { error: tFor(locale, "errors:server.upload.tooLarge", { kb: Math.round(WORLD_MAP_UPLOAD_MAX_BYTES / 1024) }), status: 413 };
    }
    return bytes;
  }

  /** Magic-byte sniff against the PNG/JPG/WEBP/GIF allowlist (never SVG). */
  function sniffMapImage(bytes: Buffer): { mime: string; ext: string } | null {
    for (const t of MAP_IMAGE_TYPES) {
      if (bytes.length < t.magic.length || !t.magic.every((b, i) => bytes[i] === b)) continue;
      const at = t.magicAt;
      if (at && (bytes.length < at.offset + at.bytes.length || !at.bytes.every((b, i) => bytes[at.offset + i] === b))) continue;
      return t;
    }
    return null;
  }

  /** Write a content-hashed map image under /uploads/worldmaps/<worldId>/;
   *  returns its public URL. Content hashing keeps the 1y-immutable static
   *  cache safe and dedupes identical uploads within a world. */
  async function writeWorldMapImage(
    worldId: string,
    dataUrl: string,
    locale: string | null,
  ): Promise<{ url: string } | { error: string; status: number }> {
    const decoded = decodeMapDataUrl(dataUrl, locale);
    if ("error" in decoded) return decoded;
    const detected = sniffMapImage(decoded);
    if (!detected) return { error: tFor(locale, "errors:server.upload.unsupportedType"), status: 415 };
    const hash = createHash("sha256").update(decoded).digest("hex").slice(0, 16);
    const dir = join(worldmapsDir, worldId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${hash}.${detected.ext}`), decoded);
    return { url: `/uploads/worldmaps/${worldId}/${hash}.${detected.ext}` };
  }

  /** Best-effort removal of a stored map image once no OTHER map row still
   *  points at it (content-hash filenames dedupe identical uploads, so a
   *  shared file must survive its first referencing map). Prefix-guarded
   *  against traversal: only this world's /uploads/worldmaps/ files, and
   *  only sane hash.ext filenames, are ever unlinked. */
  async function unlinkMapImageIfOrphaned(worldId: string, exceptMapId: string, url: string | null | undefined): Promise<void> {
    const prefix = `/uploads/worldmaps/${worldId}/`;
    if (!url?.startsWith(prefix)) return;
    const filename = url.slice(prefix.length);
    if (!/^[a-f0-9]{16}\.[a-z0-9]{2,5}$/.test(filename)) return;
    const other = (await db.select({ id: worldMaps.id }).from(worldMaps)
      .where(and(eq(worldMaps.imageUrl, url), ne(worldMaps.id, exceptMapId))).limit(1))[0];
    if (other) return;
    try { await unlink(join(worldmapsDir, worldId, filename)); } catch { /* best-effort */ }
  }

  /** Count of maps holding a STORED image in this world (the per-world disk
   *  quota; external links never count). */
  async function storedImageCount(worldId: string): Promise<number> {
    const row = (await db.select({ n: sql<number>`count(*)` }).from(worldMaps)
      .where(and(eq(worldMaps.worldId, worldId), eq(worldMaps.imageKind, "upload"))))[0];
    return Number(row?.n ?? 0);
  }

  // x/y are CLAMPED into 0..1 rather than rejected: a drag that ends a
  // few px outside the stage should pin to the edge, not error. Full
  // float precision is preserved inside the range.
  const fraction = z.number().finite().transform((v) => Math.min(1, Math.max(0, v)));
  // Zoom band bounds are fit-relative zoom factors (1 = fitted, 8 = max).
  const zoomBound = z.number().finite().min(0.1).max(32);
  // Icon: a curated lucide slug (slug-shaped) or a short emoji glyph.
  const markerIcon = z
    .string().trim().min(1).max(32)
    .refine((s) => /^[a-z0-9-]{1,32}$/.test(s) || s.length <= 8, { message: "icon must be an icon slug or a short glyph" });
  const markerSize = z.enum(["sm", "md", "lg", "xl"]);
  const markerScaleMode = z.enum(["fixed", "map"]);
  const markerLabelMode = z.enum(["icon", "text", "both"]);

  const createMarkerBody = z.object({
    kind: z.string().min(1).max(40),
    label: z.string().min(1).max(WORLD_MAP_MARKER_LABEL_MAX),
    x: fraction,
    y: fraction,
    color: z.string().max(32).nullable().optional(),
    icon: markerIcon.nullable().optional(),
    size: markerSize.optional(),
    scaleMode: markerScaleMode.optional(),
    labelMode: markerLabelMode.optional(),
    minZoom: zoomBound.nullable().optional(),
    maxZoom: zoomBound.nullable().optional(),
    entryKind: z.string().min(1).max(40).nullable().optional(),
    entrySlug: z.string().min(1).max(60).nullable().optional(),
    eventId: z.string().min(1).max(64).nullable().optional(),
    body: z.string().max(WORLD_MAP_MARKER_BODY_MAX * 4).optional(),
    isSecret: z.boolean().optional(),
  }).strict();
  const updateMarkerBody = z.object({
    kind: z.string().min(1).max(40).optional(),
    label: z.string().min(1).max(WORLD_MAP_MARKER_LABEL_MAX).optional(),
    x: fraction.optional(),
    y: fraction.optional(),
    color: z.string().max(32).nullable().optional(),
    icon: markerIcon.nullable().optional(),
    size: markerSize.optional(),
    scaleMode: markerScaleMode.optional(),
    labelMode: markerLabelMode.optional(),
    minZoom: zoomBound.nullable().optional(),
    maxZoom: zoomBound.nullable().optional(),
    entryKind: z.string().min(1).max(40).nullable().optional(),
    entrySlug: z.string().min(1).max(60).nullable().optional(),
    eventId: z.string().min(1).max(64).nullable().optional(),
    body: z.string().max(WORLD_MAP_MARKER_BODY_MAX * 4).optional(),
    isSecret: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  }).strict();

  /** Marker kind = builtin marker kind, builtin entity kind, synthetic
   *  lore, or a registered custom kind on this world. */
  async function isValidMarkerKind(worldId: string, kind: string): Promise<boolean> {
    if ((BUILTIN_MAP_MARKER_KINDS as readonly string[]).includes(kind)) return true;
    if ((BUILTIN_ENTITY_KIND_KEYS as readonly string[]).includes(kind)) return true;
    if (kind === LORE_KIND_KEY) return true;
    const row = (await db
      .select({ key: worldEntityKinds.key })
      .from(worldEntityKinds)
      .where(and(eq(worldEntityKinds.worldId, worldId), sql`lower(${worldEntityKinds.key}) = ${kind.toLowerCase()}`))
      .limit(1))[0];
    return !!row;
  }

  /** Entry-link kind = an ENTITY kind (builtin/custom) or lore — the
   *  viewer's openEntry(kind, slug) only routes those. The marker-only
   *  builtin kinds (event/label) are NOT linkable targets. */
  async function isValidEntryKind(worldId: string, kind: string): Promise<boolean> {
    if ((BUILTIN_ENTITY_KIND_KEYS as readonly string[]).includes(kind)) return true;
    if (kind === LORE_KIND_KEY) return true;
    const row = (await db
      .select({ key: worldEntityKinds.key })
      .from(worldEntityKinds)
      .where(and(eq(worldEntityKinds.worldId, worldId), sql`lower(${worldEntityKinds.key}) = ${kind.toLowerCase()}`))
      .limit(1))[0];
    return !!row;
  }

  /** A linkable event must belong to a community whose `servers.world_id`
   *  points at THIS world (the reverse of the console's world link), and
   *  the EDITOR must be able to participate in that community — the write
   *  gate mirrors the /map-events picker filter, so a direct POST can't
   *  link (or existence-probe) events of a community the editor can't
   *  enter. When the servers feature is dark nothing is linkable. */
  async function eventLinkableToWorld(worldId: string, eventId: string, me: Parameters<typeof serverAuthority>[1]): Promise<boolean> {
    if (!areServersEnabled(await getSettings(db))) return false;
    const row = (await db
      .select({ id: serverEvents.id, serverId: serverEvents.serverId })
      .from(serverEvents)
      .innerJoin(servers, eq(serverEvents.serverId, servers.id))
      .where(and(eq(serverEvents.id, eventId), eq(servers.worldId, worldId)))
      .limit(1))[0];
    if (!row) return false;
    return (await serverAuthority(db, me, row.serverId)).canParticipate;
  }

  /** The occurrence a marker popover talks about: the next one from now
   *  (with the member panel's just-started grace), or the series anchor
   *  when none remains / the event is cancelled. */
  function nextOccurrenceOf(row: typeof serverEvents.$inferSelect, nowMs: number): { startsAt: number; endsAt: number | null } {
    const next = expandOccurrences(
      { startsAt: +row.startsAt, endsAt: row.endsAt != null ? +row.endsAt : null, recurrenceJson: row.recurrenceJson },
      nowMs - EVENT_GRACE_MS,
      nowMs + EVENT_HORIZON_MS,
      1,
    )[0];
    return next ?? { startsAt: +row.startsAt, endsAt: row.endsAt != null ? +row.endsAt : null };
  }

  /** Resolve a map inside a world by id-or-slug (slugs are world-scoped). */
  async function mapInWorld(worldId: string, idOrSlug: string): Promise<typeof worldMaps.$inferSelect | null> {
    let m = (await db.select().from(worldMaps)
      .where(and(eq(worldMaps.id, idOrSlug), eq(worldMaps.worldId, worldId))).limit(1))[0];
    if (!m) {
      m = (await db.select().from(worldMaps)
        .where(and(eq(worldMaps.worldId, worldId), sql`lower(${worldMaps.slug}) = ${idOrSlug.toLowerCase()}`)).limit(1))[0];
    }
    return m ?? null;
  }

  /* ---------- Read one map + its markers (lazy per-map fetch) ---------- */

  app.get<{ Params: { idOrSlug: string; mid: string } }>("/worlds/:idOrSlug/maps/:mid", publicLimit, async (req, reply) => {
    const me = await getSessionUser(req, db);
    const w = await resolveWorld(db, req.params.idOrSlug, me?.id ?? null, me?.role ?? null);
    if (!w) { reply.code(404); return { error: "not found" }; }
    const m = await mapInWorld(w.id, req.params.mid);
    if (!m) { reply.code(404); return { error: "not found" }; }
    const canEdit = await canEditWorld(db, w, me?.id ?? null, me?.role ?? null);
    const rows = await db.select().from(worldMapMarkers).where(eq(worldMapMarkers.mapId, m.id))
      .orderBy(asc(worldMapMarkers.sortOrder), asc(worldMapMarkers.createdAt));
    // DM-secret markers are stripped HERE, in the payload assembly — a
    // client-side filter would still leak them over the wire.
    const visible = canEdit ? rows : rows.filter((r) => !r.isSecret);

    // Event-linked markers resolve their event details PER VIEWER: only a
    // viewer who can participate in the owning community receives them.
    // Non-members and anonymous visitors get the bare marker (the client
    // renders a neutral members-only line), and event details never enter
    // the payload for them. The anon / no-event-marker path adds ZERO
    // queries — this whole block is skipped.
    const eventIds = [...new Set(visible.map((r) => r.eventId).filter((v): v is string => !!v))];
    let events: WorldMapMarkerEvent[] | undefined;
    if (eventIds.length > 0 && me && areServersEnabled(await getSettings(db))) {
      const evRows = await db.select().from(serverEvents).where(inArray(serverEvents.id, eventIds));
      const byServer = new Map<string, typeof evRows>();
      for (const row of evRows) {
        const list = byServer.get(row.serverId);
        if (list) list.push(row); else byServer.set(row.serverId, [row]);
      }
      const allowed: typeof evRows = [];
      for (const [serverId, list] of byServer) {
        const a = await serverAuthority(db, me, serverId);
        if (a.canParticipate) allowed.push(...list);
      }
      if (allowed.length > 0) {
        const goingBy = new Map<string, number>();
        for (const c of await db
          .select({ eventId: serverEventRsvps.eventId, n: sql<number>`count(*)` })
          .from(serverEventRsvps)
          .where(and(
            inArray(serverEventRsvps.eventId, allowed.map((r) => r.id)),
            eq(serverEventRsvps.status, "going"),
          ))
          .groupBy(serverEventRsvps.eventId)) {
          goingBy.set(c.eventId, Number(c.n));
        }
        const now = Date.now();
        events = allowed.map((row) => {
          const occ = nextOccurrenceOf(row, now);
          return {
            id: row.id,
            serverId: row.serverId,
            title: row.title,
            status: row.status as WorldMapMarkerEvent["status"],
            startsAt: occ.startsAt,
            endsAt: occ.endsAt,
            goingCount: goingBy.get(row.id) ?? 0,
          };
        });
      }
    }
    return {
      map: mapRowToWire(m),
      markers: visible.map(markerRowToWire),
      ...(events && events.length > 0 ? { events } : {}),
    };
  });

  /* ---------- Entry → marker reverse lookup ---------- */

  // Which wiki entries are placed on which map: light rows powering the
  // wiki's "Show on map" chip (the forward direction — the map panel's
  // "On this map" index — derives client-side from the already-scrubbed
  // marker payload). Kept off WorldDetail so the detail fetch stays flat
  // for every viewer who never opens the wiki. Same scrub composition as
  // the map GET: non-editors never receive refs from secret markers.
  app.get<{ Params: { idOrSlug: string } }>("/worlds/:idOrSlug/entity-map-refs", publicLimit, async (req, reply) => {
    const me = await getSessionUser(req, db);
    const w = await resolveWorld(db, req.params.idOrSlug, me?.id ?? null, me?.role ?? null);
    if (!w) { reply.code(404); return { error: "not found" }; }
    const canEdit = await canEditWorld(db, w, me?.id ?? null, me?.role ?? null);
    const rows = await db
      .select({
        entryKind: worldMapMarkers.entryKind,
        entrySlug: worldMapMarkers.entrySlug,
        mapId: worldMaps.id,
        mapSlug: worldMaps.slug,
        markerId: worldMapMarkers.id,
      })
      .from(worldMapMarkers)
      .innerJoin(worldMaps, eq(worldMapMarkers.mapId, worldMaps.id))
      .where(and(
        eq(worldMaps.worldId, w.id),
        isNotNull(worldMapMarkers.entryKind),
        ...(canEdit ? [] : [eq(worldMapMarkers.isSecret, false)]),
      ))
      .orderBy(asc(worldMaps.sortOrder), asc(worldMapMarkers.sortOrder), asc(worldMapMarkers.createdAt));
    const refs: WorldEntityMapRef[] = rows
      .filter((r): r is typeof r & { entryKind: string; entrySlug: string } => !!r.entryKind && !!r.entrySlug)
      .map((r) => ({
        entryKind: r.entryKind,
        entrySlug: r.entrySlug,
        mapId: r.mapId,
        mapSlug: r.mapSlug,
        markerId: r.markerId,
      }));
    return { refs };
  });

  /* ---------- Linked-event picker (editors) ---------- */

  // Upcoming events of communities featuring this world, for the marker
  // editor's "Linked event" select. Composed on BOTH sides: the caller must
  // be able to edit the world AND be able to participate in each community
  // — an editor never sees (or links) event titles from a server they can't
  // enter. Lives at /map-events (not /maps/events) so a map whose slug is
  // literally "events" stays reachable through the param route.
  app.get<{ Params: { idOrSlug: string } }>("/worlds/:idOrSlug/map-events", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }
    if (!areServersEnabled(await getSettings(db))) return { events: [] };
    const featuring = await db
      .select({ id: servers.id, name: servers.name })
      .from(servers)
      .where(eq(servers.worldId, w.id));
    const now = Date.now();
    const out: WorldMapLinkableEvent[] = [];
    for (const srv of featuring) {
      const a = await serverAuthority(db, me, srv.id);
      if (!a.canParticipate) continue;
      const evRows = await db
        .select()
        .from(serverEvents)
        .where(and(
          eq(serverEvents.serverId, srv.id),
          inArray(serverEvents.status, ["scheduled", "live"]),
        ));
      for (const row of evRows) {
        // Only events with an occurrence still ahead (90-day horizon, with
        // the just-started grace) are pickable — a spent series isn't.
        const next = expandOccurrences(
          { startsAt: +row.startsAt, endsAt: row.endsAt != null ? +row.endsAt : null, recurrenceJson: row.recurrenceJson },
          now - EVENT_GRACE_MS,
          now + EVENT_HORIZON_MS,
          1,
        )[0];
        if (!next) continue;
        out.push({
          id: row.id,
          serverId: srv.id,
          serverName: srv.name,
          title: row.title,
          icon: row.icon ?? null,
          status: row.status as "scheduled" | "live",
          startsAt: next.startsAt,
          recurring: !!parseEventRecurrence(row.recurrenceJson),
        });
      }
    }
    out.sort((a, b) => a.startsAt - b.startsAt);
    return { events: out.slice(0, 100) };
  });

  /* ---------- Map CRUD ---------- */

  // Per-route bodyLimit: a 6MB image rides in as ~8MB of base64 JSON (the
  // logo-upload override idiom); the zod cap + decode byte cap bound it
  // application-side.
  const uploadBodyLimit = { bodyLimit: 12 * 1024 * 1024 } as const;

  app.post<{ Params: { idOrSlug: string }; Body: unknown }>("/worlds/:idOrSlug/maps", uploadBodyLimit, async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }
    let body; try { body = createMapBody.parse(req.body); } catch { reply.code(400); return { error: "invalid body" }; }
    const countRow = (await db.select({ n: sql<number>`count(*)` }).from(worldMaps).where(eq(worldMaps.worldId, w.id)))[0];
    if ((countRow?.n ?? 0) >= WORLD_MAPS_CAP) { reply.code(409); return { error: tFor(me.locale, "errors:server.worlds.tooManyMaps") }; }
    const slug = (body.slug?.trim() || deriveSlug(body.name)).toLowerCase();
    if (!SLUG_RX.test(slug)) { reply.code(400); return { error: "invalid slug" }; }
    const dup = (await db.select({ id: worldMaps.id }).from(worldMaps)
      .where(and(eq(worldMaps.worldId, w.id), sql`lower(${worldMaps.slug}) = ${slug}`)).limit(1))[0];
    if (dup) { reply.code(409); return { error: tFor(me.locale, "errors:server.worlds.mapSlugExists") }; }
    // Image source: an external https URL (always allowed) or an uploaded
    // data URL. The upload branch is the server-side boundary for the
    // admin switch — a hidden client affordance alone would not be.
    let imageUrl: string;
    let imageKind: "external" | "upload" = "external";
    if (body.imageDataUrl != null) {
      if (!(await getSettings(db)).worldMapUploadsEnabled) {
        reply.code(403);
        return { error: tFor(me.locale, "errors:server.worlds.mapUploadsDisabled") };
      }
      if ((await storedImageCount(w.id)) >= WORLD_MAP_UPLOADS_PER_WORLD_CAP) {
        reply.code(409);
        return { error: tFor(me.locale, "errors:server.worlds.tooManyMapUploads", { max: WORLD_MAP_UPLOADS_PER_WORLD_CAP }) };
      }
      const written = await writeWorldMapImage(w.id, body.imageDataUrl, me.locale);
      if ("error" in written) { reply.code(written.status); return { error: written.error }; }
      imageUrl = written.url;
      imageKind = "upload";
    } else {
      imageUrl = body.imageUrl!;
    }
    const maxRow = (await db.select({ m: sql<number>`COALESCE(MAX(${worldMaps.sortOrder}), -1)` }).from(worldMaps).where(eq(worldMaps.worldId, w.id)))[0];
    const now = new Date();
    const id = nanoid();
    await db.insert(worldMaps).values({
      id, worldId: w.id, slug, name: body.name,
      description: sanitizeBio(body.description ?? ""),
      imageUrl, imageKind,
      sortOrder: Number(maxRow?.m ?? -1) + 1, createdAt: now, updatedAt: now,
    });
    await db.update(worlds).set({ updatedAt: now }).where(eq(worlds.id, w.id));
    const created = (await db.select().from(worldMaps).where(eq(worldMaps.id, id)).limit(1))[0]!;
    return { map: mapRowToWire(created) };
  });

  app.patch<{ Params: { idOrSlug: string; mid: string }; Body: unknown }>("/worlds/:idOrSlug/maps/:mid", uploadBodyLimit, async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }
    const existing = await mapInWorld(w.id, req.params.mid);
    if (!existing) { reply.code(404); return { error: "not found" }; }
    let body; try { body = updateMapBody.parse(req.body); } catch { reply.code(400); return { error: "invalid body" }; }
    const update: Partial<typeof worldMaps.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) update.name = body.name;
    if (body.description !== undefined) update.description = sanitizeBio(body.description);
    /** Replaced stored image to sweep AFTER the row update commits (so the
     *  orphan check sees the new imageUrl, not the one being replaced). */
    let replacedUploadUrl: string | null = null;
    if (body.imageDataUrl != null) {
      // Uploaded replacement — same server-side boundary as create.
      if (!(await getSettings(db)).worldMapUploadsEnabled) {
        reply.code(403);
        return { error: tFor(me.locale, "errors:server.worlds.mapUploadsDisabled") };
      }
      // Replacing a map's own stored image keeps the count flat; only an
      // external→upload conversion consumes quota.
      if (existing.imageKind !== "upload" && (await storedImageCount(w.id)) >= WORLD_MAP_UPLOADS_PER_WORLD_CAP) {
        reply.code(409);
        return { error: tFor(me.locale, "errors:server.worlds.tooManyMapUploads", { max: WORLD_MAP_UPLOADS_PER_WORLD_CAP }) };
      }
      const written = await writeWorldMapImage(w.id, body.imageDataUrl, me.locale);
      if ("error" in written) { reply.code(written.status); return { error: written.error }; }
      if (existing.imageKind === "upload" && existing.imageUrl !== written.url) {
        replacedUploadUrl = existing.imageUrl;
      }
      update.imageUrl = written.url;
      update.imageKind = "upload";
      // A fresh image invalidates the old dimension hints unless the
      // same PATCH re-measures them.
      if (body.width === undefined) update.width = null;
      if (body.height === undefined) update.height = null;
    } else if (body.imageUrl !== undefined) {
      // External replacement: a previously stored file loses its reference.
      if (existing.imageKind === "upload" && existing.imageUrl !== body.imageUrl) {
        replacedUploadUrl = existing.imageUrl;
      }
      update.imageUrl = body.imageUrl;
      update.imageKind = "external";
      if (body.width === undefined) update.width = null;
      if (body.height === undefined) update.height = null;
    }
    if (body.width !== undefined) update.width = body.width;
    if (body.height !== undefined) update.height = body.height;
    if (body.sortOrder !== undefined) update.sortOrder = body.sortOrder;
    if (body.slug !== undefined) {
      const slug = (body.slug.trim() || deriveSlug(body.name ?? existing.name)).toLowerCase();
      if (!SLUG_RX.test(slug)) { reply.code(400); return { error: "invalid slug" }; }
      const dup = (await db.select({ id: worldMaps.id }).from(worldMaps)
        .where(and(eq(worldMaps.worldId, w.id), sql`lower(${worldMaps.slug}) = ${slug}`, ne(worldMaps.id, existing.id))).limit(1))[0];
      if (dup) { reply.code(409); return { error: tFor(me.locale, "errors:server.worlds.mapSlugExists") }; }
      update.slug = slug;
    }
    await db.update(worldMaps).set(update).where(eq(worldMaps.id, existing.id));
    if (replacedUploadUrl) await unlinkMapImageIfOrphaned(w.id, existing.id, replacedUploadUrl);
    await db.update(worlds).set({ updatedAt: new Date() }).where(eq(worlds.id, w.id));
    const updated = (await db.select().from(worldMaps).where(eq(worldMaps.id, existing.id)).limit(1))[0]!;
    return { map: mapRowToWire(updated) };
  });

  app.delete<{ Params: { idOrSlug: string; mid: string } }>("/worlds/:idOrSlug/maps/:mid", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }
    const existing = await mapInWorld(w.id, req.params.mid);
    if (!existing) { reply.code(404); return { error: "not found" }; }
    // Markers cascade via the DB FK.
    await db.delete(worldMaps).where(eq(worldMaps.id, existing.id));
    // A stored image goes with its map (unless a twin upload still uses it).
    if (existing.imageKind === "upload") {
      await unlinkMapImageIfOrphaned(w.id, existing.id, existing.imageUrl);
    }
    await db.update(worlds).set({ updatedAt: new Date() }).where(eq(worlds.id, w.id));
    return { ok: true };
  });

  /* ---------- Marker CRUD ---------- */

  app.post<{ Params: { idOrSlug: string; mid: string }; Body: unknown }>("/worlds/:idOrSlug/maps/:mid/markers", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }
    const m = await mapInWorld(w.id, req.params.mid);
    if (!m) { reply.code(404); return { error: "not found" }; }
    let body; try { body = createMarkerBody.parse(req.body); } catch { reply.code(400); return { error: "invalid body" }; }
    if (!(await isValidMarkerKind(w.id, body.kind))) { reply.code(400); return { error: "unknown kind" }; }
    if ((body.entryKind != null) !== (body.entrySlug != null)) { reply.code(400); return { error: "entry link needs both kind and slug" }; }
    if (body.entryKind != null && body.entrySlug != null) {
      if (!(await isValidEntryKind(w.id, body.entryKind))) { reply.code(400); return { error: "unknown entry kind" }; }
      if (!SLUG_RX.test(body.entrySlug.toLowerCase())) { reply.code(400); return { error: "invalid entry slug" }; }
    }
    if (body.minZoom != null && body.maxZoom != null && body.minZoom > body.maxZoom) { reply.code(400); return { error: "invalid zoom band" }; }
    if (body.eventId != null && !(await eventLinkableToWorld(w.id, body.eventId, me))) {
      reply.code(400);
      return { error: tFor(me.locale, "errors:server.worlds.eventNotLinkable") };
    }
    const countRow = (await db.select({ n: sql<number>`count(*)` }).from(worldMapMarkers).where(eq(worldMapMarkers.mapId, m.id)))[0];
    if ((countRow?.n ?? 0) >= WORLD_MAP_MARKERS_CAP) { reply.code(409); return { error: tFor(me.locale, "errors:server.worlds.tooManyMarkers") }; }
    const maxRow = (await db.select({ m: sql<number>`COALESCE(MAX(${worldMapMarkers.sortOrder}), -1)` }).from(worldMapMarkers).where(eq(worldMapMarkers.mapId, m.id)))[0];
    const now = new Date();
    const kid = nanoid();
    await db.insert(worldMapMarkers).values({
      // Kind matches case-insensitively but stores lowercase (builtin and
      // SLUG_RX-validated custom keys are all lowercase), so client-side
      // exact-match kind lookups and layer grouping never split on case.
      id: kid, mapId: m.id, kind: body.kind.toLowerCase(), label: body.label,
      x: body.x, y: body.y,
      color: body.color ?? null, icon: body.icon ?? null,
      size: body.size ?? "md", scaleMode: body.scaleMode ?? "fixed",
      labelMode: body.labelMode ?? "icon",
      minZoom: body.minZoom ?? null, maxZoom: body.maxZoom ?? null,
      entryKind: body.entryKind != null ? body.entryKind.toLowerCase() : null,
      entrySlug: body.entrySlug != null ? body.entrySlug.toLowerCase() : null,
      eventId: body.eventId ?? null,
      body: sanitizeBio(body.body ?? ""),
      isSecret: body.isSecret ?? false,
      sortOrder: Number(maxRow?.m ?? -1) + 1, createdAt: now, updatedAt: now,
    });
    await db.update(worldMaps).set({ updatedAt: now }).where(eq(worldMaps.id, m.id));
    await db.update(worlds).set({ updatedAt: now }).where(eq(worlds.id, w.id));
    const created = (await db.select().from(worldMapMarkers).where(eq(worldMapMarkers.id, kid)).limit(1))[0]!;
    return { marker: markerRowToWire(created) };
  });

  app.patch<{ Params: { idOrSlug: string; mid: string; markerId: string }; Body: unknown }>("/worlds/:idOrSlug/maps/:mid/markers/:markerId", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }
    const m = await mapInWorld(w.id, req.params.mid);
    if (!m) { reply.code(404); return { error: "not found" }; }
    const existing = (await db.select().from(worldMapMarkers)
      .where(and(eq(worldMapMarkers.id, req.params.markerId), eq(worldMapMarkers.mapId, m.id))).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "not found" }; }
    let body; try { body = updateMarkerBody.parse(req.body); } catch { reply.code(400); return { error: "invalid body" }; }
    const update: Partial<typeof worldMapMarkers.$inferInsert> = { updatedAt: new Date() };
    if (body.kind !== undefined) {
      if (!(await isValidMarkerKind(w.id, body.kind))) { reply.code(400); return { error: "unknown kind" }; }
      update.kind = body.kind.toLowerCase();
    }
    if (body.label !== undefined) update.label = body.label;
    if (body.x !== undefined) update.x = body.x;
    if (body.y !== undefined) update.y = body.y;
    if (body.color !== undefined) update.color = body.color;
    if (body.icon !== undefined) update.icon = body.icon;
    if (body.size !== undefined) update.size = body.size;
    if (body.scaleMode !== undefined) update.scaleMode = body.scaleMode;
    if (body.labelMode !== undefined) update.labelMode = body.labelMode;
    if (body.minZoom !== undefined) update.minZoom = body.minZoom;
    if (body.maxZoom !== undefined) update.maxZoom = body.maxZoom;
    {
      const nextMin = body.minZoom !== undefined ? body.minZoom : existing.minZoom;
      const nextMax = body.maxZoom !== undefined ? body.maxZoom : existing.maxZoom;
      if (nextMin != null && nextMax != null && nextMin > nextMax) { reply.code(400); return { error: "invalid zoom band" }; }
    }
    if (body.entryKind !== undefined || body.entrySlug !== undefined) {
      const nextKind = body.entryKind !== undefined ? body.entryKind : existing.entryKind;
      const nextSlug = body.entrySlug !== undefined ? body.entrySlug : existing.entrySlug;
      if ((nextKind != null) !== (nextSlug != null)) { reply.code(400); return { error: "entry link needs both kind and slug" }; }
      if (nextKind != null && nextSlug != null) {
        if (!(await isValidEntryKind(w.id, nextKind))) { reply.code(400); return { error: "unknown entry kind" }; }
        if (!SLUG_RX.test(nextSlug.toLowerCase())) { reply.code(400); return { error: "invalid entry slug" }; }
      }
      update.entryKind = nextKind != null ? nextKind.toLowerCase() : null;
      update.entrySlug = nextSlug != null ? nextSlug.toLowerCase() : null;
    }
    if (body.eventId !== undefined) {
      // Only a CHANGED link re-validates: clients echo the stored eventId
      // back on every save, and a link that was valid when made must not
      // brick unrelated edits after the community unfeatures the world or
      // the servers feature goes dark.
      if (body.eventId != null && body.eventId !== existing.eventId && !(await eventLinkableToWorld(w.id, body.eventId, me))) {
        reply.code(400);
        return { error: tFor(me.locale, "errors:server.worlds.eventNotLinkable") };
      }
      update.eventId = body.eventId;
    }
    if (body.body !== undefined) update.body = sanitizeBio(body.body);
    if (body.isSecret !== undefined) update.isSecret = body.isSecret;
    if (body.sortOrder !== undefined) update.sortOrder = body.sortOrder;
    await db.update(worldMapMarkers).set(update).where(eq(worldMapMarkers.id, existing.id));
    await db.update(worldMaps).set({ updatedAt: new Date() }).where(eq(worldMaps.id, m.id));
    await db.update(worlds).set({ updatedAt: new Date() }).where(eq(worlds.id, w.id));
    const updated = (await db.select().from(worldMapMarkers).where(eq(worldMapMarkers.id, existing.id)).limit(1))[0]!;
    return { marker: markerRowToWire(updated) };
  });

  app.delete<{ Params: { idOrSlug: string; mid: string; markerId: string } }>("/worlds/:idOrSlug/maps/:mid/markers/:markerId", async (req, reply) => {
    const me = await getSessionUser(req, db);
    if (!me) { reply.code(401); return { error: "auth" }; }
    const w = await resolveWorld(db, req.params.idOrSlug, me.id, me.role);
    if (!w) { reply.code(404); return { error: "not found" }; }
    if (!(await canEditWorld(db, w, me.id, me.role))) { reply.code(403); return { error: "not yours" }; }
    const m = await mapInWorld(w.id, req.params.mid);
    if (!m) { reply.code(404); return { error: "not found" }; }
    const existing = (await db.select({ id: worldMapMarkers.id }).from(worldMapMarkers)
      .where(and(eq(worldMapMarkers.id, req.params.markerId), eq(worldMapMarkers.mapId, m.id))).limit(1))[0];
    if (!existing) { reply.code(404); return { error: "not found" }; }
    await db.delete(worldMapMarkers).where(eq(worldMapMarkers.id, existing.id));
    await db.update(worldMaps).set({ updatedAt: new Date() }).where(eq(worldMaps.id, m.id));
    await db.update(worlds).set({ updatedAt: new Date() }).where(eq(worlds.id, w.id));
    return { ok: true };
  });
}
