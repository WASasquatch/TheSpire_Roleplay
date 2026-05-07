import type { FastifyInstance } from "fastify";
import { asc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { navLinks } from "../db/schema.js";
import type { Db } from "../db/index.js";

const HREF_RX = /^(https?:\/\/[\w.-]+(?::\d+)?(?:\/.*)?|\/[^\s]*)$/;

const linkBody = z.object({
  label: z.string().min(1).max(40).trim(),
  href: z
    .string()
    .min(1)
    .max(500)
    .refine((v) => HREF_RX.test(v), "must be http(s):// or a path starting with /"),
  position: z.number().int().min(0).max(9999).optional(),
  enabled: z.boolean().optional(),
  target: z.enum(["_self", "_blank"]).optional(),
});

/**
 * Banner navigation links (admin-managed).
 *
 * The Exit/logout link is hard-coded in the client so admins cannot remove
 * the logout path by mistake or malice.
 */
export async function registerNavLinkRoutes(
  app: FastifyInstance,
  db: Db,
  isAdmin: (req: import("fastify").FastifyRequest) => Promise<boolean>,
): Promise<void> {
  // Public read - anyone can list enabled links for the banner.
  app.get("/nav-links", async () => {
    const rows = await db
      .select()
      .from(navLinks)
      .where(eq(navLinks.enabled, true))
      .orderBy(asc(navLinks.position), asc(navLinks.createdAt));
    return { links: rows };
  });

  // Admin guard for the rest.
  app.addHook("preHandler", async (req, reply) => {
    if (!req.url.startsWith("/admin/nav-links")) return;
    if (!(await isAdmin(req))) {
      reply.code(403);
      throw new Error("admin only");
    }
  });

  app.get("/admin/nav-links", async () => {
    const rows = await db
      .select()
      .from(navLinks)
      .orderBy(asc(navLinks.position), asc(navLinks.createdAt));
    return { links: rows };
  });

  app.post<{ Body: unknown }>("/admin/nav-links", async (req) => {
    const body = linkBody.parse(req.body);
    const id = nanoid();
    await db.insert(navLinks).values({
      id,
      label: body.label,
      href: body.href,
      position: body.position ?? 0,
      enabled: body.enabled ?? true,
      target: body.target ?? "_blank",
    });
    return { id };
  });

  app.patch<{ Params: { id: string }; Body: unknown }>(
    "/admin/nav-links/:id",
    async (req, reply) => {
      const body = linkBody.partial().parse(req.body);
      const existing = (
        await db.select().from(navLinks).where(eq(navLinks.id, req.params.id)).limit(1)
      )[0];
      if (!existing) {
        reply.code(404);
        return { error: "not found" };
      }
      await db
        .update(navLinks)
        .set({
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(body.href !== undefined ? { href: body.href } : {}),
          ...(body.position !== undefined ? { position: body.position } : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(body.target !== undefined ? { target: body.target } : {}),
          updatedAt: new Date(),
        })
        .where(eq(navLinks.id, req.params.id));
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>("/admin/nav-links/:id", async (req) => {
    await db.delete(navLinks).where(eq(navLinks.id, req.params.id));
    return { ok: true };
  });
}
