/**
 * K1 — the two title commands (`/request` + `/dissolve`) and `/titles` route
 * their name/token argument through the canonical `resolveIdentityArg` (via
 * `resolveTitleTarget`) instead of the old titles-only copy that silently
 * returned the FIRST matching row on a name collision.
 *
 * These tests pin the CORRECTED behavior:
 *   - a name shared by more than one identity resolves `ambiguous` (the old
 *     copy returned the first hit — a `/request marriage Jagger` could
 *     propose to the wrong Jagger), and `requestTitle` surfaces that as an
 *     `AMBIGUOUS` clarifying error rather than acting on a guess;
 *   - and the happy path is UNCHANGED: an unambiguous master username, an
 *     unambiguous character name, and `@id:` / `@cid:` tokens all resolve to
 *     exactly the intended identity.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import {
  ambiguousTargetMessage,
  requestTitle,
  resolveTitleTarget,
} from "../src/titles/service.js";
import { makeTestDb, createUser } from "./helpers/harness.js";

async function insertCharacter(db: Db, userId: string, name: string): Promise<string> {
  const id = nanoid();
  await db.insert(schema.characters).values({ id, userId, name });
  return id;
}

/** Pick any enabled title kind (migrations seed the defaults; slug varies). */
async function anyKindSlug(db: Db): Promise<string> {
  const rows = await db
    .select({ slug: schema.titleKinds.slug })
    .from(schema.titleKinds)
    .where(eq(schema.titleKinds.enabled, true))
    .limit(1);
  const slug = rows[0]?.slug;
  assert.ok(slug, "expected at least one seeded title kind");
  return slug;
}

// Minimal io stand-in; requestTitle never touches it before the resolver runs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockIo: any = { fetchSockets: async () => [] };

test("resolveTitleTarget: unambiguous master username resolves unique (happy path)", async () => {
  const { db } = makeTestDb();
  const alice = await createUser(db, { username: "Alice" });

  const res = await resolveTitleTarget(db, "Alice");
  assert.equal(res.kind, "unique");
  assert.equal(res.kind === "unique" && res.target.userId, alice.id);
  assert.equal(res.kind === "unique" && res.target.characterId, null);
});

test("resolveTitleTarget: unambiguous character name resolves unique to that character (happy path)", async () => {
  const { db } = makeTestDb();
  const owner = await createUser(db, { username: "Owner" });
  const charId = await insertCharacter(db, owner.id, "Solaire");

  const res = await resolveTitleTarget(db, "Solaire");
  assert.equal(res.kind, "unique");
  assert.equal(res.kind === "unique" && res.target.userId, owner.id);
  assert.equal(res.kind === "unique" && res.target.characterId, charId);
});

test("resolveTitleTarget: @cid: token pins the exact character", async () => {
  const { db } = makeTestDb();
  const a = await createUser(db, { username: "OwnerA" });
  const b = await createUser(db, { username: "OwnerB" });
  const charA = await insertCharacter(db, a.id, "Jagger");
  await insertCharacter(db, b.id, "Jagger");

  const res = await resolveTitleTarget(db, `@cid:${charA}`);
  assert.equal(res.kind, "unique");
  assert.equal(res.kind === "unique" && res.target.characterId, charA);
  assert.equal(res.kind === "unique" && res.target.userId, a.id);
});

test("resolveTitleTarget: @id: token pins the master account", async () => {
  const { db } = makeTestDb();
  const u = await createUser(db, { username: "Master" });
  // Give the master a character too, to prove the token targets the OOC row.
  await insertCharacter(db, u.id, "Master");

  const res = await resolveTitleTarget(db, `@id:${u.id}`);
  assert.equal(res.kind, "unique");
  assert.equal(res.kind === "unique" && res.target.userId, u.id);
  assert.equal(res.kind === "unique" && res.target.characterId, null);
});

test("resolveTitleTarget: a name shared by two identities is ambiguous (not first-hit)", async () => {
  const { db } = makeTestDb();
  const a = await createUser(db, { username: "OwnerA" });
  const b = await createUser(db, { username: "OwnerB" });
  await insertCharacter(db, a.id, "Jagger");
  await insertCharacter(db, b.id, "Jagger");

  const res = await resolveTitleTarget(db, "Jagger");
  assert.equal(res.kind, "ambiguous");
  assert.equal(res.kind === "ambiguous" && res.matches.length, 2);
});

test("resolveTitleTarget: unknown name resolves none", async () => {
  const { db } = makeTestDb();
  const res = await resolveTitleTarget(db, "Nobody");
  assert.equal(res.kind, "none");
});

test("requestTitle surfaces an AMBIGUOUS clarifying error instead of proposing to a guessed identity", async () => {
  const { db } = makeTestDb();
  const kind = await anyKindSlug(db);
  const requester = await createUser(db, { username: "Requester" });
  const a = await createUser(db, { username: "OwnerA" });
  const b = await createUser(db, { username: "OwnerB" });
  await insertCharacter(db, a.id, "Jagger");
  await insertCharacter(db, b.id, "Jagger");

  const result = await requestTitle(
    db,
    mockIo,
    { userId: requester.id, characterId: null, displayName: "Requester" },
    "Jagger",
    kind,
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, "AMBIGUOUS");
  // No row was created — the request did not silently target one Jagger.
  const rows = await db.select().from(schema.mutualTitles);
  assert.equal(rows.length, 0);
});

test("requestTitle happy path still proposes to an unambiguous target", async () => {
  const { db } = makeTestDb();
  const kind = await anyKindSlug(db);
  const requester = await createUser(db, { username: "Requester" });
  const target = await createUser(db, { username: "Beloved" });

  const result = await requestTitle(
    db,
    mockIo,
    { userId: requester.id, characterId: null, displayName: "Requester" },
    "Beloved",
    kind,
  );

  assert.equal(result.ok, true);
  assert.equal(result.recipientUserId, target.id);
  const rows = await db.select().from(schema.mutualTitles);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.bUserId, target.id);
});

test("ambiguousTargetMessage lists each candidate with a paste-ready token", () => {
  const msg = ambiguousTargetMessage("Jagger", [
    { userId: "u1", characterId: "c1", displayName: "Jagger", masterUsername: "OwnerA" },
    { userId: "u2", characterId: "c2", displayName: "Jagger", masterUsername: "OwnerB" },
  ]);
  assert.match(msg, /matches 2 identities/);
  assert.match(msg, /@cid:c1/);
  assert.match(msg, /@cid:c2/);
});
