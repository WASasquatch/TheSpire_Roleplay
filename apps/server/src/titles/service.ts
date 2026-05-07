import { and, eq, isNull, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Server as IoServer } from "socket.io";
import type {
  ClientToServerEvents,
  IdentityRef,
  ProfileTitle,
  ServerToClientEvents,
} from "@thekeep/shared";
import { characters, ignores, mutualTitles, titleKinds, users } from "../db/schema.js";
import type { Db } from "../db/index.js";

/**
 * A title-bound identity. `characterId` null means "the master account".
 * Two identities are equal iff (userId, characterId) pairs match.
 */
export interface Identity {
  userId: string;
  characterId: string | null;
  /** Best display name for the identity (master username or character name). */
  displayName: string;
}

export interface RequestResult {
  ok: boolean;
  code?: string;
  message?: string;
  /** The recipient's userId, when ok=true - used by the caller to broadcast. */
  recipientUserId?: string;
  prompt?: MutualPromptPayload;
  /** UserIds whose open profile views should refresh after a settled change. */
  affectedUserIds?: string[];
}

export interface MutualPromptPayload {
  id: string;
  action: "request" | "dissolve";
  kindSlug: string;
  kindLabel: string;
  fromDisplayName: string;
  from: IdentityRef;
  /** What the title would say on the recipient's profile if they accepted. */
  previewText: string;
}

type Side = "a" | "b";

/* -------------------------------------------------------------------------- */
/*  Identity helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a name (master username OR character name) to an identity. Mirrors
 * the precedence in /whois: master usernames are globally unique and win
 * over character names. Returns null when the name maps to no live identity
 * (disabled user, soft-deleted character, etc.).
 */
export async function resolveIdentityByName(db: Db, name: string): Promise<Identity | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;

  const u = (await db
    .select()
    .from(users)
    .where(sql`lower(${users.username}) = ${trimmed.toLowerCase()}`)
    .limit(1))[0];
  if (u && !u.disabledAt) {
    return { userId: u.id, characterId: null, displayName: u.username };
  }

  const c = (await db
    .select()
    .from(characters)
    .where(sql`lower(${characters.name}) = ${trimmed.toLowerCase()}`)
    .limit(1))[0];
  if (!c || c.deletedAt) return null;

  const owner = (await db.select().from(users).where(eq(users.id, c.userId)).limit(1))[0];
  if (!owner || owner.disabledAt) return null;

  return { userId: c.userId, characterId: c.id, displayName: c.name };
}

/**
 * Current identity = whichever profile this session is presenting as. If the
 * user has an active character, that's the identity titles attach to; otherwise
 * it's the master account. The session's `displayName` already reflects the
 * active identity, so we reuse it.
 */
export function currentIdentity(session: {
  id: string;
  activeCharacterId: string | null;
  displayName: string;
}): Identity {
  return {
    userId: session.id,
    characterId: session.activeCharacterId,
    displayName: session.displayName,
  };
}

function identitiesEqual(a: Identity, b: Identity): boolean {
  return a.userId === b.userId && a.characterId === b.characterId;
}

/* -------------------------------------------------------------------------- */
/*  Format rendering                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Substitute `{target}` in a kind's format string with the other party's
 * display name. The catalog stores raw format strings; sanitizing for HTML
 * happens at render time on the client (titles are plain text).
 */
function renderFormat(format: string, otherDisplayName: string): string {
  return format.replaceAll("{target}", otherDisplayName);
}

/* -------------------------------------------------------------------------- */
/*  Listing                                                                    */
/* -------------------------------------------------------------------------- */

interface TitleRow {
  id: string;
  kindSlug: string;
  formatA: string;
  formatB: string;
  status: "pending" | "accepted" | "dissolving";
  aUserId: string;
  aCharacterId: string | null;
  bUserId: string;
  bCharacterId: string | null;
  aMasterName: string;
  aCharName: string | null;
  bMasterName: string;
  bCharName: string | null;
}

/**
 * List the accepted titles attached to a given identity. Pending and
 * dissolving titles are NOT returned (they'd leak in-flight relationship
 * state to anyone who runs /whois). For the purposes of the recipient's
 * own UI, the prompt event already carries the in-flight info.
 */
