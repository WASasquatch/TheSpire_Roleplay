import "./helpers/env.js";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { nanoid } from "nanoid";
import { desc, eq, sql } from "drizzle-orm";
import type { ChatMessage, Role } from "@thekeep/shared";
import {
  RICH_HTML_MAX_BYTES,
  composerDocNeedsRichFormat,
  composerDocToRichHtml,
  htmlClipboardToComposerDoc,
  mapRichHtmlTextNodes,
  normalizeComposerDoc,
  richHtmlLinkHrefs,
  richHtmlToText,
  serializeComposerDoc,
} from "@thekeep/shared";
import * as schema from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import type { SessionUser } from "../src/commands/types.js";
import { sanitizeRichMessageHtml } from "../src/lib/richHtml.js";
import { dispatchChatInput } from "../src/realtime/dispatch.js";
import { CommandRegistry } from "../src/commands/registry.js";
import { registerBuiltins } from "../src/commands/builtins/index.js";
import { registerMessageRoutes } from "../src/routes/messages.js";
import { registerRoomsRoutes } from "../src/routes/rooms.js";
import { messageForSocket } from "../src/realtime/broadcast.js";
import { applyFilters, getCompiledRuleset, invalidateAutomodCache } from "../src/realtime/automod.js";
import { getSettings, updateSettings } from "../src/settings.js";
import { buildChatLogHtml, type ExportMessageRow } from "../src/export/chatLog.js";
import { auth, createUser, makeTestDb, tokenFor } from "./helpers/harness.js";

/**
 * Rich-HTML chat message format (messages.format = 'html', migration
 * 0352): the ingest sanitizer's whitelist, the plaintext-mirror text
 * utilities, the ComposerDoc → rich-HTML wire serializer, the dispatch
 * ingest chokepoint (sanitize + caps + mention parity + command
 * identity), the deploy-window per-socket downgrade, the edit
 * round-trip, body_text-backed search, automod-on-visible-text, and
 * the HTML export — with the md pipeline byte-identical throughout.
 */

/* ── sanitizer unit coverage ── */

