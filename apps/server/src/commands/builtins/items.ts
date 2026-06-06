/**
 * /give /throw /drop, chat commands that consume items from the
 * sender's per-identity inventory and emit a flavor-line system
 * message drawn from the item's per-command random message table.
 *
 *   /give  <name> [num] <item>   transfers `num` units to the target's
 *                                inventory (the only command that
 *                                actually moves items across the
 *                                per-identity partition)
 *   /throw <name> [num] <item>   consumes `num` units from the sender;
 *                                target is named in the chat line but
 *                                doesn't receive anything
 *   /drop  <name> [num] <item>   same as /throw, different flavor
 *                                ("drops on" vs "throws at")
 *
 * Target resolution: matches against the room's current occupants by
 * `displayName` (case-insensitive, exact first, then prefix-unique).
 * Self-targeting is allowed ("WAS drops a House on WAS" is a feature,
 * not a bug, and self-give between two of your own identities is the
 * only legal cross-partition transfer).
 *
 * Identity scoping:
 *   - Sender's active identity (master OOC when no character is
 *     active, otherwise the active character) determines which
 *     inventory pool to debit.
 *   - For /give, target's CURRENTLY-VOICED identity determines which
 *     inventory pool to credit. If they're voicing Kaal, the cookie
 *     lands in Kaal's pocket, not the master's.
 *
 * Atomicity: the debit (+ credit, for /give) runs in a single sqlite
 * transaction so a concurrent /give can't double-spend the same stack.
 *
 * Audit: every command writes an `earning_ledger` row with reason
 * `command_give` / `command_throw` / `command_drop` so masteradmin
 * can trace large inventory shifts back to specific chats. /give
 * writes two rows, one debit-style row for the sender (positive
 * quantity in metadata, no currency delta) and one credit-style row
 * for the target, so each identity's ledger surfaces what landed
 * in / left its inventory.
 *
 * Rendering: the rendered template lands as a `kind: "system"` chat
 * message via `addSystemMessage`. Name styling for `{sender}` /
 * `{target}` is not honored in the body, Phase 2 substitutes plain
 * text. The chat renderer will gain template-aware name styling in
 * a later iteration; the templates already use the placeholder
 * shape that will support it.
 */

import { and, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Db } from "../../db/index.js";
import {
  earningLedger,
  identityCollection,
  identityInventory,
  items,
} from "../../db/schema.js";
import { addSystemMessage, currentOccupants } from "../../realtime/broadcast.js";
import type { CommandContext, CommandHandler } from "../types.js";

type ItemCommandKind = "give" | "throw" | "drop";

/** Minimum gap between consecutive `/throw` and `/drop` invocations
 *  by the same sender, in ms. Prevents a stack of cookies from being
 *  flung at someone 50 times in 5 seconds, both because that's
 *  abusive in chat AND because the receiving client's effect runner
 *  would compound shake animations into a seizure-grade strobe.
 *  /give is exempt, it's a gift, not an attack, and stack-cap is the
 *  natural pacing.
 *
 *  Process-local: a server restart resets every user's cooldown to
 *  zero. That's fine; the cooldown's only job is anti-flood within a
 *  session, not durable enforcement. */
const ATTACK_COOLDOWN_MS = 4000;

/** sender userId → unix ms timestamp of the last accepted /throw or
 *  /drop. Module-scoped Map so the gate survives across calls within
 *  one server process. We never grow this unbounded, the entry is
 *  overwritten on each accepted command, and stale entries just sit
 *  there harmlessly until the next process restart. */
const lastAttackAt = new Map<string, number>();

function notice(ctx: CommandContext, code: string, message: string) {
  ctx.socket.emit("error:notice", { code, message });
}

/** Argument shape for all three commands: `<name> [num] <item…>`.
 *  `num` is optional and defaults to 1. `item…` may be one token
 *  (the slug) OR multiple tokens (the display name with spaces).
 *  Returns `null` on parse failure; caller handles the usage hint. */
