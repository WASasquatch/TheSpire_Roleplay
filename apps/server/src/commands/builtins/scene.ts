import { and, eq } from "drizzle-orm";
import { roomMembers, rooms } from "../../db/schema.js";
import { addMessage, broadcastRoomState } from "../../realtime/broadcast.js";
import { hasPermission } from "../../auth/permissions.js";
import { tFor } from "../../i18n.js";
import type { CommandContext, CommandHandler } from "../types.js";

function notice(ctx: CommandContext, code: string, message: string) {
  ctx.socket.emit("error:notice", { code, message });
}

/**
 * Caller must be the room owner, a room mod, or hold the site-wide
 * `edit_any_room_metadata` (matrix-grantable; admin-default by seed).
 * /scene is a director-shaped feature, random users shouldn't be able
 * to drop scene banners into someone else's room.
 */
async function canMarkScene(ctx: CommandContext): Promise<boolean> {
  if (await hasPermission(ctx.user, "edit_any_room_metadata", ctx.db)) return true;
  const member = (await ctx.db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, ctx.roomId), eq(roomMembers.userId, ctx.user.id)))
    .limit(1))[0];
  return member?.role === "owner" || member?.role === "mod";
}

/**
 * Image URL gate for `/scene <title> | <url>`. Same posture as the
 * avatar validator on the profile route: http/https only, length
 * cap, defensive `https?://` prefix check on top of URL parsing so
 * a `javascript:` / `data:` URL can't sneak past `new URL`. Returns
 * the trimmed URL on success or `null` to signal "invalid" so the
 * caller can surface a NOTICE without throwing.
 */
const SCENE_IMAGE_URL_MAX = 500;
function validateSceneImageUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > SCENE_IMAGE_URL_MAX) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return trimmed;
}

/**
 * /scene <title>                  - mark a scene start with a tinted banner
 * /scene <title> | <image-url>    - same banner + a hero image centered under the title
 * /scene end                      - mark a scene end
 *
 * Renders distinctly from /announce (which is a sitewide admin shout) and
 * from system messages (joins/parts). Used by directors of a session to
 * delineate beats.
 *
 * The image arg is opt-in: titles without a `|` separator render
 * exactly as before. A blank URL after the pipe is treated as
 * "user typed the separator and changed their mind", same banner,
 * no image, no error. An invalid URL after the pipe rejects the
 * whole send so the director knows their link didn't take (the
 * silent-drop alternative would publish a title-only banner and
 * leave them puzzling over where the image went).
 */
export const sceneCommand: CommandHandler = {
  name: "scene",
  usage: "/scene <title> [| <image-url>] | /scene end",
  description:
    "Mark a scene start or end with a banner. Optional image URL after a `|` separator. Visible to everyone in the room. Owner/mod only.",
  subcommands: [
    { verb: "<title>", usage: "/scene The market at dusk", description: "Open a new scene with a banner." },
    { verb: "<title> | <url>", usage: "/scene The market at dusk | https://example.com/dusk.jpg", description: "Open a new scene with a banner and a centered hero image (click the banner to collapse it)." },
    { verb: "end", usage: "/scene end", description: "Close the current scene with a banner.", aliases: ["close", "stop"] },
  ],
  async run(ctx) {
    if (!(await canMarkScene(ctx))) {
      notice(ctx, "PERM", tFor(ctx.user.locale, "commands:scene.permission"));
      return;
    }
    const raw = ctx.argsText.trim();
    if (!raw) {
      notice(ctx, "SCENE_USAGE", tFor(ctx.user.locale, "commands:scene.usage"));
      return;
    }
    // Pipe is the title|image separator. Splitting on the FIRST pipe
    // only so a title that legitimately contains "|" downstream (rare
    // but possible for stylistic lines like "Day | Night") keeps the
    // rest of the title intact while the image slot only ever picks
    // up the trailing segment.
    const pipeIdx = raw.indexOf("|");
    const titlePart = (pipeIdx >= 0 ? raw.slice(0, pipeIdx) : raw).trim();
    const imagePart = pipeIdx >= 0 ? raw.slice(pipeIdx + 1).trim() : "";
    if (!titlePart) {
      notice(ctx, "SCENE_USAGE", tFor(ctx.user.locale, "commands:scene.usage"));
      return;
    }
    const isEnd = /^(end|close|stop)$/i.test(titlePart);
    let sceneImageUrl: string | null = null;
    if (!isEnd && imagePart) {
      const ok = validateSceneImageUrl(imagePart);
      if (!ok) {
        notice(ctx, "SCENE_IMAGE_URL_INVALID", tFor(ctx.user.locale, "commands:scene.imageUrlInvalid"));
        return;
      }
      sceneImageUrl = ok;
    }
    const body = isEnd ? "Scene ends." : `Scene: ${titlePart}`;
    await addMessage(ctx, { kind: "scene", body, sceneImageUrl });

    // Mirror the scene onto the room as live state for the Room Info bar
    // (migration 0258): opening sets the current scene, `/scene end` clears
    // it. Broadcast room state so the collapsed bar's "current scene" updates
    // for everyone without a refresh. Best-effort — the banner already went
    // out above; a failed state write shouldn't surface as a send error.
    try {
      await ctx.db
        .update(rooms)
        .set(
          isEnd
            ? { currentSceneTitle: null, currentSceneImageUrl: null }
            : { currentSceneTitle: titlePart, currentSceneImageUrl: sceneImageUrl },
        )
        .where(eq(rooms.id, ctx.roomId));
      await broadcastRoomState(ctx.io, ctx.db, ctx.roomId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[room-stats] scene state update failed", { roomId: ctx.roomId, err });
    }
  },
};