describe("sanitizeRichMessageHtml whitelist", () => {
  test("XSS suite: scripts / embeds / handlers / hostile schemes are gone", () => {
    const cases: Array<[string, string]> = [
      ["<p>hi<script>alert(1)</script></p>", "<p>hi</p>"],
      ["<p>x<iframe src='https://e'>y</iframe></p>", "<p>x</p>"],
      ['<p><img src=x onerror=alert(1)>text</p>', "<p>text</p>"],
      ["<svg onload=alert(1)><circle/></svg><p>ok</p>", "<p>ok</p>"],
      ["<style>p{background:url(x)}</style><p>ok</p>", "<p>ok</p>"],
      ['<p onclick="alert(1)">click</p>', "<p>click</p>"],
      ['<p><a href="javascript:alert(1)">x</a></p>', '<p><a rel="noopener noreferrer ugc" target="_blank">x</a></p>'],
      ['<p><a href="data:text/html,x">x</a></p>', '<p><a rel="noopener noreferrer ugc" target="_blank">x</a></p>'],
    ];
    for (const [input, expected] of cases) {
      assert.equal(sanitizeRichMessageHtml(input), expected, input);
    }
  });

  test("http(s) links keep href with forced rel/target", () => {
    assert.equal(
      sanitizeRichMessageHtml('<p><a href="https://example.com/a?b=1" target="_top" rel="opener">x</a></p>'),
      '<p><a href="https://example.com/a?b=1" rel="noopener noreferrer ugc" target="_blank">x</a></p>',
    );
  });

  test("style values re-emit only validated declarations", () => {
    const cases: Array<[string, string]> = [
      ['<p style="text-align: center">c</p>', '<p style="text-align:center">c</p>'],
      ['<p style="text-align: left">l</p>', "<p>l</p>"],
      ['<p style="text-align: url(x)">u</p>', "<p>u</p>"],
      ['<h2 style="text-align: right; position: fixed">r</h2>', '<h2 style="text-align:right">r</h2>'],
      ['<span style="color: #a1b2c3">c</span>', '<span style="color:#a1b2c3">c</span>'],
      ['<span style="color: rgb(18,52,86)">c</span>', '<span style="color:#123456">c</span>'],
      ['<span style="color: tomato">c</span>', '<span style="color:#ff6347">c</span>'],
      ['<span style="color: expression(alert(1))">c</span>', "<span>c</span>"],
      ['<span style="color: url(http://e)">c</span>', "<span>c</span>"],
      ['<span style="font-size: 1.35em">s</span>', '<span style="font-size:1.35em">s</span>'],
      ['<span style="font-size: 99px">s</span>', "<span>s</span>"],
      ['<span style="font-size: 2em">s</span>', "<span>s</span>"],
      // Alignment only lives on blocks; color/size only on spans.
      ['<span style="text-align: center">x</span>', "<span>x</span>"],
      ['<p style="color: #fff; font-size: 1.35em">x</p>', "<p>x</p>"],
      // background-color / font-family never validate anywhere.
      ['<span style="background-color: #f00; font-family: Wingdings">x</span>', "<span>x</span>"],
    ];
    for (const [input, expected] of cases) {
      assert.equal(sanitizeRichMessageHtml(input), expected, input);
    }
  });

  test("class whitelist: only the literal spoiler token on span survives", () => {
    assert.equal(
      sanitizeRichMessageHtml('<p><span class="spoiler">s</span></p>'),
      '<p><span class="spoiler">s</span></p>',
    );
    assert.equal(
      sanitizeRichMessageHtml('<p><span class="evil spoiler other">s</span></p>'),
      '<p><span class="spoiler">s</span></p>',
    );
    assert.equal(sanitizeRichMessageHtml('<p><span class="evil">s</span></p>'), "<p><span>s</span></p>");
    assert.equal(sanitizeRichMessageHtml('<p class="spoiler">s</p>'), "<p>s</p>");
  });

  test("non-whitelisted structure degrades to its visible text", () => {
    assert.equal(sanitizeRichMessageHtml("<div><h4>t</h4><table><tr><td>cell</td></tr></table></div>"), "tcell");
    assert.equal(sanitizeRichMessageHtml("<p>a<sub>b</sub><video>v</video></p>"), "<p>abv</p>");
  });

  test("whitelisted structure passes through", () => {
    const body =
      '<h1>Title</h1><p style="text-align:center"><strong>b</strong><em>i</em><u>u</u><s>s</s><code>c</code></p>' +
      "<blockquote><p>q</p></blockquote><ul><li>one</li><li>two</li></ul><pre>code</pre>";
    assert.equal(sanitizeRichMessageHtml(body), body);
  });
});

/* ── sanitized-HTML text utilities ── */

describe("rich text utilities", () => {
  test("richHtmlToText derives visible text with block breaks", () => {
    assert.equal(richHtmlToText("<h1>Big</h1><p>hello <em>world</em> &amp; more</p>"), "Big\nhello world & more");
    assert.equal(richHtmlToText("<p>a<br />b</p>"), "a\nb");
    assert.equal(richHtmlToText("<p><br /></p><p>x</p>"), "\n\nx");
    assert.equal(richHtmlToText("<ul><li>one</li><li>two</li></ul>"), "one\ntwo");
  });

  test("mapRichHtmlTextNodes leaves markup byte-identical", () => {
    const html = '<p style="text-align: center">abc <a href="https://e.com/abc">abc</a></p>';
    const out = mapRichHtmlTextNodes(html, (t) => t.toUpperCase());
    assert.equal(out, '<p style="text-align: center">ABC <a href="https://e.com/abc">ABC</a></p>');
  });

  test("richHtmlLinkHrefs extracts http(s) hrefs in order", () => {
    const html = '<p><a href="https://a.com/1">x</a> and <a href="https://b.com/2?q=1&amp;r=2">y</a></p>';
    assert.deepEqual(richHtmlLinkHrefs(html), ["https://a.com/1", "https://b.com/2?q=1&r=2"]);
  });
});

