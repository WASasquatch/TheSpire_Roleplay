/**
 * GET /worlds/:idOrSlug/export: the whole world in one payload, for the
 * client's "print this world as a magazine" PDF export.
 *
 * Why a dedicated endpoint instead of reusing WorldDetail: the viewer's
 * payload is deliberately LIGHT. Entry bodies, session bodies, map images and
 * markers are all lazy-fetched, because a reader opens a handful of pages and
 * paying for the rest would make every world open slowly. A PDF is the exact
 * opposite access pattern: it opens everything, once. Driving it off the
 * viewer's payload means one request per entry plus one per session plus one
 * per map, each re-running `resolveWorld` and `canEditWorld`. On a world with
 * three hundred entries that is three hundred round trips to produce one file.
 *
 * Visibility is resolved ONCE here and applied to every collection, so the
 * dossier can never be a wider view of the world than the wiki is:
 *   - `resolveWorld` gates the whole route (private worlds, hard 18+ gate,
 *     collaborator-sees-private).
 *   - non-editors get only `isPublic` entries, mirroring the entities GET.
 *   - non-editors never receive secret map markers, mirroring the map GET.
 *   - the Overlook scene rides along only when the feature is on sitewide AND
 *     the world opted in, mirroring the Overlook GET's own gate.
 */
import type { FastifyInstance } from "fastify";
import { asc, eq } from "drizzle-orm";
import type { WorldExportDossier, WorldExportMap } from "@thekeep/shared";
import {
  overlooks,
  worldArcs,
  worldEntities,
  worldEntityKinds,
  worldMapMarkers,
  worldMaps,
  worldPages,
  worldSessions,
} from "../../db/schema.js";
import { getSettings } from "../../settings.js";
import { getSessionUser } from "../auth.js";
import type { Db } from "../../db/index.js";
import {
  arcRowToWire,
  canEditWorld,
  collaboratorListFor,
  entityKindRowToWire,
  entityRowToWire,
  mapRowToWire,
  markerRowToWire,
  memberListFor,
  pageRowToWire,
  resolveWorld,
  sessionRowToWire,
  toSummary,
} from "./shared.js";

export async function registerWorldExportRoutes(app: FastifyInstance, db: Db): Promise<void> {
  app.get<{ Params: { idOrSlug: string } }>(
    "/worlds/:idOrSlug/export",
    // One export is a heavy read across seven tables. A handful a minute is
    // plenty for a human clicking a button, and it keeps the endpoint from
    // becoming a cheap way to dump every world on the site.
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const me = await getSessionUser(req, db);
      const w = await resolveWorld(db, req.params.idOrSlug, me?.id ?? null, me?.role ?? null);
      if (!w) { reply.code(404); return { error: "not found" }; }
      const viewerCanEdit = await canEditWorld(db, w, me?.id ?? null, me?.role ?? null);

      const pageRows = await db
        .select()
        .from(worldPages)
        .where(eq(worldPages.worldId, w.id))
        .orderBy(asc(worldPages.sortOrder), asc(worldPages.createdAt));
      const entityRows = await db
        .select()
        .from(worldEntities)
        .where(eq(worldEntities.worldId, w.id))
        .orderBy(asc(worldEntities.kind), asc(worldEntities.sortOrder), asc(worldEntities.createdAt));
      const entityKindRows = await db
        .select()
        .from(worldEntityKinds)
        .where(eq(worldEntityKinds.worldId, w.id))
        .orderBy(asc(worldEntityKinds.sortOrder), asc(worldEntityKinds.key));
      const arcRows = await db
        .select()
        .from(worldArcs)
        .where(eq(worldArcs.worldId, w.id))
        .orderBy(asc(worldArcs.sortOrder), asc(worldArcs.createdAt));
      // Chronological ASCENDING here, unlike the viewer's newest-first list:
      // a printed session log reads forward through the campaign.
      const sessionRows = await db
        .select()
        .from(worldSessions)
        .where(eq(worldSessions.worldId, w.id))
        .orderBy(asc(worldSessions.sessionDate), asc(worldSessions.sortOrder), asc(worldSessions.createdAt));
      const mapRows = await db
        .select()
        .from(worldMaps)
        .where(eq(worldMaps.worldId, w.id))
        .orderBy(asc(worldMaps.sortOrder), asc(worldMaps.createdAt));

      const maps: WorldExportMap[] = [];
      for (const m of mapRows) {
        const markerRows = await db
          .select()
          .from(worldMapMarkers)
          .where(eq(worldMapMarkers.mapId, m.id))
          .orderBy(asc(worldMapMarkers.sortOrder), asc(worldMapMarkers.createdAt));
        // Same scrub as the map GET, applied in payload assembly rather than
        // at render: a client-side filter would still put the secret over
        // the wire, and a PDF is a file the reader keeps.
        const visible = viewerCanEdit ? markerRows : markerRows.filter((r) => !r.isSecret);
        maps.push({ map: mapRowToWire(m), markers: visible.map(markerRowToWire) });
      }

      // Marker-linked EVENTS are deliberately not resolved into the dossier.
      // They're per-viewer community state with their own membership gate and
      // a "next occurrence" that is stale the moment the file is saved; a
      // printed plate showing a date that has since moved is worse than no
      // date. The marker's own label and body still print.

      // The Overlook plate rides along only when the canvas is actually
      // reachable (feature on sitewide AND the world opted in), so an export
      // can never surface a board the viewer couldn't open in the app.
      let overlookSceneJson: string | null = null;
      if (w.overlookEnabled && (await getSettings(db)).overlookEnabled) {
        const row = (await db
          .select({ sceneJson: overlooks.sceneJson, elementCount: overlooks.elementCount })
          .from(overlooks)
          .where(eq(overlooks.worldId, w.id))
          .limit(1))[0];
        if (row && row.elementCount > 0) overlookSceneJson = row.sceneJson;
      }

      const dossier: WorldExportDossier = {
        world: await toSummary(db, w),
        pages: pageRows.map(pageRowToWire),
        entities: (viewerCanEdit ? entityRows : entityRows.filter((r) => !!r.isPublic)).map(entityRowToWire),
        entityKinds: entityKindRows.map(entityKindRowToWire),
        arcs: arcRows.map(arcRowToWire),
        sessions: sessionRows.map(sessionRowToWire),
        maps,
        members: await memberListFor(db, w.id),
        collaborators: await collaboratorListFor(db, w.id),
        overlookSceneJson,
        viewerCanEdit,
        generatedAt: Date.now(),
      };
      return dossier;
    },
  );
}