function parseItemCommandArgs(args: readonly string[]): {
  targetName: string;
  quantity: number;
  itemQuery: string;
} | null {
  if (args.length < 2) return null;
  const targetName = args[0]!;
  let quantity = 1;
  let itemStart = 1;
  if (/^\d+$/.test(args[1]!)) {
    const n = Number.parseInt(args[1]!, 10);
    if (!Number.isFinite(n) || n < 1) return null;
    quantity = n;
    itemStart = 2;
  }
  const itemQuery = args.slice(itemStart).join(" ").trim();
  if (!itemQuery) return null;
  // Sanity cap so a billion-cookie buy/move can't sneak past type
  // limits or wire-shape sizes. The buy endpoint caps at 999 too.
  if (quantity > 999) return null;
  return { targetName, quantity, itemQuery };
}

/** Resolve `query` against the items catalog by (key | name | plural |
 *  aliases). Lookups are case-insensitive and accept the slug, the
 *  singular display name, the plural display name, or any string in
 *  the item's `aliases_json` array, so `cookie` / `cookies`
 *  / `biscuit`, `dagger` / `knife` / `blade`, etc. all resolve to the
 *  right row. Returns null when nothing matches.
 *
 *  The alias check uses SQLite's `json_each` table-valued function
 *  to walk the JSON array inline. Any item with a corrupt aliases
 *  column simply doesn't contribute aliases to the match (json_each
 *  silently yields no rows on invalid JSON), which keeps the lookup
 *  robust against admin typos in the editor. */
export async function findItem(db: Db, query: string): Promise<typeof items.$inferSelect | null> {
  const lower = query.toLowerCase();
  const row = (await db
    .select()
    .from(items)
    .where(sql`lower(${items.key}) = ${lower}
      OR lower(${items.name}) = ${lower}
      OR (${items.namePlural} IS NOT NULL AND lower(${items.namePlural}) = ${lower})
      OR EXISTS (
        SELECT 1 FROM json_each(${items.aliasesJson}) AS a
        WHERE lower(a.value) = ${lower}
      )`)
    .limit(1))[0];
  return row ?? null;
}

/** Match a room occupant by display name. Exact case-insensitive
 *  match wins; otherwise picks the unique prefix match. Returns null
 *  on no match, returns `{ ambiguous: true }` when multiple distinct
 *  identities share the same prefix (caller surfaces this to the
 *  user so they can disambiguate with a longer prefix). */
type OccupantMatch =
  | { ok: true; occupant: { userId: string; characterId: string | null; displayName: string } }
  | { ok: false; ambiguous: true; matches: string[] }
  | { ok: false; ambiguous: false };

function matchOccupant(
  occupants: ReadonlyArray<{ userId: string; characterId: string | null; displayName: string }>,
  query: string,
): OccupantMatch {
  // Normalize NBSP (U+00A0) → regular space on both sides so the
  // Composer's NBSP-substituted picker output ("The Doctor")
  // still matches a stored displayName with a regular space
  // ("The Doctor"). Without this, multi-word character names picked
  // from the autocomplete would fail server-side.
  const norm = (s: string) => s.replace(/ /g, " ").toLowerCase();
  const q = norm(query);
  const exact = occupants.filter((o) => norm(o.displayName) === q);
  if (exact.length === 1) return { ok: true, occupant: exact[0]! };
  if (exact.length > 1) {
    // Two characters in the same room sharing a display name, rare
    // (two players named "Kaal" coincidentally) but possible. Force
    // disambiguation by surfacing the conflict.
    return { ok: false, ambiguous: true, matches: exact.map((o) => o.displayName) };
  }
  const prefixed = occupants.filter((o) => norm(o.displayName).startsWith(q));
  if (prefixed.length === 1) return { ok: true, occupant: prefixed[0]! };
  if (prefixed.length > 1) {
    return { ok: false, ambiguous: true, matches: prefixed.map((o) => o.displayName) };
  }
  return { ok: false, ambiguous: false };
}

