import "./helpers/env.js"; // MUST be first - sets SQLITE_PATH before the db singleton loads
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { characterJournalEntries, characterPortraits, characters, userPortraits, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { lookupProfile } from "../src/commands/builtins/profile.js";
import { registerCharacterRoutes } from "../src/routes/characters.js";
import { registerJournalRoutes } from "../src/routes/journal.js";
import { auth, buildUsersApp, createUser, makeTestDb, tokenFor } from "./helpers/harness.js";

/**
 * Age-restriction plan Phase 1 — profiles. The invariants under test:
 *
 *   1. `lookupProfile` (the single resolver behind /profiles/:name, /whois,
 *      socket profile:fetch, and userlist clicks) never hands a minor viewer
 *      NSFW profile bytes: an 18+ profile hollows to a stub-shaped view
 *      (isNsfw stays true as the discriminator, content emptied), and a SFW
 *      profile's nsfw-flagged portraits are absent (not censored).
 *   2. Adults, legacy accounts (null birthdate), and anonymous callers get
 *      byte-identical payloads to before the age feature.
 *   3. Minors cannot FLAG content 18+ on any write route (profile-level
 *      isNsfw on both PUTs, per-portrait nsfw on create/patch), while the
 *      editor's echo of an already-true flag still saves (mod-marked case).
 *   4. The journal by-id route inherits the 18+ profile gate.
 *   5. Regression: member-spotlight discovery keeps excluding NSFW
 *      identities for everyone.
 */

/** ISO date (UTC, date-only) exactly `years` years before now. */
function isoYearsAgo(years: number): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

const MINOR_DOB = isoYearsAgo(15);
const ADULT_DOB = isoYearsAgo(30);

/** The only io surface these routes reach is fetchSockets (chat-color rebroadcast). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockIo: any = { fetchSockets: async () => [] };

/** Real characters + journal routes with the production ZodError→400 mapping. */
async function buildProfileApp(db: Db): Promise<FastifyInstance> {
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      reply.code(400);
      return reply.send({ error: "validation" });
    }
    throw err;
  });
  await registerCharacterRoutes(app, db, mockIo);
  await registerJournalRoutes(app, db);
  await app.ready();
  return app;
}

async function setBirthdate(db: Db, userId: string, birthdate: string | null): Promise<void> {
  await db.update(users).set({ birthdate }).where(eq(users.id, userId));
}

async function makeNsfwMaster(db: Db): Promise<{ id: string; username: string }> {
  const owner = await createUser(db);
  await db
    .update(users)
    .set({
      isNsfw: true,
      isPublic: false,
      bioHtml: "<p>explicit bio</p>",
      avatarUrl: "https://img.example/avatar.png",
      publicProfileBgUrl: "https://img.example/backdrop.png",
    })
    .where(eq(users.id, owner.id));
  await db.insert(userPortraits).values({
    id: nanoid(),
    userId: owner.id,
    url: "https://img.example/explicit-portrait.png",
    sortOrder: 0,
    nsfw: true,
  });
  return owner;
}

async function makeCharacter(
  db: Db,
  ownerId: string,
  opts: { isNsfw?: boolean; name?: string } = {},
): Promise<{ id: string; name: string }> {
  const id = nanoid();
  const name = opts.name ?? `char_${id.slice(0, 8)}`;
  await db.insert(characters).values({
    id,
    userId: ownerId,
    name,
    bioHtml: "<p>char bio</p>",
    ...(opts.isNsfw ? { isNsfw: true, isPublic: false } : {}),
  });
  return { id, name };
}