/* ── ComposerDoc → rich HTML serializer + clipboard mapping ── */

describe("composerDocToRichHtml", () => {
  test("headings and alignment flip the doc to the rich format", () => {
    const doc = htmlClipboardToComposerDoc('<h1>Head</h1><p style="text-align:center">mid</p><p>plain</p>');
    assert.ok(composerDocNeedsRichFormat(doc));
    assert.equal(
      composerDocToRichHtml(doc),
      '<h1>Head</h1><p style="text-align:center">mid</p><p>plain</p>',
    );
    // The md projection degrades headings/alignment to plain lines.
    assert.equal(serializeComposerDoc(doc), "Head\nmid\nplain");
  });

  test("plain docs stay markdown-formatted", () => {
    const doc = htmlClipboardToComposerDoc("<p><b>bold</b> and <i>ital</i></p>");
    assert.ok(!composerDocNeedsRichFormat(doc));
    assert.equal(serializeComposerDoc(doc), "**bold** and *ital*");
  });

  test("Gmail-style centering via a wrapping div inherits onto the line", () => {
    const doc = htmlClipboardToComposerDoc('<div style="text-align:center"><p>c</p><p style="text-align:left">l</p></div>');
    assert.ok(composerDocNeedsRichFormat(doc));
    assert.equal(composerDocToRichHtml(doc), '<p style="text-align:center">c</p><p>l</p>');
  });

  test("h4-h6 flatten to h3; align attribute form maps too", () => {
    const doc = htmlClipboardToComposerDoc('<h5>deep</h5><p align="right">r</p>');
    assert.equal(composerDocToRichHtml(doc), '<h3>deep</h3><p style="text-align:right">r</p>');
  });

  test("serializer output is a fixed point of the ingest sanitizer", () => {
    const doc = normalizeComposerDoc(
      htmlClipboardToComposerDoc(
        '<h2 style="text-align:center">T</h2>' +
          '<p><b>b</b> <span style="color:#ff0000;font-size:24pt">loud</span> <a href="https://e.com/x">link</a></p>' +
          "<blockquote><p>q</p></blockquote><ul><li>li</li></ul>",
      ),
    );
    const html = composerDocToRichHtml(doc);
    assert.equal(sanitizeRichMessageHtml(html), html);
  });

  test("spoiler spans serialize with the whitelist class", () => {
    const html = composerDocToRichHtml({
      lines: [{ kind: "text", spans: [{ text: "secret", marks: ["spoiler"] }] }],
    });
    assert.equal(html, '<p><span class="spoiler">secret</span></p>');
    assert.equal(sanitizeRichMessageHtml(html), html);
  });

  test("empty lines keep a visible break", () => {
    const html = composerDocToRichHtml({
      lines: [
        { kind: "text", spans: [{ text: "a" }] },
        { kind: "text", spans: [] },
        { kind: "text", spans: [{ text: "b" }] },
      ],
    });
    assert.equal(html, "<p>a</p><p><br /></p><p>b</p>");
    assert.equal(richHtmlToText(html), "a\n\nb");
  });
});

/* ── dispatch ingest + consumers (integration) ── */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFakeIo(): any {
  return {
    async fetchSockets() { return []; },
    in() { return { async fetchSockets() { return []; }, emit() {} }; },
    to() { return { emit() {} }; },
    emit() {},
  };
}

