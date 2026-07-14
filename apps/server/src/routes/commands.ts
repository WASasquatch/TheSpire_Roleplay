import type { FastifyInstance } from "fastify";
import { asc, eq } from "drizzle-orm";
import { isModeratorRole } from "@thekeep/shared";
import type { CommandDoc, SubcommandDocWire } from "@thekeep/shared";
import type { CommandRegistry } from "../commands/registry.js";
import { customCommandAliases, customCommands, titleKinds } from "../db/schema.js";
import type { Db } from "../db/index.js";
import { hasPermission } from "../auth/permissions.js";
import {
  commandUnavailableWith,
  isServerStaffOf,
  loadCommandRules,
  type CommandRule,
} from "../lib/commandRules.js";
import { usergroupIdsFor } from "../lib/roleGates.js";
import { parseAcceptLanguage, tFor } from "../i18n.js";
import { getSessionUser } from "./auth.js";

/**
 * GET /commands - what the help modal renders.
 *
 * Returns every built-in command (with subcommand info if declared) plus
 * every enabled custom command. Custom commands are flagged with
 * `isCustom: true` so the UI can group/badge them.
 *
 * Commands that declare a top-level `permission` field on the handler
 * (e.g. /incognito, /trash, /promoteadmin, /demoteadmin, /announceraffle
 * - the filter is generic, so this list is illustrative, not exhaustive)
 * are dropped from the response for callers who don't hold that
 * permission. The dispatcher gates execution independently, but
 * filtering here keeps non-permitted users from seeing the command
 * exists in /help, useful for the incognito case specifically, since
 * the whole point is mods/admins observing without their tools being
 * visible to regular users.
 *
 * NOTE: this only filters on the top-level `permission` field. Commands
 * gated INSIDE run() (room owner/mod checks: /kick, /topic, /theater,
 * etc.) intentionally stay visible to everyone, since room role is
 * contextual - a regular user may be an owner/mod in some room. Their
 * execution is still enforced server-side in run().
 */