/** Pick a random template from the parsed message array. */
function pickTemplate(json: string): string | null {
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v) || v.length === 0) return null;
    const filtered = v.filter((s): s is string => typeof s === "string" && s.length > 0);
    if (filtered.length === 0) return null;
    return filtered[Math.floor(Math.random() * filtered.length)]!;
  } catch {
    return null;
  }
}

/** Substitute the supported placeholders in a template. Unrecognized
 *  `{xxx}` tokens pass through unchanged so admins can author
 *  literal braces in flavor text without escaping.
 *
 *  Icon substitution: `{icon}` (canonical) and the legacy alias
 *  `{item_icon}` both expand to a `<icon src="...">` inline tag that
 *  the chat renderer turns into a 1.2em img. When the item has no
 *  iconUrl set we collapse the placeholder to empty so the rendered
 *  line doesn't end up with a literal `<icon src="">` tag. The URL is
 *  passed straight through, the client parser owns the URL allow-
 *  list (`/assets/...` or `http(s)://...`), so a malformed iconUrl
 *  here fails closed there. */
function renderTemplate(
  template: string,
  vars: {
    sender: string;
    target: string;
    num: number;
    itemName: string;
    iconUrl: string | null;
  },
): string {
  const iconTag = vars.iconUrl ? `<icon src="${vars.iconUrl}">` : "";
  return template
    .replace(/\{sender\}/g, vars.sender)
    .replace(/\{target\}/g, vars.target)
    .replace(/\{num\}/g, String(vars.num))
    .replace(/\{item_name\}/g, vars.itemName)
    .replace(/\{icon\}/g, iconTag)
    .replace(/\{item_icon\}/g, iconTag);
}

/** Shared body for the three commands. The only thing that varies
 *  is which message-template column to read, whether to credit the
 *  target's inventory, and the ledger reason. */
