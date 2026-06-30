/**
 * Per-server Commands & Titles admin (Admin Partition — plan_ext.md §4).
 *
 * The server-scoped analog of the global admin Commands + Titles surfaces in
 * `admin/routes.ts`. A server owner/mod manages THIS server's custom `!commands`
 * and mutual-title kinds from the Server Admin console, mirroring the global
 * panel but scoped to one server.
 *
 *   Commands  — gated on serverCan(a, "manage_commands"). CRUD over
 *               `custom_commands` WHERE server_id = :id, stamping server_id on
 *               create. The social-game (built-in command) tuning panel is also
 *               read here. See the SOCIAL-GAME NOTE below.
 *   Titles    — gated on serverCan(a, "manage_titles"). CRUD over `title_kinds`
 *               WHERE server_id = :id, stamping server_id on create.
 *
 * SELF-GATING: this module owns no closures from `routes/servers.ts`. Every
 * route resolves the session + authority itself via the EXPORTED helpers
 * (getSessionUser, serverAuthority/serverCan, getSettings/areServersEnabled),
 * exactly as plan_ext.md §3 prescribes, so the orchestrator wires it with a
 * single `registerServerCommandTitleRoutes(app, db, io)` call.
 *
 * FLAG-GATED: every route 404s when servers are disabled, so the flag-off path
 * is byte-identical to today (the global admin routes are untouched).
 *
 * SCOPED `commands:updated`: the global routes fire a bare `io.emit(
 * "commands:updated")` to hot-reload every client's autocomplete + help cache.
 * Here we scope it to THIS server's socket band (`server:<id>`) when servers are
 * ON, AND dual-emit the bare global pulse for older client bundles that never
 * learned server scoping — the SAME pattern `emitTreeChanged` uses for
 * `server:tree-changed`. The global emit is replicated, not broken.
 *
 * SOCIAL-GAME NOTE (flagged to the orchestrator): `builtin_command_config` is
 * keyed by `command_name` ALONE (no `server_id` column exists — migrations
 * 0278h/0278i added server_id to custom_commands/title_kinds, but there is NO
 * matching migration for builtin_command_config). Per-server social-game tuning
 * therefore has no storage yet. To avoid pretending to scope a globally-keyed
 * table, the social-game config is exposed here READ-ONLY (the effective shared
 * values) and clearly labelled in the tab. Wiring true per-server writes needs a
 * `server_builtin_command_config` table (or a server_id column + composite PK) —
 * see the return notes.
 *
 * COMMAND-NAME / TITLE-SLUG NAMESPACE: `custom_commands.name` and
 * `title_kinds.slug` carry GLOBAL unique indexes (custom_commands_name_uq /
 * title_kinds_slug_uq) shared across ALL servers and the platform namespace, so
 * a per-server create must pre-check the WHOLE table (not just this server) and
 * 409 on collision, exactly like the global routes do, or the insert trips the
 * unique constraint.
 *
 * REGISTRY HOT-RELOAD CAVEAT (flagged): the in-memory CommandRegistry singleton
 * lives in `index.ts` and is NOT exported; the global routes call
 * `registry.reloadCustom(db)` after each write. This module's fixed
 * `(app, db, io)` signature has no handle to it, so dispatch (the registry's
 * `byName` map) only picks up server-scoped command edits on the next server
 * restart. The scoped `commands:updated` emit DOES refresh every client's
 * `/commands` autocomplete/help cache immediately. To make dispatch live too,
 * the orchestrator should expose a registry-reload accessor (or pass `registry`
 * into this register call) — see the return notes.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Server as IoServer } from "socket.io";
import { z } from "zod";
import {
  CUSTOM_CMD_CSS_MAX_LEN,
  sanitizeCustomCmdCss,
} from "@thekeep/shared";
import type { ClientToServerEvents, ServerToClientEvents } from "@thekeep/shared";
import type { FastifyInstance } from "fastify";
import type { CommandRegistry } from "../commands/registry.js";
import {
  auditLog,
  builtinCommandConfig,
  customCommandAliases,
  customCommands,
  mutualTitles,
  serverBuiltinCommandConfig,
  titleKinds,
} from "../db/schema.js";
import type { Db } from "../db/index.js";
import { getSessionUser } from "../routes/auth.js";
import { areServersEnabled, getSettings } from "../settings.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

/* ============================================================
 * Local helpers (self-contained — no closures from servers.ts)
 * ============================================================ */