describe("phase 1: profile resolver withholding for minors", () => {
  let db: Db;
  let raw: ReturnType<typeof makeTestDb>["raw"];

  before(() => { ({ db, raw } = makeTestDb()); });
  after(() => { raw.close(); });

  test("18+ master profile hollows to a stub view for a minor viewer", async () => {
    const owner = await makeNsfwMaster(db);
    const minor = await createUser(db);
    await setBirthdate(db, minor.id, MINOR_DOB);

    const view = await lookupProfile(db, owner.username, minor.id);
    assert.ok(view, "profile still resolves (stub, not 404)");
    assert.equal(view.kind, "master");
    if (view.kind !== "master") return;
    assert.equal(view.profile.isNsfw, true, "isNsfw survives as the discriminator");
    assert.equal(view.profile.username, owner.username, "name survives for the stub UI");
    assert.equal(view.profile.bioHtml, "", "bio withheld");
    assert.equal(view.profile.avatarUrl, null, "avatar withheld");
    assert.deepEqual(view.profile.portraits, [], "portrait URLs withheld");
    assert.deepEqual(view.profile.links, [], "links withheld");
    assert.equal(view.profile.publicProfileBgUrl, null, "backdrop URL withheld");
    assert.equal(view.profile.profileBannerUrl, null, "banner URL withheld");
  });

  test("the same 18+ profile is untouched for adult, legacy, and anonymous viewers", async () => {
    const owner = await makeNsfwMaster(db);
    const adult = await createUser(db);
    await setBirthdate(db, adult.id, ADULT_DOB);
    const legacy = await createUser(db); // birthdate stays NULL = attested adult

    for (const viewerId of [adult.id, legacy.id, undefined]) {
      const view = await lookupProfile(db, owner.username, viewerId);
      assert.ok(view);
      if (view.kind !== "master") { assert.fail("expected master view"); }
      assert.equal(view.profile.bioHtml, "<p>explicit bio</p>");
      assert.equal(view.profile.portraits.length, 1);
      assert.equal(view.profile.avatarUrl, "https://img.example/avatar.png");
    }
  });

  test("SFW master profile: nsfw-flagged portraits are absent for a minor, present for an adult", async () => {
    const owner = await createUser(db);
    await db.insert(userPortraits).values([
      { id: nanoid(), userId: owner.id, url: "https://img.example/safe.png", sortOrder: 0, nsfw: false },
      { id: nanoid(), userId: owner.id, url: "https://img.example/spicy.png", sortOrder: 1, nsfw: true },
    ]);
    const minor = await createUser(db);
    await setBirthdate(db, minor.id, MINOR_DOB);
    const adult = await createUser(db);
    await setBirthdate(db, adult.id, ADULT_DOB);

    const minorView = await lookupProfile(db, owner.username, minor.id);
    assert.ok(minorView && minorView.kind === "master");
    assert.deepEqual(
      minorView.profile.portraits.map((p) => p.url),
      ["https://img.example/safe.png"],
      "only the safe tile, no censored placeholder",
    );
    // The rest of the SFW profile is NOT hollowed.
    assert.equal(minorView.profile.username, owner.username);

    const adultView = await lookupProfile(db, owner.username, adult.id);
    assert.ok(adultView && adultView.kind === "master");
    assert.equal(adultView.profile.portraits.length, 2);
  });

  test("18+ character profile hollows for a minor (token path), full for an adult", async () => {
    const owner = await createUser(db);
    const c = await makeCharacter(db, owner.id, { isNsfw: true });
    await db.insert(characterPortraits).values({
      id: nanoid(), characterId: c.id, url: "https://img.example/c1.png", sortOrder: 0, nsfw: false,
    });
    await db.insert(characterJournalEntries).values({
      id: nanoid(), characterId: c.id, bodyHtml: "<p>diary</p>", privacy: "public",
    });
    const minor = await createUser(db);
    await setBirthdate(db, minor.id, MINOR_DOB);
    const adult = await createUser(db);
    await setBirthdate(db, adult.id, ADULT_DOB);

    // `@cid:` token exercises the token-shortcut resolver branch; the gate
    // sits above both branches in lookupProfile so both inherit it.
    const minorView = await lookupProfile(db, `@cid:${c.id}`, minor.id);
    assert.ok(minorView && minorView.kind === "character");
    assert.equal(minorView.profile.isNsfw, true);
    assert.equal(minorView.profile.name, c.name);
    assert.equal(minorView.profile.bioHtml, "");
    assert.deepEqual(minorView.profile.portraits, []);
    assert.deepEqual(minorView.profile.journalEntries, []);
    assert.deepEqual(minorView.profile.stats, {});

    const adultView = await lookupProfile(db, `@cid:${c.id}`, adult.id);
    assert.ok(adultView && adultView.kind === "character");
    assert.equal(adultView.profile.bioHtml, "<p>char bio</p>");
    assert.equal(adultView.profile.portraits.length, 1);
    assert.equal(adultView.profile.journalEntries.length, 1);
  });

  test("SFW character profile strips only nsfw portraits for a minor (name path)", async () => {
    const owner = await createUser(db);
    const c = await makeCharacter(db, owner.id);
    await db.insert(characterPortraits).values([
      { id: nanoid(), characterId: c.id, url: "https://img.example/ok.png", sortOrder: 0, nsfw: false },
      { id: nanoid(), characterId: c.id, url: "https://img.example/no.png", sortOrder: 1, nsfw: true },
    ]);
    const minor = await createUser(db);
    await setBirthdate(db, minor.id, MINOR_DOB);

    const view = await lookupProfile(db, c.name, minor.id);
    assert.ok(view && view.kind === "character");
    assert.deepEqual(view.profile.portraits.map((p) => p.url), ["https://img.example/ok.png"]);
    assert.equal(view.profile.bioHtml, "<p>char bio</p>", "SFW content untouched");
  });

  test("a minor owner's own 18+ profile hollows too (no owner bypass; editor routes stay open)", async () => {
    // A mod can mark a minor's profile NSFW; the minor then loses the VIEW
    // (content was misplaced) but keeps editing via /me/* routes, which
    // don't go through lookupProfile.
    const owner = await makeNsfwMaster(db);
    await setBirthdate(db, owner.id, MINOR_DOB);
    const view = await lookupProfile(db, owner.username, owner.id);
    assert.ok(view && view.kind === "master");
    assert.equal(view.profile.bioHtml, "");
    assert.deepEqual(view.profile.portraits, []);
  });
});