async function handleItemCommand(ctx: CommandContext, kind: ItemCommandKind): Promise<void> {
  const parsed = parseItemCommandArgs(ctx.args);
  if (!parsed) {
    notice(ctx, "ITEM_CMD_USAGE", `Usage: /${kind} <name> [num] <item>`);
    return;
  }
  const { targetName, quantity, itemQuery } = parsed;

  const item = await findItem(ctx.db, itemQuery);
  if (!item) {
    notice(ctx, "ITEM_NOT_FOUND", `No item called "${itemQuery}".`);
    return;
  }
  if (!item.enabled) {
    notice(ctx, "ITEM_DISABLED", `${item.name} isn't usable right now.`);
    return;
  }

  // Which message table backs this command. Empty = command disabled
  // for this item (admin intent: a "crown" item only supports /give,
  // not /throw or /drop).
  const messageJson =
    kind === "give"  ? item.giveMessagesJson :
    kind === "throw" ? item.throwMessagesJson :
                       item.dropMessagesJson;
  const template = pickTemplate(messageJson);
  if (!template) {
    notice(ctx, "ITEM_CMD_UNSUPPORTED", `${item.name} can't be /${kind === "throw" ? "thrown" : kind === "drop" ? "dropped" : "given"}.`);
    return;
  }

  // Resolve target against the current room occupants. Whisper-style
  // user-id resolution would let a sender hit anyone in the system;
  // for item commands we want the room-context constraint so the
  // chat line addresses someone who's actually present to see it.
  const occupants = await currentOccupants(ctx.io, ctx.db, ctx.roomId);
  const match = matchOccupant(occupants, targetName);
  if (!match.ok) {
    if (match.ambiguous) {
      notice(ctx, "ITEM_CMD_AMBIGUOUS", `Multiple users match "${targetName}": ${match.matches.join(", ")}. Be more specific.`);
    } else {
      notice(ctx, "ITEM_CMD_NO_TARGET", `No one named "${targetName}" is in this room.`);
    }
    return;
  }
  const target = match.occupant;

  // Cooldown gate for the "attack-flavored" commands. /give is a gift
  // and exempt; /throw and /drop produce a visible body-shake on the
  // recipient's client, and flooding those is both spammy in chat
  // AND seizure-grade for the receiver, the cooldown caps that at
  // one effect per ATTACK_COOLDOWN_MS per sender.
  //
  // Important: this runs BEFORE the transaction so a rejected call
  // never destroys the item. The user keeps their stack on a
  // cooldown miss; only an accepted /throw or /drop spends ammo.
  if (kind === "throw" || kind === "drop") {
    const last = lastAttackAt.get(ctx.user.id) ?? 0;
    const elapsed = Date.now() - last;
    if (elapsed < ATTACK_COOLDOWN_MS) {
      const remaining = Math.ceil((ATTACK_COOLDOWN_MS - elapsed) / 1000);
      notice(
        ctx,
        "ITEM_CMD_COOLDOWN",
        `Slow down, you can /${kind} again in ${remaining}s.`,
      );
      return;
    }
  }

  // Sender's active identity = inventory pool to debit. The
  // dispatcher resolves `activeCharacterId` per-socket so this is
  // the character voiced on the issuing tab (a sibling tab voicing
  // a different character doesn't get its inventory drained).
  const senderScope: "user" | "character" = ctx.user.activeCharacterId ? "character" : "user";
  const senderOwnerId = ctx.user.activeCharacterId ?? ctx.user.id;

  // Target's active identity = inventory pool to credit (give only).
  // currentOccupants already resolved characterId per-tab, so the
  // credit lands wherever the target is currently voicing.
  const targetScope: "user" | "character" = target.characterId ? "character" : "user";
  const targetOwnerId = target.characterId ?? target.userId;

  // Atomic mutation. Wrapping the funds check + debit + (for give)
  // credit in a single transaction so two concurrent /give commands
  // by the same identity can't double-spend the same stack.
  //
  // No stack-cap check: the catalog's `stackLimit` column is
  // vestigial in 2026, players accumulate without a target-side
  // ceiling, by design. The column is preserved as a soft admin
  // hint (the admin items tool still lets staff set a number for
  // future reference) but no runtime gate reads it on this path.
  type TxnResult =
    | { ok: true }
    | { ok: false; status: number; error: string; have?: number; want?: number };
  const result: TxnResult = ctx.db.transaction((tx): TxnResult => {
    // Read sender's current stack.
    const senderRow = tx.select({ qty: identityInventory.quantity })
      .from(identityInventory)
      .where(and(
        eq(identityInventory.ownerScope, senderScope),
        eq(identityInventory.ownerId, senderOwnerId),
        eq(identityInventory.itemKey, item.key),
      ))
      .limit(1)
      .all()[0];
    const have = senderRow?.qty ?? 0;
    if (have < quantity) {
      return { ok: false, status: 400, error: "not enough", have, want: quantity };
    }

    // Debit sender. Delete the row at quantity=0 so the inventory
    // map doesn't accumulate empty stacks over time. Don't touch
    // the collection here, same-identity /give re-inserts the
    // inventory row immediately below, so the final-state prune at
    // the end of the txn is what's load-bearing.
    const senderRemaining = have - quantity;
    if (senderRemaining === 0) {
      tx.delete(identityInventory).where(and(
        eq(identityInventory.ownerScope, senderScope),
        eq(identityInventory.ownerId, senderOwnerId),
        eq(identityInventory.itemKey, item.key),
      )).run();
    } else {
      tx.update(identityInventory)
        .set({ quantity: senderRemaining, updatedAt: new Date() })
        .where(and(
          eq(identityInventory.ownerScope, senderScope),
          eq(identityInventory.ownerId, senderOwnerId),
          eq(identityInventory.itemKey, item.key),
        ))
        .run();
    }

    // Credit target (give only). Re-read the target row INSIDE the
    // transaction, the debit above may have just deleted the row
    // when sender == target. Insert when no row exists yet; update
    // otherwise.
    if (kind === "give") {
      const tgtRow = tx.select({ qty: identityInventory.quantity })
        .from(identityInventory)
        .where(and(
          eq(identityInventory.ownerScope, targetScope),
          eq(identityInventory.ownerId, targetOwnerId),
          eq(identityInventory.itemKey, item.key),
        ))
        .limit(1)
        .all()[0];
      const tgtHave = tgtRow?.qty ?? 0;
      const newQty = tgtHave + quantity;
      if (tgtRow) {
        tx.update(identityInventory)
          .set({ quantity: newQty, updatedAt: new Date() })
          .where(and(
            eq(identityInventory.ownerScope, targetScope),
            eq(identityInventory.ownerId, targetOwnerId),
            eq(identityInventory.itemKey, item.key),
          ))
          .run();
      } else {
        tx.insert(identityInventory).values({
          ownerScope: targetScope,
          ownerId: targetOwnerId,
          itemKey: item.key,
          quantity: newQty,
        }).run();
      }
    }

    // Final-state Collection prune: after all inventory writes
    // have settled, drop any pinned slot on the SENDER's identity
    // that references this item if the identity no longer holds
    // any. (`/throw` / `/drop` / cross-identity `/give` are the
    // paths where this triggers; same-identity `/give` re-inserts
    // the row above, so the row still exists and the prune skips.)
    // The TARGET identity in `/give` only ever credits the row, so
    // pinned-but-empty can't happen there, no symmetric prune
    // needed.
    const senderFinal = tx.select({ qty: identityInventory.quantity })
      .from(identityInventory)
      .where(and(
        eq(identityInventory.ownerScope, senderScope),
        eq(identityInventory.ownerId, senderOwnerId),
        eq(identityInventory.itemKey, item.key),
      ))
      .limit(1)
      .all()[0];
    if (!senderFinal) {
      tx.delete(identityCollection).where(and(
        eq(identityCollection.ownerScope, senderScope),
        eq(identityCollection.ownerId, senderOwnerId),
        eq(identityCollection.itemKey, item.key),
      )).run();
    }

    // Sender ledger row.
    tx.insert(earningLedger).values({
      id: nanoid(),
      scope: senderScope,
      ownerId: senderOwnerId,
      xpDelta: 0,
      currencyDelta: 0,
      reason: `command_${kind}`,
      metadataJson: JSON.stringify({
        kind: "item",
        itemKey: item.key,
        quantity,
        direction: "out",
        targetUserId: target.userId,
        targetCharacterId: target.characterId,
        targetDisplayName: target.displayName,
        roomId: ctx.roomId,
      }),
    }).run();
    // Target ledger row (give only, the only command that actually
    // deposits anything).
    if (kind === "give") {
      tx.insert(earningLedger).values({
        id: nanoid(),
        scope: targetScope,
        ownerId: targetOwnerId,
        xpDelta: 0,
        currencyDelta: 0,
        reason: "command_give_received",
        metadataJson: JSON.stringify({
          kind: "item",
          itemKey: item.key,
          quantity,
          direction: "in",
          fromUserId: ctx.user.id,
          fromCharacterId: ctx.user.activeCharacterId,
          fromDisplayName: ctx.user.displayName,
          roomId: ctx.roomId,
        }),
      }).run();
    }
    return { ok: true };
  });

  if (!result.ok) {
    if (result.error === "not enough") {
      const itemNoun = quantity === 1 ? item.name : (item.namePlural ?? `${item.name}s`);
      notice(
        ctx,
        "ITEM_INSUFFICIENT",
        `You have ${result.have ?? 0} ${itemNoun}, can't ${kind} ${quantity}.`,
      );
    } else {
      notice(ctx, "ITEM_CMD_FAILED", result.error);
    }
    return;
  }

  // Compose + emit the chat line. Sender is the command runner's
  // display name; target is the matched occupant's display name.
  // Pluralization on item name follows the plural-aware rule.
  const itemNameRendered = quantity === 1
    ? item.name
    : (item.namePlural ?? `${item.name}s`);
  const body = renderTemplate(template, {
    sender: ctx.user.displayName,
    target: target.displayName,
    num: quantity,
    itemName: itemNameRendered,
    iconUrl: item.iconUrl,
  });
  await addSystemMessage(ctx.io, ctx.db, ctx.roomId, body);

  // Attack-flavored commands fire the `struck` effect on the target's
  // sockets that are in THIS room (so the effect renders in the
  // scene it happened in, not on the target's other tabs). Also
  // record the sender's cooldown timestamp here, only AFTER the
  // transaction succeeds, so a failed /throw doesn't burn cooldown.
  if (kind === "throw" || kind === "drop") {
    lastAttackAt.set(ctx.user.id, Date.now());
    await emitChatEffect(ctx, {
      targetUserId: target.userId,
      kind: "struck",
      // Variant distinguishes throw (whoosh + impact) from drop
      // (thud) on the client's audio side. Visual shake + flash
      // are identical either way.
      variant: kind,
      sourceDisplayName: ctx.user.displayName,
      context: {
        roomId: ctx.roomId,
        itemKey: item.key,
        quantity,
      },
    });
  }

  // Inventory live-update fan-out. Both the sender and (for /give)
  // the target need their dashboards re-fetched so the Items tab
  // surface stays consistent with what just happened. We address
  // the user-level socket bucket (every socket of the user) so a
  // user with the dashboard open on a second tab also refreshes.
  // No socket round-trip if the user has no live sockets.
  await emitInventoryChanged(ctx, {
    userId: ctx.user.id,
    scope: senderScope,
    ownerId: senderOwnerId,
    itemKey: item.key,
    delta: -quantity,
    reason: `command_${kind}`,
  });
  if (kind === "give") {
    await emitInventoryChanged(ctx, {
      userId: target.userId,
      scope: targetScope,
      ownerId: targetOwnerId,
      itemKey: item.key,
      delta: quantity,
      reason: "command_give_received",
    });
  }
}