/**
 * Best-effort server-scoped audit insert. Mirrors `auditServer` in
 * `routes/servers.ts`: writes the auditLog row's NATIVE `serverId` column so the
 * entry lands in the owning server's Mod Log (and is excluded from the global
 * Audit feed). A logging failure NEVER fails the action it records.
 */
async function auditServer(
  db: Db,
  entry: {
    serverId: string;
    actorUserId: string;
    action: string;
    metadata?: Record<string, unknown> | null;
  },
): Promise<void> {
  try {
    await db.insert(auditLog).values({
      id: nanoid(),
      actorUserId: entry.actorUserId,
      action: entry.action,
      metadataJson: entry.metadata ? JSON.stringify(entry.metadata) : null,
      serverId: entry.serverId,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[audit] failed to record server command/title entry", { action: entry.action, err });
  }
}

/**
 * Hot-reload every client's autocomplete + help cache after a server-scoped
 * command edit. Scoped to THIS server's socket band when servers are on, PLUS
 * the bare global emit for older client bundles — the same dual-emit shape
 * `emitTreeChanged` uses. The global pulse is replicated, not removed.
 */
function emitCommandsUpdated(io: Io, serverId: string): void {
  io.to(`server:${serverId}`).emit("commands:updated");
  io.emit("commands:updated");
}

/* ============================================================
 * Validation
 * ============================================================ */

const customCommandBody = z.object({
  name: z.string().trim().min(1).max(32).regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, "name must start with a letter; letters/digits/_/- only"),
  kind: z.enum(["action", "say"]).default("action"),
  template: z.string().min(1).max(2000),
  description: z.string().max(500).nullable().optional(),
  aliases: z.array(z.string().trim().min(1).max(32)).max(10).optional(),
  enabled: z.boolean().optional(),
  color: z.string().max(64).nullable().optional(),
  allowInline: z.boolean().optional(),
  inlineTemplate: z.string().max(2000).nullable().optional(),
  css: z.string().max(CUSTOM_CMD_CSS_MAX_LEN).nullable().optional(),
});

// Slug rule mirrors the global title-kinds route + slash-command keywords.
const SLUG_RX = /^[a-z0-9_-]{1,32}$/;
const titleKindBody = z.object({
  slug: z.string().min(1).max(32).regex(SLUG_RX, "slug must be lowercase a-z/0-9/_/- only"),
  label: z.string().min(1).max(80),
  symmetric: z.boolean(),
  formatA: z.string().min(1).max(120),
  formatB: z.string().min(1).max(120),
  exclusive: z.boolean(),
  enabled: z.boolean(),
});

/* ============================================================
 * Social-game (built-in command) catalog — mirror of the global
 * BUILTIN_COMMAND_CATALOG in admin/routes.ts. Code defaults + labels
 * used to render the read-only per-server panel. (See SOCIAL-GAME NOTE.)
 * ============================================================ */
interface BuiltinCommandCatalogEntry {
  name: string;
  label: string;
  description: string;
  defaultDurationMs: number;
  durationLabel: string;
  supportsReward: boolean;
  defaultRewardXp: number;
  defaultRewardCurrency: number;
}
const BUILTIN_COMMAND_CATALOG: ReadonlyArray<BuiltinCommandCatalogEntry> = [
  { name: "rps", label: "Rock-paper-scissors", description: "30-second round in the current room. Every winner of the round mints the reward in full.", defaultDurationMs: 30_000, durationLabel: "Round window", supportsReward: true, defaultRewardXp: 8, defaultRewardCurrency: 3 },
  { name: "trivia", label: "Trivia", description: "60-second trivia round. The first /answer that matches the host's hidden answer wins.", defaultDurationMs: 60_000, durationLabel: "Round window", supportsReward: true, defaultRewardXp: 12, defaultRewardCurrency: 5 },
  { name: "storydice", label: "Story Dice", description: "3-minute round. Server picks four prompt words; players /storydice <text> to submit. Room votes the winner.", defaultDurationMs: 180_000, durationLabel: "Submission window", supportsReward: true, defaultRewardXp: 20, defaultRewardCurrency: 10 },
  { name: "scramble", label: "Word Scramble", description: "Multi-round word-find game. The duration setting is PER ROUND (default 60s); host picks 1-5 rounds at start.", defaultDurationMs: 60_000, durationLabel: "Per-round window", supportsReward: true, defaultRewardXp: 10, defaultRewardCurrency: 4 },
  { name: "duel", label: "Duel", description: "Class-based 1v1 turn combat. The window setting controls how long opponents have to accept the challenge.", defaultDurationMs: 60_000, durationLabel: "Challenge accept window", supportsReward: true, defaultRewardXp: 15, defaultRewardCurrency: 5 },
  { name: "raffle", label: "Room raffle", description: "60-second item / Currency raffle in the host's room. Reward fields are ignored, the prize IS the host's stake.", defaultDurationMs: 60_000, durationLabel: "Claim window", supportsReward: false, defaultRewardXp: 0, defaultRewardCurrency: 0 },
  { name: "announceraffle", label: "Sitewide raffle", description: "3-minute admin-only sitewide raffle. Reward fields are ignored, the prize IS the host's stake.", defaultDurationMs: 180_000, durationLabel: "Claim window", supportsReward: false, defaultRewardXp: 0, defaultRewardCurrency: 0 },
];

/* ============================================================
 * Routes
 * ============================================================ */

export async function registerServerCommandTitleRoutes(app: FastifyInstance, db: Db, io: Io, registry: CommandRegistry): Promise<void> {
  /**
   * Resolve session + server authority for a gated route. Returns a structured
   * failure so each handler can set the status + body verbatim. The flag check
   * (404 when servers are disabled) is the FIRST gate, exactly as plan_ext.md §6
   * requires.
   */
  async function gate(
    req: Parameters<typeof getSessionUser>[0],
    serverId: string,
    key: "manage_commands" | "manage_titles",
  ): Promise<
    | { fail: { code: number; error: string } }
    | { me: { id: string }; serverId: string }
  > {
    if (!areServersEnabled(await getSettings(db))) return { fail: { code: 404, error: "not found" } };
    const me = await getSessionUser(req, db);
    if (!me) return { fail: { code: 401, error: "auth" } };
    const { serverAuthority, serverCan } = await import("../servers/authority.js");
    const a = await serverAuthority(db, me, serverId);
    if (!a.server) return { fail: { code: 404, error: "no server" } };
    if (!serverCan(a, key)) return { fail: { code: 403, error: "forbidden" } };
    return { me: { id: me.id }, serverId };
  }

  /* ---------------------------------------------------------
   *  Commands (manage_commands) — custom_commands WHERE server_id = :id
   * --------------------------------------------------------- */

  app.get<{ Params: { id: string } }>("/servers/:id/commands", async (req, reply) => {
    const g = await gate(req, req.params.id, "manage_commands");
    if ("fail" in g) { reply.code(g.fail.code); return { error: g.fail.error }; }

    const cmds = await db
      .select()
      .from(customCommands)
      .where(eq(customCommands.serverId, g.serverId))
      .orderBy(asc(customCommands.name));
    const ids = cmds.map((c) => c.id);
    const aliasesByCmd = new Map<string, string[]>();
    if (ids.length) {
      const aliases = await db.select().from(customCommandAliases);
      for (const a of aliases) {
        if (!ids.includes(a.commandId)) continue;
        const list = aliasesByCmd.get(a.commandId) ?? [];
        list.push(a.alias);
        aliasesByCmd.set(a.commandId, list);
      }
    }

    // Social-game (built-in) config for THIS server, editable. Read order
    // mirrors the runtime (getBuiltinCommandConfig): this server's override
    // (server_builtin_command_config) → the global default → code defaults.
    // `hasConfig` = this server has its OWN override (vs inheriting).
    const serverRows = await db.select().from(serverBuiltinCommandConfig)
      .where(eq(serverBuiltinCommandConfig.serverId, g.serverId));
    const serverByName = new Map(serverRows.map((r) => [r.commandName, r]));
    const globalRows = await db.select().from(builtinCommandConfig);
    const globalByName = new Map(globalRows.map((r) => [r.commandName, r]));
    const socialGames = BUILTIN_COMMAND_CATALOG.map((entry) => {
      const row = serverByName.get(entry.name) ?? globalByName.get(entry.name);
      return {
        name: entry.name,
        label: entry.label,
        description: entry.description,
        durationLabel: entry.durationLabel,
        supportsReward: entry.supportsReward,
        defaultDurationMs: entry.defaultDurationMs,
        defaultRewardXp: entry.defaultRewardXp,
        defaultRewardCurrency: entry.defaultRewardCurrency,
        hasConfig: serverByName.has(entry.name),
        rewardXp: row?.rewardXp ?? entry.defaultRewardXp,
        rewardCurrency: row?.rewardCurrency ?? entry.defaultRewardCurrency,
        rewardItemKey: row?.rewardItemKey ?? null,
        rewardItemCount: row?.rewardItemCount ?? 0,
        durationMs: row?.durationMs ?? null,
      };
    });

    return {
      commands: cmds.map((c) => ({
        id: c.id,
        name: c.name,
        kind: c.kind,
        template: c.template,
        description: c.description,
        color: c.color,
        enabled: c.enabled,
        allowInline: c.allowInline,
        inlineTemplate: c.inlineTemplate,
        css: c.css,
        aliases: aliasesByCmd.get(c.id) ?? [],
      })),
      socialGames,
      socialGamesReadOnly: false,
    };
  });

  // Per-server social-game config write (Admin Partition — server_builtin_command_config).
  const socialGameBody = z.object({
    durationMs: z.number().int().min(1_000).max(30 * 60 * 1_000).nullable().optional(),
    rewardXp: z.number().int().min(0).max(1_000_000).optional(),
    rewardCurrency: z.number().int().min(0).max(1_000_000).optional(),
    rewardItemKey: z.string().trim().max(64).nullable().optional(),
    rewardItemCount: z.number().int().min(0).max(1_000).optional(),
    reset: z.literal(true).optional(),
  }).strict();

  app.put<{ Params: { id: string; cmdName: string }; Body: unknown }>("/servers/:id/commands/social-games/:cmdName", async (req, reply) => {
    const g = await gate(req, req.params.id, "manage_commands");
    if ("fail" in g) { reply.code(g.fail.code); return { error: g.fail.error }; }
    const name = req.params.cmdName.toLowerCase();
    if (!BUILTIN_COMMAND_CATALOG.some((e) => e.name === name)) { reply.code(404); return { error: "not a social game" }; }
    let body: z.infer<typeof socialGameBody>;
    try { body = socialGameBody.parse(req.body ?? {}); }
    catch { reply.code(400); return { error: "invalid body" }; }
    if (body.reset) {
      // Remove the override → this server inherits the global/code default again.
      await db.delete(serverBuiltinCommandConfig)
        .where(and(eq(serverBuiltinCommandConfig.serverId, g.serverId), eq(serverBuiltinCommandConfig.commandName, name)));
    } else {
      const itemKey = body.rewardItemKey?.trim() ? body.rewardItemKey.trim() : null;
      await db.insert(serverBuiltinCommandConfig).values({
        serverId: g.serverId,
        commandName: name,
        rewardXp: body.rewardXp ?? 0,
        rewardCurrency: body.rewardCurrency ?? 0,
        rewardItemKey: itemKey,
        rewardItemCount: itemKey ? (body.rewardItemCount ?? 0) : 0,
        durationMs: body.durationMs ?? null,
        updatedByUserId: g.me.id,
      }).onConflictDoUpdate({
        target: [serverBuiltinCommandConfig.serverId, serverBuiltinCommandConfig.commandName],
        set: {
          rewardXp: body.rewardXp ?? 0,
          rewardCurrency: body.rewardCurrency ?? 0,
          rewardItemKey: itemKey,
          rewardItemCount: itemKey ? (body.rewardItemCount ?? 0) : 0,
          durationMs: body.durationMs ?? null,
          updatedByUserId: g.me.id,
          updatedAt: new Date(),
        },
      });
    }
    await auditServer(db, { serverId: g.serverId, actorUserId: g.me.id, action: "server_social_game_config", metadata: { name, reset: !!body.reset } });
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/servers/:id/commands", async (req, reply) => {
    const g = await gate(req, req.params.id, "manage_commands");
    if ("fail" in g) { reply.code(g.fail.code); return { error: g.fail.error }; }
    let body: z.infer<typeof customCommandBody>;
    try { body = customCommandBody.parse(req.body); }
    catch { reply.code(400); return { error: "invalid body" }; }

    const name = body.name.toLowerCase();
    const aliasList = (body.aliases ?? []).map((a) => a.toLowerCase());
    // The name + alias namespace is GLOBAL (custom_commands_name_uq spans every
    // server + the platform). Pre-check the WHOLE table so we 409 cleanly
    // instead of tripping the unique constraint.
    if (await commandNameTaken(db, name)) { reply.code(409); return { error: `the command "/${name}" already exists` }; }
    for (const a of aliasList) {
      if (await commandNameTaken(db, a)) { reply.code(409); return { error: `the alias "/${a}" already exists` }; }
      if (await aliasTaken(db, a)) { reply.code(409); return { error: `the alias "/${a}" already exists` }; }
    }

    const id = nanoid();
    const safeCss = body.css == null ? null : (sanitizeCustomCmdCss(body.css) || null);
    await db.insert(customCommands).values({
      id,
      name,
      kind: body.kind,
      template: body.template,
      description: body.description ?? null,
      enabled: body.enabled ?? true,
      color: body.color ?? null,
      allowInline: body.allowInline ?? false,
      inlineTemplate: body.inlineTemplate ?? null,
      css: safeCss,
      createdById: g.me.id,
      serverId: g.serverId, // stamp THIS server.
    });
    if (aliasList.length) {
      await db.insert(customCommandAliases).values(aliasList.map((a) => ({ alias: a, commandId: id })));
    }
    await registry.reloadCustom(db); // hot-swap dispatch so the edit applies immediately
    emitCommandsUpdated(io, g.serverId);
    await auditServer(db, { serverId: g.serverId, actorUserId: g.me.id, action: "server_custom_command_create", metadata: { id, name, kind: body.kind } });
    return { ok: true, id };
  });

  app.patch<{ Params: { id: string; cmdId: string }; Body: unknown }>("/servers/:id/commands/:cmdId", async (req, reply) => {
    const g = await gate(req, req.params.id, "manage_commands");
    if ("fail" in g) { reply.code(g.fail.code); return { error: g.fail.error }; }
    const parsedBody = customCommandBody.partial().safeParse(req.body);
    if (!parsedBody.success) { reply.code(400); return { error: "invalid body" }; }
    const body = parsedBody.data;

    // Scope: the command must belong to THIS server.
    const existing = (await db
      .select()
      .from(customCommands)
      .where(and(eq(customCommands.id, req.params.cmdId), eq(customCommands.serverId, g.serverId)))
      .limit(1))[0];
    if (!existing) { reply.code(404); return { error: "no such command in this server" }; }

    if (body.name !== undefined) {
      const next = body.name.toLowerCase();
      if (next !== existing.name && (await commandNameTaken(db, next))) {
        reply.code(409); return { error: `the command "/${next}" already exists` };
      }
    }
    const aliasList = body.aliases?.map((a) => a.toLowerCase());
    if (aliasList !== undefined) {
      for (const a of aliasList) {
        // A name owned by a DIFFERENT command, or an alias on a different
        // command, is a conflict; this command's own aliases are fine.
        if (await commandNameTaken(db, a)) { reply.code(409); return { error: `the alias "/${a}" already exists` }; }
        if (await aliasTaken(db, a, req.params.cmdId)) { reply.code(409); return { error: `the alias "/${a}" already exists` }; }
      }
    }

    await db
      .update(customCommands)
      .set({
        ...(body.name !== undefined ? { name: body.name.toLowerCase() } : {}),
        ...(body.kind !== undefined ? { kind: body.kind } : {}),
        ...(body.template !== undefined ? { template: body.template } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.color !== undefined ? { color: body.color } : {}),
        ...(body.allowInline !== undefined ? { allowInline: body.allowInline } : {}),
        ...(body.inlineTemplate !== undefined ? { inlineTemplate: body.inlineTemplate } : {}),
        ...(body.css !== undefined ? { css: body.css == null ? null : (sanitizeCustomCmdCss(body.css) || null) } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(customCommands.id, req.params.cmdId), eq(customCommands.serverId, g.serverId)));

    if (aliasList !== undefined) {
      await db.delete(customCommandAliases).where(eq(customCommandAliases.commandId, req.params.cmdId));
      if (aliasList.length) {
        await db.insert(customCommandAliases).values(aliasList.map((a) => ({ alias: a, commandId: req.params.cmdId })));
      }
    }
    await registry.reloadCustom(db); // hot-swap dispatch so the edit applies immediately
    emitCommandsUpdated(io, g.serverId);
    await auditServer(db, { serverId: g.serverId, actorUserId: g.me.id, action: "server_custom_command_update", metadata: { id: req.params.cmdId, keys: Object.keys(body) } });
    return { ok: true };
  });

  app.delete<{ Params: { id: string; cmdId: string } }>("/servers/:id/commands/:cmdId", async (req, reply) => {
    const g = await gate(req, req.params.id, "manage_commands");
    if ("fail" in g) { reply.code(g.fail.code); return { error: g.fail.error }; }
    const existing = (await db
      .select()
      .from(customCommands)
      .where(and(eq(customCommands.id, req.params.cmdId), eq(customCommands.serverId, g.serverId)))
      .limit(1))[0];
    if (!existing) { reply.code(404); return { error: "no such command in this server" }; }
    // Aliases cascade by FK; delete the command row.
    await db.delete(customCommands).where(and(eq(customCommands.id, req.params.cmdId), eq(customCommands.serverId, g.serverId)));
    await registry.reloadCustom(db); // hot-swap dispatch so the edit applies immediately
    emitCommandsUpdated(io, g.serverId);
    await auditServer(db, { serverId: g.serverId, actorUserId: g.me.id, action: "server_custom_command_delete", metadata: { id: req.params.cmdId, name: existing.name } });
    return { ok: true };
  });

  /* ---------------------------------------------------------
   *  Titles (manage_titles) — title_kinds WHERE server_id = :id
   * --------------------------------------------------------- */

  app.get<{ Params: { id: string } }>("/servers/:id/titles", async (req, reply) => {
    const g = await gate(req, req.params.id, "manage_titles");
    if ("fail" in g) { reply.code(g.fail.code); return { error: g.fail.error }; }
    const kinds = await db
      .select()
      .from(titleKinds)
      .where(eq(titleKinds.serverId, g.serverId))
      .orderBy(asc(titleKinds.slug));
    const counts = await db
      .select({ kindId: mutualTitles.kindId, n: sql<number>`count(*)` })
      .from(mutualTitles)
      .groupBy(mutualTitles.kindId);
    const byId = new Map(counts.map((r) => [r.kindId, r.n]));
    return {
      kinds: kinds.map((k) => ({
        id: k.id,
        slug: k.slug,
        label: k.label,
        symmetric: k.symmetric,
        formatA: k.formatA,
        formatB: k.formatB,
        exclusive: k.exclusive,
        enabled: k.enabled,
        usageCount: byId.get(k.id) ?? 0,
        updatedAt: +k.updatedAt,
      })),
    };
  });

  app.post<{ Params: { id: string }; Body: unknown }>("/servers/:id/titles", async (req, reply) => {
    const g = await gate(req, req.params.id, "manage_titles");
    if ("fail" in g) { reply.code(g.fail.code); return { error: g.fail.error }; }
    const parsed = titleKindBody.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: "invalid", details: parsed.error.flatten() }; }
    const { slug, label, symmetric, formatA, formatB, exclusive, enabled } = parsed.data;
    const lower = slug.toLowerCase();
    // title_kinds_slug_uq is GLOBAL — pre-check the whole table.
    if (await titleSlugTaken(db, lower)) { reply.code(409); return { error: "slug already exists" }; }
    const id = nanoid();
    await db.insert(titleKinds).values({
      id,
      slug: lower,
      label,
      symmetric,
      // Symmetric kinds mirror formatA into both columns (matches the global route).
      formatA,
      formatB: symmetric ? formatA : formatB,
      exclusive,
      enabled,
      createdById: g.me.id,
      serverId: g.serverId, // stamp THIS server.
    });
    await auditServer(db, { serverId: g.serverId, actorUserId: g.me.id, action: "server_title_kind_create", metadata: { id, slug: lower } });
    return { ok: true, id };
  });

  app.put<{ Params: { id: string; kindId: string }; Body: unknown }>("/servers/:id/titles/:kindId", async (req, reply) => {
    const g = await gate(req, req.params.id, "manage_titles");
    if ("fail" in g) { reply.code(g.fail.code); return { error: g.fail.error }; }
    const parsed = titleKindBody.safeParse(req.body);
    if (!parsed.success) { reply.code(400); return { error: "invalid", details: parsed.error.flatten() }; }
    const { slug, label, symmetric, formatA, formatB, exclusive, enabled } = parsed.data;
    const existing = (await db
      .select()
      .from(titleKinds)
      .where(and(eq(titleKinds.id, req.params.kindId), eq(titleKinds.serverId, g.serverId)))
      .limit(1))[0];
    if (!existing) { reply.code(404); return { error: "no such title kind in this server" }; }
    const lower = slug.toLowerCase();
    if (lower !== existing.slug.toLowerCase() && (await titleSlugTaken(db, lower))) {
      reply.code(409); return { error: "slug already exists" };
    }
    await db
      .update(titleKinds)
      .set({ slug: lower, label, symmetric, formatA, formatB: symmetric ? formatA : formatB, exclusive, enabled, updatedAt: new Date() })
      .where(and(eq(titleKinds.id, req.params.kindId), eq(titleKinds.serverId, g.serverId)));
    await auditServer(db, { serverId: g.serverId, actorUserId: g.me.id, action: "server_title_kind_update", metadata: { id: req.params.kindId, slug: lower } });
    return { ok: true };
  });

  app.delete<{ Params: { id: string; kindId: string } }>("/servers/:id/titles/:kindId", async (req, reply) => {
    const g = await gate(req, req.params.id, "manage_titles");
    if ("fail" in g) { reply.code(g.fail.code); return { error: g.fail.error }; }
    const existing = (await db
      .select()
      .from(titleKinds)
      .where(and(eq(titleKinds.id, req.params.kindId), eq(titleKinds.serverId, g.serverId)))
      .limit(1))[0];
    if (!existing) { reply.code(404); return { error: "no such title kind in this server" }; }
    // Cascades to mutual_titles of this kind by FK (matches the global route).
    await db.delete(titleKinds).where(and(eq(titleKinds.id, req.params.kindId), eq(titleKinds.serverId, g.serverId)));
    await auditServer(db, { serverId: g.serverId, actorUserId: g.me.id, action: "server_title_kind_delete", metadata: { id: req.params.kindId, slug: existing.slug } });
    return { ok: true };
  });
}