interface Notice { code: string; message: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFakeSocket(roomId: string): { socket: any; notices: Notice[]; sent: ChatMessage[] } {
  const notices: Notice[] = [];
  const sent: ChatMessage[] = [];
  const socket = {
    rooms: new Set([`room:${roomId}`]),
    data: {},
    emit(event: string, payload: unknown) {
      if (event === "error:notice") notices.push(payload as Notice);
      if (event === "message:new") sent.push(payload as ChatMessage);
    },
  };
  return { socket, notices, sent };
}

function sessionUser(u: { id: string; username: string; role: Role }): SessionUser {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    activeCharacterId: null,
    birthdate: "1990-01-01",
    isAdult: true,
    hideNsfw: false,
    isolateFromAdults: false,
    locale: null,
    displayName: u.username,
    chatColor: null,
    awayMessage: null,
    currentMood: null,
    incognitoMode: false,
    incognitoAlias: null,
    incognitoCharacterId: null,
    incognitoExitMessage: null,
    incognitoReturnMessage: null,
  };
}

let db: Db;
let app: FastifyInstance;
let registry: CommandRegistry;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let io: any;
let alice: { id: string; username: string; role: Role };
let bob: { id: string; username: string; role: Role };
let carol: { id: string; username: string; role: Role };
let roomId: string;

async function dispatch(
  user: { id: string; username: string; role: Role },
  text: string,
  opts?: { format?: "html"; replyToId?: string },
): Promise<{ notices: Notice[]; sent: ChatMessage[] }> {
  const { socket, notices, sent } = makeFakeSocket(roomId);
  await dispatchChatInput({
    io, socket, db, registry,
    user: sessionUser(user),
    roomId, text,
    ...(opts?.format ? { format: opts.format } : {}),
    ...(opts?.replyToId ? { replyToId: opts.replyToId } : {}),
  });
  return { notices, sent };
}

async function lastMessage(): Promise<typeof schema.messages.$inferSelect | undefined> {
  return (
    await db.select().from(schema.messages)
      .where(eq(schema.messages.roomId, roomId))
      .orderBy(desc(sql`rowid`))
      .limit(1)
  )[0];
}

before(async () => {
  db = makeTestDb().db;
  io = makeFakeIo();
  registry = new CommandRegistry();
  registerBuiltins(registry);
  app = Fastify();
  await registerMessageRoutes(app, db, io);
  await registerRoomsRoutes(app, db, io);
  await app.ready();

  alice = { ...(await createUser(db)), role: "user" };
  bob = { ...(await createUser(db)), role: "user" };
  carol = { ...(await createUser(db)), role: "user" };
  roomId = nanoid();
  await db.insert(schema.rooms).values({
    id: roomId, name: "rich-hall", slug: "rich-hall", type: "public", ownerId: alice.id,
  });
});