/** Fire a `chat:effect` event at every live socket of `targetUserId`
 *  that's currently joined to the source room. Scoping to the room
 *  (not just the user) keeps the effect contextual, a target with
 *  a second tab open in a different room doesn't see a body-shake
 *  there for an attack that happened elsewhere.
 *
 *  Designed to be reused by any future target-based command that
 *  wants a visible reaction on the target's client. Add new `kind`
 *  branches to the shared event type, then call this helper with
 *  the new kind. */
async function emitChatEffect(
  ctx: CommandContext,
  payload: {
    targetUserId: string;
    kind: "struck";
    variant?: "throw" | "drop";
    sourceDisplayName?: string;
    context?: Record<string, unknown>;
  },
): Promise<void> {
  const sockets = await ctx.io.in(`room:${ctx.roomId}`).fetchSockets();
  // `exactOptionalPropertyTypes: true`, optional fields can't be
  // assigned `undefined` literally, they must be omitted. Build the
  // emit payload conditionally so missing fields don't carry an
  // explicit `undefined` on the wire.
  const wire: {
    kind: "struck";
    variant?: "throw" | "drop";
    sourceDisplayName?: string;
    context?: Record<string, unknown>;
  } = {
    kind: payload.kind,
  };
  if (payload.variant !== undefined) wire.variant = payload.variant;
  if (payload.sourceDisplayName !== undefined) wire.sourceDisplayName = payload.sourceDisplayName;
  if (payload.context !== undefined) wire.context = payload.context;
  for (const s of sockets) {
    const uid = (s.data as { userId?: string }).userId;
    if (uid !== payload.targetUserId) continue;
    s.emit("chat:effect", wire);
  }
}

