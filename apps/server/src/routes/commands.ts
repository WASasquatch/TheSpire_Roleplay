import type { FastifyInstance } from "fastify";
import { asc, eq } from "drizzle-orm";
import type { CommandDoc, SubcommandDocWire } from "@thekeep/shared";
import type { CommandRegistry } from "../commands/registry.js";
import { customCommandAliases, customCommands, titleKinds } from "../db/schema.js";
import type { Db } from "../db/index.js";

/**
 * GET /commands - what the help modal renders.
 *
 * Returns every built-in command (with subcommand info if declared) plus
 * every enabled custom command. Custom commands are flagged with
 * `isCustom: true` so the UI can group/badge them.
 */
export async function registerCommandsRoutes(
  app: FastifyInstance,
  db: Db,
  registry: CommandRegistry,
): Promise<void> {
  app.get("/commands", async () => {
    const builtins = registry.listCanonical();
    const builtinDocs: CommandDoc[] = builtins.map((c) => ({
      name: c.name,
      aliases: [...(c.aliases ?? [])],
      usage: c.usage ?? `/${c.name}`,
      description: c.description ?? "",
      subcommands: (c.subcommands ?? []).map((s) => ({
        verb: s.verb,
        usage: s.usage,
        description: s.description,
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
        const flags: string[] = [];
        if (!k.symmetric) flags.push("asymmetric");
        if (k.exclusive) flags.push("exclusive — one accepted at a time");
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
    const customDocs: CommandDoc[] = customRows.map((c) => ({
      name: c.name,
      aliases: aliasesByCmd.get(c.id) ?? [],
      usage: `/${c.name} [args]`,
      description: c.description ?? `(custom - ${c.kind})`,
      subcommands: [],
      isCustom: true,
      // Surfaced so the composer's `!name` palette can filter to just
      // the inline-eligible commands. Built-in docs above leave this
      // off — only custom commands can opt in.
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