describe("dispatch ingest (format html)", () => {
  test("rich say persists sanitized body + plaintext mirror and broadcasts format", async () => {
    const { notices } = await dispatch(alice, '<h1 style="text-align:center">Big</h1><p>hello <em>world</em> &amp; more</p>', { format: "html" });
    assert.equal(notices.length, 0);
    const row = (await lastMessage())!;
    assert.equal(row.kind, "say");
    assert.equal(row.format, "html");
    assert.equal(row.body, '<h1 style="text-align:center">Big</h1><p>hello <em>world</em> &amp; more</p>');
    assert.equal(row.bodyText, "Big\nhello world & more");
  });

  test("hostile markup is sanitized at the chokepoint before persisting", async () => {
    await dispatch(bob, '<p>hi<script>alert(1)</script><img src=x onerror=alert(1)></p><p><a href="javascript:alert(1)">x</a></p>', { format: "html" });
    const row = (await lastMessage())!;
    assert.equal(row.format, "html");
    assert.ok(!row.body.includes("<script"), row.body);
    assert.ok(!row.body.includes("<img"), row.body);
    assert.ok(!row.body.toLowerCase().includes("javascript:"), row.body);
    assert.equal(row.bodyText, "hi\nx");
  });

  test("md sends stay byte-identical with a NULL mirror", async () => {
    await dispatch(carol, "**bold** stays <em>literal-ish</em>");
    const row = (await lastMessage())!;
    assert.equal(row.format, "md");
    assert.equal(row.body, "**bold** stays <em>literal-ish</em>");
    assert.equal(row.bodyText, null);
  });

  test("command identity: html bodies are never commands; md commands still run", async () => {
    await dispatch(alice, "<p>/kick bob</p>", { format: "html" });
    const asSay = (await lastMessage())!;
    assert.equal(asSay.kind, "say");
    assert.equal(asSay.format, "html");
    assert.equal(asSay.bodyText, "/kick bob");

    await dispatch(bob, "/me waves");
    const asMe = (await lastMessage())!;
    assert.equal(asMe.kind, "me");
    assert.equal(asMe.format, "md");
    assert.equal(asMe.body, "waves");
  });

  test("/me with the RP leading dash keeps its bytes", async () => {
    await dispatch(carol, "/me - lightning crashes as WAS stands ominously");
    const row = (await lastMessage())!;
    assert.equal(row.kind, "me");
    assert.equal(row.body, "- lightning crashes as WAS stands ominously");
  });

  test("raw-byte ceiling rejects with TOO_LONG and persists nothing", async () => {
    const beforeRow = await lastMessage();
    const { notices } = await dispatch(alice, `<p>${"a".repeat(RICH_HTML_MAX_BYTES)}</p>`, { format: "html" });
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.code, "TOO_LONG");
    assert.equal((await lastMessage())!.id, beforeRow!.id);
  });

  test("visible-character cap runs on the plaintext mirror", async () => {
    const { maxMessageLength, maxForumPostLength } = await getSettings(db);
    const overCap = Math.max(maxMessageLength, maxForumPostLength) + 1;
    assert.ok(overCap + 7 < RICH_HTML_MAX_BYTES, "cap fixture must fit under the byte ceiling");
    const beforeRow = await lastMessage();
    const { notices } = await dispatch(bob, `<p>${"a".repeat(overCap)}</p>`, { format: "html" });
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.code, "TOO_LONG");
    assert.equal((await lastMessage())!.id, beforeRow!.id);
  });

  test("markup with no visible text is a silent no-op", async () => {
    const beforeRow = await lastMessage();
    const { notices } = await dispatch(carol, "<p><em>  </em></p>", { format: "html" });
    assert.equal(notices.length, 0);
    assert.equal((await lastMessage())!.id, beforeRow!.id);
  });

  test("mention tokens resolve inside text nodes and land in the mirror", async () => {
    await dispatch(alice, `<p>hi @id:${bob.id} there</p>`, { format: "html" });
    const row = (await lastMessage())!;
    assert.ok(row.body.includes(`@${bob.username}`), row.body);
    assert.ok(!row.body.includes("@id:"), row.body);
    assert.ok(row.bodyText!.includes(`@${bob.username}`), row.bodyText!);
    assert.ok(row.mentionsJson && row.mentionsJson.includes(bob.id), String(row.mentionsJson));
  });

  test("reply snippets snapshot the parent's visible text, never markup", async () => {
    const parentId = nanoid();
    await db.insert(schema.messages).values({
      id: parentId, roomId, userId: alice.id, characterId: null,
      displayName: alice.username, kind: "say",
      body: "<h2>Parent heading</h2><p>parent tail</p>",
      format: "html", bodyText: "Parent heading\nparent tail",
    });
    // Flat rooms quote-reply via the /reply builtin (the timestamp
    // click prefill), which owns the snippet snapshot.
    await dispatch(bob, `/reply ${parentId} a reply`);
    const row = (await lastMessage())!;
    assert.equal(row.replyToId, parentId);
    // The /reply snippet helper flattens newlines into spaces; the
    // load-bearing assertion is plaintext-not-markup.
    assert.equal(row.replyToBodySnippet, "Parent heading parent tail");
  });
});