/** Fan out the `earning:inventory_changed` event to every live
 *  socket belonging to `userId`. Cheap when the user has no live
 *  sockets, Socket.IO's `fetchSockets` returns an empty list and
 *  the loop is a no-op. */
async function emitInventoryChanged(
  ctx: CommandContext,
  payload: {
    userId: string;
    scope: "user" | "character";
    ownerId: string;
    itemKey: string;
    delta: number;
    reason:
      | "command_give"
      | "command_throw"
      | "command_drop"
      | "command_give_received"
      | "item_purchase"
      | "admin_grant";
  },
): Promise<void> {
  const sockets = await ctx.io.fetchSockets();
  for (const s of sockets) {
    const uid = (s.data as { userId?: string }).userId;
    if (uid !== payload.userId) continue;
    s.emit("earning:inventory_changed", {
      scope: payload.scope,
      ownerId: payload.ownerId,
      itemKey: payload.itemKey,
      delta: payload.delta,
      reason: payload.reason,
    });
  }
}

export const giveCommand: CommandHandler = {
  name: "give",
  usage: "/give <name> [num] <item>",
  description:
    "Hand `num` units of an item to another user in the room. The item leaves your inventory and lands in theirs (whichever identity they're currently voicing). Quantity defaults to 1. Item can be the slug (cookie) or display name (cookies). Each identity (OOC + each character) has its own inventory, `/give` is the only legal way to move items across the partition.",
  subcommands: [
    {
      verb: "<name> <item>",
      usage: "/give Alice cookie",
      description: "Give one of the named item to a user. Item can be its slug, display name, plural, or any admin-set alias.",
    },
    {
      verb: "<name> <num> <item>",
      usage: "/give Alice 3 cookie",
      description: "Give a specific quantity. Caps at what your active identity actually owns.",
    },
  ],
  async run(ctx) {
    await handleItemCommand(ctx, "give");
  },
};