describe("phase 1: minor NSFW write rejections", () => {
  let db: Db;
  let raw: ReturnType<typeof makeTestDb>["raw"];
  let app: FastifyInstance;

  before(async () => {
    ({ db, raw } = makeTestDb());
    app = await buildProfileApp(db);
  });
  after(async () => {
    await app.close();
    raw.close();
  });

  async function minorWithToken(): Promise<{ id: string; tok: string }> {
    const u = await createUser(db);
    await setBirthdate(db, u.id, MINOR_DOB);
    return { id: u.id, tok: await tokenFor(db, u.id) };
  }
  async function adultWithToken(): Promise<{ id: string; tok: string }> {
    const u = await createUser(db);
    await setBirthdate(db, u.id, ADULT_DOB);
    return { id: u.id, tok: await tokenFor(db, u.id) };
  }
  function put(tok: string, url: string, payload: object) {
    return app.inject({ method: "PUT", url, headers: { ...auth(tok), "content-type": "application/json" }, payload });
  }
  function post(tok: string, url: string, payload: object) {
    return app.inject({ method: "POST", url, headers: { ...auth(tok), "content-type": "application/json" }, payload });
  }
  function patch(tok: string, url: string, payload: object) {
    return app.inject({ method: "PATCH", url, headers: { ...auth(tok), "content-type": "application/json" }, payload });
  }

  test("PUT /me/profile: minor cannot flip isNsfw on; adult can; minor clearing is fine", async () => {
    const minor = await minorWithToken();
    const flip = await put(minor.tok, "/me/profile", { isNsfw: true });
    assert.equal(flip.statusCode, 400);
    assert.match(JSON.parse(flip.payload).error, /18 or older/);

    const clear = await put(minor.tok, "/me/profile", { isNsfw: false });
    assert.equal(clear.statusCode, 200);

    const adult = await adultWithToken();
    const ok = await put(adult.tok, "/me/profile", { isNsfw: true });
    assert.equal(ok.statusCode, 200);
    const row = (await db.select().from(users).where(eq(users.id, adult.id)).limit(1))[0]!;
    assert.equal(row.isNsfw, true);
    assert.equal(row.isPublic, false, "NSFW still forces non-public");
  });

  test("PUT /me/profile: a minor whose profile a mod marked 18+ can still save (true→true echo)", async () => {
    const minor = await minorWithToken();
    await db.update(users).set({ isNsfw: true, isPublic: false }).where(eq(users.id, minor.id));
    // The editor always echoes the current flag back beside other edits.
    const res = await put(minor.tok, "/me/profile", { isNsfw: true, gender: "undisclosed" });
    assert.equal(res.statusCode, 200);
  });

  test("PUT /characters/:id: minor cannot flip isNsfw on; echo of a mod-marked flag saves", async () => {
    const minor = await minorWithToken();
    const c = await makeCharacter(db, minor.id);
    const flip = await put(minor.tok, `/characters/${c.id}`, { isNsfw: true });
    assert.equal(flip.statusCode, 400);
    assert.match(JSON.parse(flip.payload).error, /18 or older/);

    await db.update(characters).set({ isNsfw: true, isPublic: false }).where(eq(characters.id, c.id));
    const echo = await put(minor.tok, `/characters/${c.id}`, { isNsfw: true, bioHtml: "<p>hi</p>" });
    assert.equal(echo.statusCode, 200);

    const adult = await adultWithToken();
    const c2 = await makeCharacter(db, adult.id);
    const ok = await put(adult.tok, `/characters/${c2.id}`, { isNsfw: true });
    assert.equal(ok.statusCode, 200);
  });

  test("portrait create: minor cannot flag nsfw at create, plain create still works", async () => {
    const minor = await minorWithToken();
    const bad = await post(minor.tok, "/me/portraits", { url: "https://img.example/a.png", nsfw: true });
    assert.equal(bad.statusCode, 400);
    assert.match(JSON.parse(bad.payload).error, /18 or older/);
    const ok = await post(minor.tok, "/me/portraits", { url: "https://img.example/a.png" });
    assert.equal(ok.statusCode, 201);

    const c = await makeCharacter(db, minor.id);
    const badChar = await post(minor.tok, `/characters/${c.id}/portraits`, { url: "https://img.example/b.png", nsfw: true });
    assert.equal(badChar.statusCode, 400);
    const okChar = await post(minor.tok, `/characters/${c.id}/portraits`, { url: "https://img.example/b.png" });
    assert.equal(okChar.statusCode, 201);
  });

  test("portrait patch: minor cannot flip nsfw on; label edit echoing a mod-set flag saves", async () => {
    const minor = await minorWithToken();
    const pid = nanoid();
    await db.insert(userPortraits).values({ id: pid, userId: minor.id, url: "https://img.example/x.png", sortOrder: 0 });
    const flip = await patch(minor.tok, `/me/portraits/${pid}`, { nsfw: true });
    assert.equal(flip.statusCode, 400);

    await db.update(userPortraits).set({ nsfw: true }).where(eq(userPortraits.id, pid));
    const echo = await patch(minor.tok, `/me/portraits/${pid}`, { nsfw: true, label: "renamed" });
    assert.equal(echo.statusCode, 200);

    const c = await makeCharacter(db, minor.id);
    const cpid = nanoid();
    await db.insert(characterPortraits).values({ id: cpid, characterId: c.id, url: "https://img.example/y.png", sortOrder: 0 });
    const flipChar = await patch(minor.tok, `/characters/${c.id}/portraits/${cpid}`, { nsfw: true });
    assert.equal(flipChar.statusCode, 400);

    const adult = await adultWithToken();
    const apid = nanoid();
    await db.insert(userPortraits).values({ id: apid, userId: adult.id, url: "https://img.example/z.png", sortOrder: 0 });
    const ok = await patch(adult.tok, `/me/portraits/${apid}`, { nsfw: true });
    assert.equal(ok.statusCode, 200);
  });

  test("journal by-id inherits the 18+ profile gate: 404 for minor non-owner, open for adult + owner", async () => {
    const adultOwner = await adultWithToken();
    const c = await makeCharacter(db, adultOwner.id, { isNsfw: true });
    await db.insert(characterJournalEntries).values({
      id: nanoid(), characterId: c.id, bodyHtml: "<p>secret diary</p>", privacy: "public",
    });

    const minor = await minorWithToken();
    const blocked = await app.inject({ method: "GET", url: `/characters/${c.id}/journal`, headers: auth(minor.tok) });
    assert.equal(blocked.statusCode, 404, "keep-but-hide: same shape as a missing character");

    const adult = await adultWithToken();
    const open = await app.inject({ method: "GET", url: `/characters/${c.id}/journal`, headers: auth(adult.tok) });
    assert.equal(open.statusCode, 200);

    // A minor OWNER keeps editor access to their own journal even if a mod
    // marked the character 18+ (this route is the editor's data source).
    const minorOwner = await minorWithToken();
    const oc = await makeCharacter(db, minorOwner.id, { isNsfw: true });
    const own = await app.inject({ method: "GET", url: `/characters/${oc.id}/journal`, headers: auth(minorOwner.tok) });
    assert.equal(own.statusCode, 200);
  });
});