describe("automod runs on visible text", () => {
  before(async () => {
    await db.insert(schema.automodRules).values({
      id: nanoid(), kind: "keyword", pattern: "sithspit", action: "delete",
      scope: "both", enabled: true, caseInsensitive: true, wholeWord: false,
    });
    invalidateAutomodCache();
    await updateSettings(db, { automodEnabled: true }, alice.id);
  });

  test("markup-split matches are caught via the plaintext mirror", async () => {
    const beforeRow = await lastMessage();
    const { notices } = await dispatch(alice, "<p>sith<em>spit</em></p>", { format: "html" });
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.code, "BLOCKED");
    assert.equal((await lastMessage())!.id, beforeRow!.id);
  });

  test("editor-generated markup bytes cannot false-positive a rule", async () => {
    await db.insert(schema.automodRules).values({
      id: nanoid(), kind: "keyword", pattern: "center", action: "delete",
      scope: "both", enabled: true, caseInsensitive: true, wholeWord: false,
    });
    invalidateAutomodCache();
    const { notices } = await dispatch(bob, '<p style="text-align: center">a clean aligned line</p>', { format: "html" });
    assert.equal(notices.length, 0);
    const row = (await lastMessage())!;
    assert.equal(row.bodyText, "a clean aligned line");
  });

  test("pure matcher sees the derived visible text", async () => {
    const ruleset = await getCompiledRuleset(db);
    const verdict = applyFilters(richHtmlToText("<p>si<strong>ths</strong>pit</p>"), ruleset, "chat");
    assert.equal(verdict.action, "delete");
  });

  test("cleanup: automod back off", async () => {
    await updateSettings(db, { automodEnabled: false }, alice.id);
    await db.delete(schema.automodRules);
    invalidateAutomodCache();
  });
});

describe("deploy-window per-socket downgrade", () => {
  const richMsg = {
    id: "m1", roomId: "r1", userId: "u1", characterId: null,
    displayName: "who", kind: "say" as const,
    body: "<h1>Big</h1><p>text</p>", format: "html" as const,
    bodyText: "Big\ntext", color: null, createdAt: 1,
  } as unknown as ChatMessage;

  test("a socket without the rich-html capability gets the plaintext mirror", () => {
    const out = messageForSocket(richMsg, {});
    assert.equal(out.body, "Big\ntext");
    assert.equal(out.format, undefined);
    assert.equal(out.bodyText, undefined);
  });

  test("a rich-capable socket receives the shared original object", () => {
    assert.equal(messageForSocket(richMsg, { richHtml: true }), richMsg);
  });

  test("md rows pass through untouched regardless of capability", () => {
    const md = { ...richMsg, format: undefined, bodyText: undefined, body: "**md**" } as ChatMessage;
    assert.equal(messageForSocket(md, {}), md);
  });
});

describe("edit round-trip (PATCH /messages/:id)", () => {
  test("html rows re-sanitize and refresh the mirror", async () => {
    const id = nanoid();
    await db.insert(schema.messages).values({
      id, roomId, userId: alice.id, characterId: null,
      displayName: alice.username, kind: "say",
      body: "<p>original</p>", format: "html", bodyText: "original",
    });
    const token = await tokenFor(db, alice.id);
    const res = await app.inject({
      method: "PATCH",
      url: `/messages/${id}`,
      headers: auth(token),
      payload: { body: '<h2>edited</h2><script>alert(1)</script><p style="color:red">tail</p>' },
    });
    assert.equal(res.statusCode, 200, res.body);
    const row = (await db.select().from(schema.messages).where(eq(schema.messages.id, id)).limit(1))[0]!;
    assert.equal(row.format, "html");
    assert.ok(!row.body.includes("<script"), row.body);
    assert.ok(row.body.includes("<h2>edited</h2>"), row.body);
    // color on <p> is not on the whitelist — the style drops.
    assert.ok(!row.body.includes("color:red"), row.body);
    assert.equal(row.bodyText, "edited\ntail");
  });

  test("html edits over the byte ceiling are refused", async () => {
    const id = nanoid();
    await db.insert(schema.messages).values({
      id, roomId, userId: bob.id, characterId: null,
      displayName: bob.username, kind: "say",
      body: "<p>small</p>", format: "html", bodyText: "small",
    });
    const token = await tokenFor(db, bob.id);
    // Multibyte body: under the zod character cap but over the raw
    // BYTE ceiling — exactly the gap the 413 gate exists for.
    const res = await app.inject({
      method: "PATCH",
      url: `/messages/${id}`,
      headers: auth(token),
      payload: { body: `<p>${"é".repeat(19_000)}</p>` },
    });
    assert.equal(res.statusCode, 413);
    const row = (await db.select().from(schema.messages).where(eq(schema.messages.id, id)).limit(1))[0]!;
    assert.equal(row.body, "<p>small</p>");
  });

  test("md rows keep the historic edit path byte-identically", async () => {
    const id = nanoid();
    await db.insert(schema.messages).values({
      id, roomId, userId: carol.id, characterId: null,
      displayName: carol.username, kind: "say", body: "before",
    });
    const token = await tokenFor(db, carol.id);
    const res = await app.inject({
      method: "PATCH",
      url: `/messages/${id}`,
      headers: auth(token),
      payload: { body: "after **md** [x](https://e.com)" },
    });
    assert.equal(res.statusCode, 200, res.body);
    const row = (await db.select().from(schema.messages).where(eq(schema.messages.id, id)).limit(1))[0]!;
    assert.equal(row.format, "md");
    assert.equal(row.body, "after **md** [x](https://e.com)");
    assert.equal(row.bodyText, null);
  });
});

