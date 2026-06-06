/**
 * Identity-target argument resolution for slash commands.
 *
 * Most identity-keyed commands (whisper, /whois, friends, mod actions)
 * used to take a NAME and look it up against either the users or
 * characters table. Two failure modes leaked through that pattern:
 *
 *   1. Name collisions. Multiple characters can share a given name
 *      ("Jagger") and the lookup just returned the first hit, which
 *      meant a click on one Jagger in the userlist could end up
 *      whispering / kicking / friending another Jagger entirely.
 *
 *   2. Click-driven flows that ALREADY had the id had to convert it
 *      back to a name to fit the command parser, then the parser
 *      converted the name back to an id. Lossy round-trip; broke on
 *      collisions; no way for the client to say "I specifically mean
 *      THIS identity."
 *
 * This module is the shared resolver every name-keyed command routes
 * through. Two new token shapes the parser recognizes:
 *
 *   @id:<userId>       , addresses the user / master.
 *   @cid:<characterId> , addresses the character. The server reads
 *                          the row to discover the owning userId.
 *
 * For tokens, the caller is asserting the id they hold; we validate
 * the row exists and isn't soft-deleted / disabled, then return a
 * unique result.
 *
 * For bare names, we run the existing NBSP-aware lookup and collect
 * EVERY match (master + character rows), when more than one falls
 * out, the caller emits an ambiguous-result notice so the user can
 * paste the right token. That replaces the previous silent "first
 * hit wins" behavior with a "tell me which Jagger" prompt.
 *
 * Token format is intentionally opaque to end users, the click
 * handlers and (Phase 2) the mention autocomplete insert these
 * directly so a user rarely needs to type one by hand.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { characters, users } from "../db/schema.js";
import type { CommandContext } from "./types.js";

/** Token recognizer literals, the only two prefixes we accept. */
const USER_TOKEN_PREFIX = "@id:";
const CHARACTER_TOKEN_PREFIX = "@cid:";

/**
 * Resolved target shape every command consumes. Carries enough to
 * format a user-visible message ("kicked Jagger") AND to take action
 * (userId for user-scoped operations, characterId for per-identity
 * ones like friend requests).
 *
 * `displayName` is the user-facing label for the identity the caller
 * specified, character name when scope is character, master username
 * otherwise. `masterUsername` is always populated so the caller can
 * disambiguate in audit / notification copy ("Jagger (E D Erin)").
 */
export interface ResolvedTarget {
  userId: string;
  characterId: string | null;
  displayName: string;
  masterUsername: string;
}

/**
 * `unique`, exactly one identity matched (token or name).
 * `ambiguous`, name matched more than one identity; the caller emits a
 *               disambig notice listing the matches with their tokens.
 * `none`, no match (no user / no character, or disabled / soft-deleted).
 */
export type ResolveResult =
  | { kind: "unique"; target: ResolvedTarget }
  | { kind: "ambiguous"; matches: ResolvedTarget[] }
  | { kind: "none" };

/** Token kind once parsed, or null if `raw` isn't a token at all. */
export type ParsedToken =
  | { kind: "user"; userId: string }
  | { kind: "character"; characterId: string };

/**
 * Inspect `raw` and return its parsed shape if it's a token, or null
 * if it should be treated as a plain name. We do NOT validate the id
 * is real here, that's the resolver's job. Whitespace inside an id
 * rejects the token (nanoids never contain spaces); a trailing slice
 * with no body (e.g. bare `@id:`) also rejects.
 */
export function parseIdentityToken(raw: string): ParsedToken | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith(USER_TOKEN_PREFIX)) {
    const id = trimmed.slice(USER_TOKEN_PREFIX.length);
    if (!id || /\s/.test(id)) return null;
    return { kind: "user", userId: id };
  }
  if (trimmed.startsWith(CHARACTER_TOKEN_PREFIX)) {
    const id = trimmed.slice(CHARACTER_TOKEN_PREFIX.length);
    if (!id || /\s/.test(id)) return null;
    return { kind: "character", characterId: id };
  }
  return null;
}

/**
 * Build a display token a user can paste back into chat to reach a
 * specific identity unambiguously. Used by the ambiguous-result
 * disambig system message: `Multiple Jaggers, Jagger [@cid:abc],
 * Jagger [@id:def]`.
 */
export function formatTokenFor(target: ResolvedTarget): string {
  return target.characterId
    ? `${CHARACTER_TOKEN_PREFIX}${target.characterId}`
    : `${USER_TOKEN_PREFIX}${target.userId}`;
}

/**
 * Shared resolver. Drop-in replacement for every command that used to
 * take a name. Three terminal states:
 *
 *   - unique:    safe to act on `result.target`.
 *   - ambiguous: emit a system notice with `formatTokenFor` for each
 *                match and bail.
 *   - none:      emit your standard "no such user" error and bail.
 *
 * Soft-deleted characters and disabled master accounts are filtered
 * out of every path so a stale token can't reach a tombstone.
 */
export async function resolveIdentityArg(
  db: Db,
  raw: string,
): Promise<ResolveResult> {
  const token = parseIdentityToken(raw);
  if (token) {
    return resolveToken(db, token);
  }
  return resolveByName(db, raw);
}

