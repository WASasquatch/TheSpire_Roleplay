/**
 * Public one-click unsubscribe landing (no auth). Verifies the HMAC token
 * from a broadcast email's footer link and records a per-CATEGORY opt-out,
 * then returns a tiny standalone confirmation page (no SPA shell needed).
 * Only that category is dropped; other categories and account email still
 * flow.
 */
import type { FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { emailCategoryLabel, isEmailCategory } from "@thekeep/shared";
import { emailUnsubscribes } from "../db/schema.js";
import { verifyUnsubscribe } from "../email/unsubscribe.js";
import type { Db } from "../db/index.js";

function page(title: string, body: string, code: number): { code: number; html: string } {
  return {
    code,
    html: `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${title}</title>
<style>body{margin:0;background:#f3f1f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#2c2838;}
.card{max-width:480px;margin:48px auto;background:#fff;border:1px solid #e6e3ee;border-radius:12px;padding:32px;text-align:center;}
h1{font-size:20px;margin:0 0 12px;}p{font-size:15px;line-height:1.6;color:#4a4658;margin:0;}</style></head>
<body><div class="card"><h1>${title}</h1><p>${body}</p></div></body></html>`,
  };
}

export async function registerUnsubscribeRoute(app: FastifyInstance, db: Db): Promise<void> {
  app.get<{ Querystring: { u?: string; c?: string; t?: string } }>(
    "/unsubscribe",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const u = typeof req.query.u === "string" ? req.query.u : "";
      const c = typeof req.query.c === "string" ? req.query.c : "";
      const t = typeof req.query.t === "string" ? req.query.t : "";
      reply.type("text/html");
      if (!u || !c || !t || !isEmailCategory(c) || !verifyUnsubscribe(u, c, t)) {
        const p = page("Invalid link", "This unsubscribe link is invalid or has expired.", 400);
        reply.code(p.code);
        return p.html;
      }
      // Idempotent: ignore if already opted out of this category.
      await db
        .insert(emailUnsubscribes)
        .values({ id: nanoid(), userId: u, category: c })
        .onConflictDoNothing();
      const label = emailCategoryLabel(c);
      const p = page(
        "Unsubscribed",
        `You won't receive further <strong>${label}</strong> emails. Other emails and account messages (like password resets) will still be delivered.`,
        200,
      );
      reply.code(p.code);
      return p.html;
    },
  );
}