export const throwCommand: CommandHandler = {
  name: "throw",
  usage: "/throw <name> [num] <item>",
  description:
    "Consume an item to toss it at someone in the room, flavor only, target gets nothing. Quantity defaults to 1. Item can be the slug or display name. Each item ships its own random `/throw` lines; if an item has none, /throw isn't allowed on it. Subject to a 4-second per-sender cooldown.",
  subcommands: [
    {
      verb: "<name> <item>",
      usage: "/throw Alice pie",
      description: "Throw one of the named item at a user. Consumed from your inventory; target gets nothing.",
    },
    {
      verb: "<name> <num> <item>",
      usage: "/throw Alice 3 pie",
      description: "Throw a specific quantity. Caps at what your active identity actually owns.",
    },
  ],
  async run(ctx) {
    await handleItemCommand(ctx, "throw");
  },
};

export const dropCommand: CommandHandler = {
  name: "drop",
  usage: "/drop <name> [num] <item>",
  description:
    "Consume an item to drop it on someone in the room, flavor only, target gets nothing. Same shape as /throw with different flavor text. Quantity defaults to 1. Each item ships its own random `/drop` lines; if an item has none, /drop isn't allowed on it. Subject to a 4-second per-sender cooldown.",
  subcommands: [
    {
      verb: "<name> <item>",
      usage: "/drop Alice rose",
      description: "Drop one of the named item on a user. Consumed from your inventory; target gets nothing.",
    },
    {
      verb: "<name> <num> <item>",
      usage: "/drop Alice 3 rose",
      description: "Drop a specific quantity. Caps at what your active identity actually owns.",
    },
  ],
  async run(ctx) {
    await handleItemCommand(ctx, "drop");
  },
};