export async function listTitlesForIdentity(db: Db, identity: Identity): Promise<ProfileTitle[]> {
  // characterId IS NULL needs `IS` not `=` in SQL; drizzle's eq() generates
  // `=` which won't match NULL. We fall back to raw SQL for the nullable
  // half of the predicate.
  const charPredA = identity.characterId === null
    ? sql`${mutualTitles.aCharacterId} IS NULL`
    : sql`${mutualTitles.aCharacterId} = ${identity.characterId}`;
  const charPredB = identity.characterId === null
    ? sql`${mutualTitles.bCharacterId} IS NULL`
    : sql`${mutualTitles.bCharacterId} = ${identity.characterId}`;

  const aOwner = sql`${users.id} = ${mutualTitles.aUserId}`;
  const bOwner = sql`${users.id} = ${mutualTitles.bUserId}`;

  // Two queries (one per side) is simpler than a complex self-join. Each
  // returns rows where this identity is on that side; we render with the
  // matching format and pull the *other* side's display name.
  const onA = (await db
    .select({
      id: mutualTitles.id,
      kindSlug: titleKinds.slug,
      formatA: titleKinds.formatA,
      formatB: titleKinds.formatB,
      otherUserId: mutualTitles.bUserId,
      otherCharacterId: mutualTitles.bCharacterId,
    })
    .from(mutualTitles)
    .innerJoin(titleKinds, eq(titleKinds.id, mutualTitles.kindId))
    .where(
      and(
        eq(mutualTitles.aUserId, identity.userId),
        charPredA,
        eq(mutualTitles.status, "accepted"),
      ),
    )) as Array<{
      id: string;
      kindSlug: string;
      formatA: string;
      formatB: string;
      otherUserId: string;
      otherCharacterId: string | null;
    }>;

  const onB = (await db
    .select({
      id: mutualTitles.id,
      kindSlug: titleKinds.slug,
      formatA: titleKinds.formatA,
      formatB: titleKinds.formatB,
      otherUserId: mutualTitles.aUserId,
      otherCharacterId: mutualTitles.aCharacterId,
    })
    .from(mutualTitles)
    .innerJoin(titleKinds, eq(titleKinds.id, mutualTitles.kindId))
    .where(
      and(
        eq(mutualTitles.bUserId, identity.userId),
        charPredB,
        eq(mutualTitles.status, "accepted"),
      ),
    )) as Array<{
      id: string;
      kindSlug: string;
      formatA: string;
      formatB: string;
      otherUserId: string;
      otherCharacterId: string | null;
    }>;

  // Resolve the other party's display name for each row. Batch the lookups
  // by collecting unique userIds + characterIds.
  const userIds = new Set<string>();
  const charIds = new Set<string>();
  for (const r of [...onA, ...onB]) {
    userIds.add(r.otherUserId);
    if (r.otherCharacterId) charIds.add(r.otherCharacterId);
  }

  const userRows = userIds.size === 0
    ? []
    : await db.select({ id: users.id, username: users.username, disabledAt: users.disabledAt })
        .from(users)
        .where(sql`${users.id} IN ${[...userIds]}`);
  const charRows = charIds.size === 0
    ? []
    : await db.select({ id: characters.id, name: characters.name, deletedAt: characters.deletedAt })
        .from(characters)
        .where(sql`${characters.id} IN ${[...charIds]}`);

  const usernameById = new Map(userRows.map((r) => [r.id, { name: r.username, disabled: !!r.disabledAt }]));
  const charById = new Map(charRows.map((r) => [r.id, { name: r.name, deleted: !!r.deletedAt }]));

  const out: ProfileTitle[] = [];

  function addRow(
    r: { id: string; kindSlug: string; formatA: string; formatB: string; otherUserId: string; otherCharacterId: string | null },
    side: Side,
  ) {
    let displayName: string;
    if (r.otherCharacterId) {
      const ch = charById.get(r.otherCharacterId);
      if (!ch || ch.deleted) return; // hide titles whose other party was wiped
      displayName = ch.name;
    } else {
      const u = usernameById.get(r.otherUserId);
      if (!u || u.disabled) return;
      displayName = u.name;
    }
    const format = side === "a" ? r.formatA : r.formatB;
    out.push({
      id: r.id,
      kindSlug: r.kindSlug,
      text: renderFormat(format, displayName),
      other: { userId: r.otherUserId, characterId: r.otherCharacterId, displayName },
    });
  }

  for (const r of onA) addRow(r, "a");
  for (const r of onB) addRow(r, "b");

  // Stable order by kind slug then text, so the profile UI is deterministic.
  out.sort((x, y) => x.kindSlug.localeCompare(y.kindSlug) || x.text.localeCompare(y.text));
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Lookup helpers                                                             */
/* -------------------------------------------------------------------------- */

async function findKindBySlug(db: Db, slug: string) {
  return (await db
    .select()
    .from(titleKinds)
    .where(sql`lower(${titleKinds.slug}) = ${slug.toLowerCase()}`)
    .limit(1))[0];
}

/**
 * Find an in-flight or accepted title row for a given (kind, identity-pair),
 * in either direction. Used to detect duplicates before creating a request,
 * and to find the row to dissolve.
 */
async function findExistingRow(
  db: Db,
  kindId: string,
  one: Identity,
  two: Identity,
): Promise<typeof mutualTitles.$inferSelect | undefined> {
  const aChar = one.characterId === null
    ? sql`${mutualTitles.aCharacterId} IS NULL`
    : sql`${mutualTitles.aCharacterId} = ${one.characterId}`;
  const bChar = two.characterId === null
    ? sql`${mutualTitles.bCharacterId} IS NULL`
    : sql`${mutualTitles.bCharacterId} = ${two.characterId}`;
  const aChar2 = two.characterId === null
    ? sql`${mutualTitles.aCharacterId} IS NULL`
    : sql`${mutualTitles.aCharacterId} = ${two.characterId}`;
  const bChar2 = one.characterId === null
    ? sql`${mutualTitles.bCharacterId} IS NULL`
    : sql`${mutualTitles.bCharacterId} = ${one.characterId}`;

  return (await db
    .select()
    .from(mutualTitles)
    .where(
      and(
        eq(mutualTitles.kindId, kindId),
        or(
          and(eq(mutualTitles.aUserId, one.userId), aChar, eq(mutualTitles.bUserId, two.userId), bChar),
          and(eq(mutualTitles.aUserId, two.userId), aChar2, eq(mutualTitles.bUserId, one.userId), bChar2),
        ),
      ),
    )
    .limit(1))[0];
}

/**
 * For exclusive kinds, check whether this identity already holds an
 * accepted title of the given kind. Returns the offending row if so.
 */
async function findExclusiveConflict(
  db: Db,
  kindId: string,
  identity: Identity,
): Promise<typeof mutualTitles.$inferSelect | undefined> {
  const aChar = identity.characterId === null
    ? sql`${mutualTitles.aCharacterId} IS NULL`
    : sql`${mutualTitles.aCharacterId} = ${identity.characterId}`;
  const bChar = identity.characterId === null
    ? sql`${mutualTitles.bCharacterId} IS NULL`
    : sql`${mutualTitles.bCharacterId} = ${identity.characterId}`;
  return (await db
    .select()
    .from(mutualTitles)
    .where(
      and(
        eq(mutualTitles.kindId, kindId),
        eq(mutualTitles.status, "accepted"),
        or(
          and(eq(mutualTitles.aUserId, identity.userId), aChar),
          and(eq(mutualTitles.bUserId, identity.userId), bChar),
        ),
      ),
    )
    .limit(1))[0];
}

async function isIgnoredBy(db: Db, blockerId: string, blockedId: string): Promise<boolean> {
  const row = (await db
    .select({ x: ignores.userId })
    .from(ignores)
    .where(and(eq(ignores.userId, blockerId), eq(ignores.ignoredUserId, blockedId)))
    .limit(1))[0];
  return !!row;
}

/* -------------------------------------------------------------------------- */
/*  Request                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Create a pending mutual-title request from `requester` to whoever `targetName`
 * resolves to. Validates kind existence, blocks self-requests, ignores, and
 * exclusive-kind conflicts. The recipient's identity is whichever profile is
 * currently active for them - if they have a character active when the
 * request is delivered, the title attaches to that character.
 */
export async function requestTitle(
  db: Db,
  io: IoServer<ClientToServerEvents, ServerToClientEvents>,
  requester: Identity,
  targetName: string,
  kindSlug: string,
): Promise<RequestResult> {
  const kind = await findKindBySlug(db, kindSlug);
  if (!kind || !kind.enabled) {
    return { ok: false, code: "NO_KIND", message: `No title type called "${kindSlug}".` };
  }

  const target = await resolveIdentityByName(db, targetName);
  if (!target) {
    return { ok: false, code: "NO_USER", message: `No user or character named "${targetName}".` };
  }

  if (identitiesEqual(requester, target)) {
    return { ok: false, code: "SELF", message: "You can't request a title with yourself." };
  }

  if (await isIgnoredBy(db, target.userId, requester.userId)) {
    // Mirror /whisper: pretend it went through to avoid leaking the ignore
    // status, but don't actually create the row or notify anyone.
    return { ok: true, recipientUserId: target.userId };
  }

  // Block when there's already a row between this exact identity pair for
  // this kind, in any state - a pending one needs an answer first, an
  // accepted one is already done, a dissolving one is already in-flight.
  const existing = await findExistingRow(db, kind.id, requester, target);
  if (existing) {
    const verb = existing.status === "accepted" ? "already exists" : "is already pending";
    return { ok: false, code: "DUP", message: `That ${kind.label.toLowerCase()} title ${verb}.` };
  }

  if (kind.exclusive) {
    const conflictMine = await findExclusiveConflict(db, kind.id, requester);
    if (conflictMine) {
      return {
        ok: false,
        code: "EXCLUSIVE_SELF",
        message: `You already hold a ${kind.label.toLowerCase()} title; dissolve it first.`,
      };
    }
    const conflictTheirs = await findExclusiveConflict(db, kind.id, target);
    if (conflictTheirs) {
      return {
        ok: false,
        code: "EXCLUSIVE_OTHER",
        message: `${target.displayName} already holds a ${kind.label.toLowerCase()} title.`,
      };
    }
  }

  const id = nanoid();
  await db.insert(mutualTitles).values({
    id,
    kindId: kind.id,
    aUserId: requester.userId,
    aCharacterId: requester.characterId,
    bUserId: target.userId,
    bCharacterId: target.characterId,
    status: "pending",
  });

  // Recipient sees: "[Married to <requester>] - Accept | Decline" - the
  // preview shows the recipient's *own* side (formatB) since that's what
  // would land on their profile. The requester's display name is the
  // {target} substitution from the recipient's perspective.
  const previewText = renderFormat(kind.formatB, requester.displayName);

  return {
    ok: true,
    recipientUserId: target.userId,
    prompt: {
      id,
      action: "request",
      kindSlug: kind.slug,
      kindLabel: kind.label,
      fromDisplayName: requester.displayName,
      from: {
        userId: requester.userId,
        characterId: requester.characterId,
        displayName: requester.displayName,
      },
      previewText,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Dissolve                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Either party can ask to dissolve an accepted title. Like requests, this
 * creates a prompt for the *other* side (Accept = remove, Decline = keep).
 * Identifies the title by (kind, current identity, target name) so the
 * caller doesn't need the row id - matches the slash-command UX of
 * `/dissolve marriage Bob`.
 */
export async function dissolveTitle(
  db: Db,
  io: IoServer<ClientToServerEvents, ServerToClientEvents>,
  initiator: Identity,
  targetName: string,
  kindSlug: string,
): Promise<RequestResult> {
  const kind = await findKindBySlug(db, kindSlug);
  if (!kind) {
    return { ok: false, code: "NO_KIND", message: `No title type called "${kindSlug}".` };
  }

  const target = await resolveIdentityByName(db, targetName);
  if (!target) {
    return { ok: false, code: "NO_USER", message: `No user or character named "${targetName}".` };
  }

  const row = await findExistingRow(db, kind.id, initiator, target);
  if (!row || row.status !== "accepted") {
    return {
      ok: false,
      code: "NO_TITLE",
      message: `You have no ${kind.label.toLowerCase()} title with ${target.displayName}.`,
    };
  }

  const initiatorSide: Side =
    row.aUserId === initiator.userId && row.aCharacterId === initiator.characterId ? "a" : "b";

  await db
    .update(mutualTitles)
    .set({ status: "dissolving", dissolveInitiator: initiatorSide })
    .where(eq(mutualTitles.id, row.id));

  // The prompt goes to the side opposite the initiator. The preview shows
  // the title text from THAT side's profile (so they see what would be
  // removed).
  const recipientFormat = initiatorSide === "a" ? kind.formatB : kind.formatA;
  const previewText = renderFormat(recipientFormat, initiator.displayName);
  const recipientUserId = initiatorSide === "a" ? row.bUserId : row.aUserId;

  return {
    ok: true,
    recipientUserId,
    prompt: {
      id: row.id,
      action: "dissolve",
      kindSlug: kind.slug,
      kindLabel: kind.label,
      fromDisplayName: initiator.displayName,
      from: {
        userId: initiator.userId,
        characterId: initiator.characterId,
        displayName: initiator.displayName,
      },
      previewText,
    },
    affectedUserIds: [row.aUserId, row.bUserId],
  };
}

/* -------------------------------------------------------------------------- */
/*  Respond                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Process an Accept | Decline response. The responder MUST be on the side of
 * the row that didn't initiate the prompt (B side for pending requests, the
 * non-initiator side for dissolves). The four cases:
 *
 *   pending + accept    → flip to accepted; both profiles get the new title.
 *   pending + decline   → delete the row outright; declines leave no record.
 *   dissolving + accept → delete the row (title removed by mutual consent).
 *   dissolving + decline → revert to accepted (title survives).
 */
export async function respondToPrompt(
  db: Db,
  responderUserId: string,
  rowId: string,
  accept: boolean,
): Promise<RequestResult> {
  const row = (await db
    .select()
    .from(mutualTitles)
    .where(eq(mutualTitles.id, rowId))
    .limit(1))[0];
  if (!row) {
    return { ok: false, code: "NO_PROMPT", message: "That request no longer exists." };
  }

  // Authorization: figure out which side the responder is on, then
  // determine if they're the side that should be responding.
  let responderSide: Side | null = null;
  if (row.aUserId === responderUserId) responderSide = "a";
  if (row.bUserId === responderUserId) responderSide = responderSide ?? "b";
  if (row.aUserId === row.bUserId) {
    // Self-pair shouldn't be possible (request rejects same-identity), but
    // defensively pick the non-initiator side based on row state.
    responderSide = row.dissolveInitiator === "a" ? "b" : "a";
  }
  if (responderSide === null) {
    return { ok: false, code: "FORBIDDEN", message: "That request isn't yours to answer." };
  }

  if (row.status === "pending") {
    if (responderSide !== "b") {
      return { ok: false, code: "FORBIDDEN", message: "Only the recipient can answer this request." };
    }
    if (accept) {
      await db
        .update(mutualTitles)
        .set({ status: "accepted", respondedAt: new Date() })
        .where(eq(mutualTitles.id, row.id));
    } else {
      await db.delete(mutualTitles).where(eq(mutualTitles.id, row.id));
    }
    return { ok: true, affectedUserIds: [row.aUserId, row.bUserId] };
  }

  if (row.status === "dissolving") {
    if (row.dissolveInitiator === responderSide) {
      return { ok: false, code: "FORBIDDEN", message: "You initiated this dissolve - the other party answers it." };
    }
    if (accept) {
      await db.delete(mutualTitles).where(eq(mutualTitles.id, row.id));
    } else {
      await db
        .update(mutualTitles)
        .set({ status: "accepted", dissolveInitiator: null })
        .where(eq(mutualTitles.id, row.id));
    }
    return { ok: true, affectedUserIds: [row.aUserId, row.bUserId] };
  }

  // status === "accepted" - nothing to respond to.
  return { ok: false, code: "NO_PROMPT", message: "That request is already settled." };
}

/* -------------------------------------------------------------------------- */
/*  Broadcasting                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Push a `mutual:prompt` event to every live socket owned by `userId`.
 * Multiple tabs/devices all see the prompt; whichever one accepts wins
 * (the others' prompt cards become no-ops once the row state changes).
 */
export async function emitMutualPrompt(
  io: IoServer<ClientToServerEvents, ServerToClientEvents>,
  userId: string,
  payload: MutualPromptPayload,
): Promise<void> {
  const sockets = await io.fetchSockets();
  for (const s of sockets) {
    if ((s.data as { userId?: string }).userId === userId) {
      s.emit("mutual:prompt", payload);
    }
  }
}

/**
 * Notify the given users (across all their sockets) that some mutual-title
 * state changed. Used after accept/decline/dissolve so any open profile
 * modals can refetch and reflect the new state.
 */
export async function emitMutualSettled(
  io: IoServer<ClientToServerEvents, ServerToClientEvents>,
  userIds: string[],
): Promise<void> {
  if (userIds.length === 0) return;
  const ids = new Set(userIds);
  const sockets = await io.fetchSockets();
  for (const s of sockets) {
    const uid = (s.data as { userId?: string }).userId;
    if (uid && ids.has(uid)) s.emit("mutual:settled");
  }
}
// Silence unused-import warning when the file is consumed without all helpers.
void isNull;