/**
 * Validate a parsed token against the DB. Returns `unique` when the
 * row exists and is in good standing, `none` otherwise. Tokens never
 * produce `ambiguous`, the caller asserted a specific id.
 */
async function resolveToken(db: Db, token: ParsedToken): Promise<ResolveResult> {
  if (token.kind === "user") {
    const u = (await db
      .select({ id: users.id, username: users.username, disabledAt: users.disabledAt })
      .from(users)
      .where(eq(users.id, token.userId))
      .limit(1))[0];
    if (!u || u.disabledAt) return { kind: "none" };
    return {
      kind: "unique",
      target: {
        userId: u.id,
        characterId: null,
        displayName: u.username,
        masterUsername: u.username,
      },
    };
  }
  // Character token. Resolve through to the owner row so the caller
  // gets both ids in one shot, many commands operate on the user
  // account (whisper delivery, kick, ban) even when the click landed
  // on a character row.
  const row = (await db
    .select({
      charId: characters.id,
      charName: characters.name,
      charDeletedAt: characters.deletedAt,
      ownerUserId: users.id,
      ownerUsername: users.username,
      ownerDisabledAt: users.disabledAt,
    })
    .from(characters)
    .innerJoin(users, eq(users.id, characters.userId))
    .where(eq(characters.id, token.characterId))
    .limit(1))[0];
  if (!row || row.charDeletedAt || row.ownerDisabledAt) return { kind: "none" };
  return {
    kind: "unique",
    target: {
      userId: row.ownerUserId,
      characterId: row.charId,
      displayName: row.charName,
      masterUsername: row.ownerUsername,
    },
  };
}

/**
 * Name-based fallback. Mirrors the legacy NBSP-aware lookups across
 * users + characters but DOESN'T short-circuit on the first hit,
 * collects every viable match so the caller can decide whether the
 * result is unique or ambiguous.
 *
 * Disabled users + soft-deleted characters are filtered at the SQL
 * level so they don't pollute the match count.
 */
async function resolveByName(db: Db, raw: string): Promise<ResolveResult> {
  const name = raw.trim();
  if (!name) return { kind: "none" };
  const NBSP = String.fromCharCode(0xA0);
  // Same variant-fan-out as `resolveIdentityByName` so a user typed
  // with regular spaces matches a master whose canonical row uses
  // NBSP separators (and vice versa).
  const variants = Array.from(new Set([
    name,
    name.replace(/ /g, NBSP),
    name.replace(new RegExp(NBSP, "g"), " "),
  ])).map((v) => v.toLowerCase());

  const matches: ResolvedTarget[] = [];

  const userRows = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(and(
      sql`lower(${users.username}) IN (${sql.join(variants.map((v) => sql`${v}`), sql`, `)})`,
      isNull(users.disabledAt),
    ));
  for (const u of userRows) {
    matches.push({
      userId: u.id,
      characterId: null,
      displayName: u.username,
      masterUsername: u.username,
    });
  }

  const charRows = await db
    .select({
      charId: characters.id,
      charName: characters.name,
      ownerUserId: users.id,
      ownerUsername: users.username,
    })
    .from(characters)
    .innerJoin(users, eq(users.id, characters.userId))
    .where(and(
      sql`lower(${characters.name}) IN (${sql.join(variants.map((v) => sql`${v}`), sql`, `)})`,
      isNull(characters.deletedAt),
      isNull(users.disabledAt),
    ));
  for (const r of charRows) {
    matches.push({
      userId: r.ownerUserId,
      characterId: r.charId,
      displayName: r.charName,
      masterUsername: r.ownerUsername,
    });
  }

  if (matches.length === 0) return { kind: "none" };
  if (matches.length === 1) return { kind: "unique", target: matches[0]! };
  return { kind: "ambiguous", matches };
}

/**
 * Surface an ambiguous-identity disambiguation prompt via the
 * persistent info modal. Every command that resolves an identity arg
 * (`/whois`, `/whisper`, `/ignore`, `/friends`, `/mod ...`) calls this
 * when the user-typed name maps to more than one identity, the user
 * needs to read the candidate list carefully, pick the right token,
 * and re-run with that exact token. The 6-second toast was too short
 * for that workflow.
 *
 * The body is one bullet per candidate with the resolved `@cid:` /
 * `@id:` token at the end, ready to copy verbatim into the re-run.
 *
 * Example modal body for `/whisper Jagger`:
 *   `  • Jagger (E D Erin), @cid:abc123
 *     • Jagger (Sigrid), @cid:def456`
 *
 * The title carries the count + typed-name context so the modal
 * header is self-describing without the body needing to repeat it.
 */
export function emitAmbiguousIdentityModal(
  ctx: CommandContext,
  typedName: string,
  matches: ResolvedTarget[],
): void {
  const lines = matches.map((m) => {
    // For master rows the masterUsername IS the displayName; skip the
    // redundant parenthesized label there.
    const label = m.characterId
      ? `${m.displayName} (${m.masterUsername})`
      : m.displayName;
    return `  • ${label}, ${formatTokenFor(m)}`;
  });
  ctx.socket.emit("ui:hint", {
    kind: "open-info-modal",
    title: `"${typedName}" matched ${matches.length} identities`,
    body: `Re-run with one of:\n${lines.join("\n")}`,
  });
}