export async function registerCommandsRoutes(
  app: FastifyInstance,
  db: Db,
  registry: CommandRegistry,
): Promise<void> {
  app.get<{ Querystring: { serverId?: string } }>("/commands", async (req) => {
    const me = await getSessionUser(req, db);
    // Recipient language for the doc PROSE (descriptions): the account pref
    // when signed in, else Accept-Language (the Help modal is reachable
    // pre-auth). Names / aliases / usage signatures are protocol and stay
    // English (i18n plan §9); catalog misses fall back to the handler's
    // own constant via defaultValue, so en output is byte-identical.
    const locale = me?.locale ?? parseAcceptLanguage(req.headers["accept-language"]);
    const docKey = (s: string): string => s.replace(/[.:]/g, "_");
    // Per-server availability (server_command_rules, migration 0355). When
    // the client scopes the fetch (`?serverId=`), commands the VIEWER can't
    // run in that server are dropped from the doc list so the composer
    // completer and the /help modal never advertise them — dispatch still
    // enforces regardless. No param = the historic unscoped list,
    // byte-identical (old bundles keep working). Staff (site or that
    // server's owner/admin/mod) bypass rules, so their list never shrinks.
    const serverId = typeof req.query.serverId === "string" && req.query.serverId ? req.query.serverId : null;
    let rules: Map<string, CommandRule> | null = null;
    let ruleStaff = false;
    let viewerGroupIds: ReadonlySet<string> = new Set<string>();
    if (serverId) {
      rules = await loadCommandRules(db, serverId);
      if (rules.size > 0 && me) {
        ruleStaff = isModeratorRole(me.role) || (await isServerStaffOf(db, me.id, serverId));
        if (!ruleStaff) viewerGroupIds = await usergroupIdsFor(db, me.id);
      }
    }
    const ruleHidden = (name: string, permission?: string): boolean =>
      !!rules && rules.size > 0 && commandUnavailableWith({ name, permission }, rules, ruleStaff, viewerGroupIds);
    const builtins = registry.listCanonical();
    // Filter out commands the caller can't run. Anonymous viewers
    // (no session) drop every permission-gated command.
    const visibleBuiltins = [];
    for (const c of builtins) {
      if (c.permission) {
        if (!me || !(await hasPermission(me, c.permission, db))) continue;
      }
      // listCanonical also carries custom-command handlers; on a scoped
      // fetch, drop the ones that don't resolve in that server (the same
      // reach dispatch has). True builtins always resolve.
      if (serverId && registry.resolve(c.name, serverId) !== c) continue;
      if (ruleHidden(c.name, c.permission)) continue;
      visibleBuiltins.push(c);
    }
    const builtinDocs: CommandDoc[] = visibleBuiltins.map((c) => ({
      name: c.name,
      aliases: [...(c.aliases ?? [])],
      usage: c.usage ?? `/${c.name}`,
      description: c.description
        ? tFor(locale, `commands:docs.${c.name}.description`, { defaultValue: c.description })
        : "",
      subcommands: (c.subcommands ?? []).map((s) => ({
        verb: s.verb,
        usage: s.usage,
        description: tFor(locale, `commands:docs.${c.name}.sub.${docKey(s.verb)}`, {
          defaultValue: s.description,
        }),
        aliases: [...(s.aliases ?? [])],
      })),
      isCustom: false,
    }));

    // Augment /request + /dissolve with one subcommand entry per
    // enabled title kind. The static handler can only declare a
    // generic `<kind> <user>` subcommand because the kinds catalog
    // is admin-managed and lives in the DB; without this enrichment
    // the help modal would just say "request a title" without
    // telling the user which slugs exist. Here we read the live
    // catalog and emit one row per kind, with a brief asymmetric /
    // exclusive flag in the description so users can tell at a
    // glance which kinds are reciprocal vs role-defining and which
    // can only hold one accepted instance.
    const kinds = await db
      .select({
        slug: titleKinds.slug,
        label: titleKinds.label,
        symmetric: titleKinds.symmetric,
        exclusive: titleKinds.exclusive,
      })
      .from(titleKinds)
      .where(eq(titleKinds.enabled, true))
      .orderBy(asc(titleKinds.slug));
    const kindSubsFor = (cmd: "request" | "dissolve"): SubcommandDocWire[] =>
      kinds.map((k) => {
        // Kind labels are admin-authored catalog content (sent as written);
        // only OUR flag words localize.
        const flags: string[] = [];
        if (!k.symmetric) flags.push(tFor(locale, "commands:docs._flags.asymmetric"));
        if (k.exclusive) flags.push(tFor(locale, "commands:docs._flags.exclusive"));
        const flagText = flags.length > 0 ? ` (${flags.join("; ")})` : "";
        return {
          verb: k.slug,
          usage: `/${cmd} ${k.slug} <user-or-character>`,
          description: `${k.label}${flagText}`,
          aliases: [],
        };
      });
    for (const doc of builtinDocs) {
      if (doc.name === "request" || doc.name === "dissolve") {
        doc.subcommands = [...doc.subcommands, ...kindSubsFor(doc.name)];
      }
    }

    // Custom commands aren't in the builtin list; pull from the DB so we
    // surface descriptions/aliases that admins authored.
    const customRows = await db
      .select()
      .from(customCommands)
      .where(eq(customCommands.enabled, true))
      .orderBy(asc(customCommands.name));
    const aliasRows = await db.select().from(customCommandAliases);
    const aliasesByCmd = new Map<string, string[]>();
    for (const a of aliasRows) {
      const list = aliasesByCmd.get(a.commandId) ?? [];
      list.push(a.alias);
      aliasesByCmd.set(a.commandId, list);
    }
    // Server-scoped fetches also drop custom commands the registry would
    // never resolve there (another server's flavor) plus any rule-hidden
    // name — the same reach `registry.resolve(name, serverId)` gives
    // dispatch. Unscoped fetches keep the historic full list.
    const visibleCustomRows = serverId
      ? customRows.filter((c) => (c.serverId == null || c.serverId === serverId) && !ruleHidden(c.name))
      : customRows;
    const customDocs: CommandDoc[] = visibleCustomRows.map((c) => ({
      name: c.name,
      aliases: aliasesByCmd.get(c.id) ?? [],
      usage: `/${c.name} [args]`,
      // Admin-authored description passes through as written; only OUR
      // placeholder fallback localizes.
      description: c.description ?? tFor(locale, "commands:docs._custom", { kind: c.kind }),
      subcommands: [],
      isCustom: true,
      // Surfaced so the composer's `!name` palette can filter to just
      // the inline-eligible commands. Built-in docs above leave this
      // off, only custom commands can opt in.
      ...(c.allowInline ? { allowInline: true } : {}),
    }));

    // Builtins protected from shadowing → already only one entry per name.
    // Sort everything alphabetically for a predictable modal.
    const all = [...builtinDocs, ...customDocs].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    return { commands: all };
  });
}