describe("phase 1: discovery regression (spotlight keeps excluding NSFW for everyone)", () => {
  let db: Db;
  let raw: ReturnType<typeof makeTestDb>["raw"];
  let app: FastifyInstance;

  before(async () => {
    ({ db, raw } = makeTestDb());
    app = await buildUsersApp(db);
  });
  after(async () => {
    await app.close();
    raw.close();
  });

  test("member spotlight never returns an NSFW master or character", async () => {
    const viewer = await createUser(db);
    const tok = await tokenFor(db, viewer.id);

    const nsfwUser = await makeNsfwMaster(db);
    const owner = await createUser(db);
    await makeCharacter(db, owner.id); // SFW character so the character scope has a legal pick
    const nsfwChar = await makeCharacter(db, owner.id, { isNsfw: true });

    for (const scope of ["user", "character"] as const) {
      for (const pick of ["latest", "random"] as const) {
        const res = await app.inject({
          method: "GET",
          url: `/members/spotlight?scope=${scope}&pick=${pick}`,
          headers: auth(tok),
        });
        assert.equal(res.statusCode, 200);
        const member = JSON.parse(res.payload).member as { token: string } | null;
        assert.ok(member, "spotlight found someone (SFW rows exist)");
        assert.notEqual(member.token, nsfwUser.username);
        assert.notEqual(member.token, `@cid:${nsfwChar.id}`);
      }
    }
  });
});
