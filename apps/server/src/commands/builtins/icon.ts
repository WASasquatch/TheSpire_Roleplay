import { eq } from "drizzle-orm";
import { rooms } from "../../db/schema.js";
import { addMessage, broadcastRoomState } from "../../realtime/broadcast.js";
import { callerCanEditRoom } from "../../auth/roomPermissions.js";
import type { CommandContext, CommandHandler } from "../types.js";

function notice(ctx: CommandContext, code: string, message: string) {
  ctx.socket.emit("error:notice", { code, message });
}

const ICON_URL_MAX = 500;

/**
 * Resolve a raw `/icon` argument into the value to store, or `{ ok: false }`
 * for "invalid". The room icon is dual-form: either an http(s) image URL
 * (rendered as <img> in the Room Info bar) or a short emoji/text glyph
 * (rendered as-is).
 *
 *   - URL: http/https only, length-capped. Defensive `https?://` prefix check
 *     on top of `new URL` so a `javascript:`/`data:` URL can't slip through.
 *   - Glyph: a short run (<= 8 code points) with no whitespace or markup
 *     chars — enough for an emoji (incl. ZWJ sequences) or a 1-2 char mark.
 */
function resolveIcon(raw: string): { ok: true; value: string } | { ok: false } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false };
  if (/^https?:\/\//i.test(trimmed)) {
    if (trimmed.length > ICON_URL_MAX) return { ok: false };
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false };
    } catch {
      return { ok: false };
    }
    return { ok: true, value: trimmed };
  }
  // Emoji / short glyph. Reject markup + whitespace; cap the code-point count
  // so it stays icon-sized (a family emoji is ~7 code points).
  if (/[<>]/.test(trimmed)) return { ok: false };
  if (/\s/.test(trimmed)) return { ok: false };
  if ([...trimmed].length > 8) return { ok: false };
  return { ok: true, value: trimmed };
}

/**
 * /icon <emoji|image-url> | /icon clear
 *
 * Set (or clear) the room's icon shown left of its name in the Room Info bar.
 * Accepts a single emoji/short glyph or an http(s) image URL. Owner/mod/admin
 * only (same gate as /topic). Persists on the room and survives archive/
 * resurrect, so a recreated room keeps its mark.
 */
export const iconCommand: CommandHandler = {
  name: "icon",
  usage: "/icon <emoji|image-url> | /icon clear",
  description:
    "Set the room's icon (an emoji or an image URL) shown beside its name in the Room Info bar. /icon clear removes it. Owner/mod only.",
  subcommands: [
    { verb: "<emoji>", usage: "/icon 🎭", description: "Use an emoji as the room icon." },
    { verb: "<image-url>", usage: "/icon https://example.com/mark.png", description: "Use a small image as the room icon." },
    { verb: "clear", usage: "/icon clear", description: "Remove the room icon.", aliases: ["none", "off"] },
  ],
  async run(ctx) {
    if (!(await callerCanEditRoom(ctx.db, ctx.user, ctx.roomId))) {
      notice(ctx, "PERM", "Only the room owner or a mod can set the room icon.");
      return;
    }
    const raw = ctx.argsText.trim();
    if (!raw) {
      notice(ctx, "ICON_USAGE", "Usage: /icon <emoji or image URL>  (or /icon clear)");
      return;
    }

    if (/^(clear|none|off)$/i.test(raw)) {
      await ctx.db.update(rooms).set({ icon: null }).where(eq(rooms.id, ctx.roomId));
      await broadcastRoomState(ctx.io, ctx.db, ctx.roomId);
      await addMessage(ctx, { kind: "system", body: `${ctx.user.displayName} cleared the room icon.` });
      return;
    }

    const resolved = resolveIcon(raw);
    if (!resolved.ok) {
      notice(
        ctx,
        "ICON_INVALID",
        "Give a single emoji, a short glyph, or an http(s) image URL (max 500 chars).",
      );
      return;
    }

    await ctx.db.update(rooms).set({ icon: resolved.value }).where(eq(rooms.id, ctx.roomId));
    await broadcastRoomState(ctx.io, ctx.db, ctx.roomId);
    await addMessage(ctx, { kind: "system", body: `${ctx.user.displayName} set the room icon.` });
  },
};