describe("search matches on the plaintext mirror", () => {
  before(async () => {
    await db.insert(schema.messages).values({
      id: nanoid(), roomId, userId: alice.id, characterId: null,
      displayName: alice.username, kind: "say",
      body: '<p style="text-align: center">quick <em>brown</em> fox</p>',
      format: "html", bodyText: "quick brown fox",
    });
  });

  test("markup-split runs match; snippets are plaintext", async () => {
    const token = await tokenFor(db, alice.id);
    const res = await app.inject({
      method: "GET",
      url: `/rooms/${roomId}/messages/search?q=${encodeURIComponent("brown fox")}`,
      headers: auth(token),
    });
    assert.equal(res.statusCode, 200, res.body);
    const hits = (res.json() as { hits: Array<{ snippet: string }> }).hits;
    assert.ok(hits.length >= 1, res.body);
    assert.ok(hits.some((h) => h.snippet === "quick brown fox"), res.body);
  });

  test("markup bytes cannot fabricate a hit", async () => {
    const token = await tokenFor(db, alice.id);
    const res = await app.inject({
      method: "GET",
      url: `/rooms/${roomId}/messages/search?q=text-align`,
      headers: auth(token),
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal((res.json() as { hits: unknown[] }).hits.length, 0, res.body);
  });
});

describe("HTML export renders both formats", () => {
  function exportRows(rows: ExportMessageRow[]): string {
    return buildChatLogHtml({
      roomName: "test room",
      exportedBy: "tester",
      generatedAtMs: 1_700_000_100_000,
      windowMs: 3_600_000,
      rangeStartMs: 1_700_000_000_000,
      rangeEndMs: 1_700_000_010_000,
      tzMinutes: 0,
      messages: rows,
      truncated: false,
      theme: "dark",
    });
  }

  test("rich rows embed re-sanitized markup; md rows stay escaped text", () => {
    const html = exportRows([
      {
        kind: "say", displayName: "rich", color: null, createdAt: 1_700_000_000_000,
        body: '<h1>Title</h1><p><span class="spoiler">sec</span></p><script>bad()</script>',
        format: "html",
      },
      {
        kind: "say", displayName: "plain", color: null, createdAt: 1_700_000_001_000,
        body: "<script>alert(1)</script> **bold**",
      },
    ]);
    assert.ok(html.includes('<div class="rich"><h1>Title</h1>'), "rich body renders structurally");
    assert.ok(html.includes('<span class="spoiler">sec</span>'), "spoiler survives");
    assert.ok(!html.includes("<script>bad()"), "script stripped from rich body");
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "md body stays escaped literal text");
  });
});