/* ============================================================
 * Namespace pre-checks (the unique indexes are GLOBAL).
 * ============================================================ */

/** Is `name` already a custom-command NAME anywhere (any server / platform)? */
async function commandNameTaken(db: Db, name: string): Promise<boolean> {
  const row = (await db
    .select({ id: customCommands.id })
    .from(customCommands)
    .where(sql`lower(${customCommands.name}) = ${name.toLowerCase()}`)
    .limit(1))[0];
  return !!row;
}

/** Is `alias` already a custom-command ALIAS anywhere, excluding `exceptCmdId`? */
async function aliasTaken(db: Db, alias: string, exceptCmdId?: string): Promise<boolean> {
  const row = (await db
    .select({ commandId: customCommandAliases.commandId })
    .from(customCommandAliases)
    .where(sql`lower(${customCommandAliases.alias}) = ${alias.toLowerCase()}`)
    .limit(1))[0];
  if (!row) return false;
  return exceptCmdId ? row.commandId !== exceptCmdId : true;
}

/** Is `slug` already a title-kind SLUG anywhere (any server / platform)? */
async function titleSlugTaken(db: Db, slug: string): Promise<boolean> {
  const row = (await db
    .select({ id: titleKinds.id })
    .from(titleKinds)
    .where(sql`lower(${titleKinds.slug}) = ${slug.toLowerCase()}`)
    .limit(1))[0];
  return !!row;
}
