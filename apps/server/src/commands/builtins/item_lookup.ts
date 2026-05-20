import type { CommandContext, CommandHandler } from "../types.js";
import { findItem } from "./items.js";

/**
 * /item <name> — open the full-screen item zoom view for a catalog item.
 *
 * The lookup uses the same alias-aware resolver `/give /throw /drop`
 * use (see `findItem` in items.ts), so users can type the canonical
 * slug ("kaal_dragon_plushie"), the display name ("Cookie"), the
 * plural ("cookies"), or any alias the admin added ("dragon plush",
 * "biscuit"). Matching is case-insensitive.
 *
 * On match, emits an `open-item` UiHint carrying the resolved
 * catalog row inline so the client can render the zoom overlay
 * without a second roundtrip. The overlay itself is the same
 * component that powers tap-to-zoom on profile Collection / Pet
 * pins (`ItemZoomView`) — same layout, same close behaviour, same
 * keyboard shortcut. The point of this command is to let users
 * summon any item's full view from chat without first finding
 * someone who has it pinned.
 *
 * Disabled items (admin pulled them from the catalog) still resolve
 * — the zoom view is informational, not transactional. Items can be
 * collectibles long after they're retired from the shop.
 */
function notice(ctx: CommandContext, code: string, message: string) {
  ctx.socket.emit("error:notice", { code, message });
}

export const itemCommand: CommandHandler = {
  name: "item",
  aliases: ["lookup-item", "inspect"],
  usage: "/item <name-or-alias>",
  description:
    "Open the full-screen view of a catalog item by name or alias (same as tapping a profile pin). Matches the canonical slug, display name, plural, or any admin-set alias.",
  subcommands: [
    {
      verb: "<name>",
      usage: "/item cookie",
      description: "Look up by display name. Matches case-insensitively.",
    },
    {
      verb: "<alias>",
      usage: "/item biscuit",
      description: "Look up by an admin-defined alias. Same matching as /give / /throw / /drop.",
    },
  ],
  async run(ctx) {
    const query = ctx.argsText.trim();
    if (!query) {
      notice(ctx, "ITEM_USAGE", "Usage: /item <name-or-alias>");
      return;
    }
    const row = await findItem(ctx.db, query);
    if (!row) {
      notice(ctx, "ITEM_NOT_FOUND", `No item called "${query}".`);
      return;
    }
    // Carry the resolved row inline so the client opens the zoom
    // view immediately, no follow-up fetch. Wire shape matches
    // `ItemZoomEntry` on the client (which expects exactly these
    // fields; everything else on the items row is internal-only).
    ctx.socket.emit("ui:hint", {
      kind: "open-item",
      item: {
        itemKey: row.key,
        name: row.name,
        namePlural: row.namePlural,
        description: row.description,
        iconUrl: row.iconUrl,
      },
    });
  },
};
