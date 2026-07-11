/**
 * Link unfurling (OpenGraph previews) for chat + forum messages.
 *
 * Fire-and-forget from `addMessage`: extract the body's FIRST http(s)
 * link, fetch it SAFELY, parse OpenGraph/Twitter/title metadata, store
 * the card on the message row, and broadcast a `message:update` so the
 * card pops in under the message (Discord-style). The author can remove
 * the card (DELETE /messages/:id/link-preview) — that writes a
 * {"hidden":true} tombstone so a re-unfurl never resurrects it.
 *
 * SSRF posture (user-supplied URLs reach this fetcher):
 *   - http/https only; default ports semantics left to fetch
 *   - DNS-resolve every hop and refuse private / loopback / link-local
 *     / unique-local ranges (IPv4 + IPv6), plus localhost and raw
 *     private IP literals
 *   - redirects followed MANUALLY (≤ 3), each hop re-validated
 *   - 5s timeout, response body capped at 512KB, text/html only
 *   - results (including failures) cached 24h per URL so a popular
 *     link is fetched once, not once per message
 */
import { lookup } from "node:dns/promises";
import { eq, sql } from "drizzle-orm";
import type { Server as IoServer } from "socket.io";
import type { ClientToServerEvents, LinkPreview, ServerToClientEvents } from "@thekeep/shared";
import type { Db } from "./db/index.js";
import { messages, ogUnfurlCache } from "./db/schema.js";
import { fetchWithTimeout } from "./lib/fetchWithTimeout.js";

type Io = IoServer<ClientToServerEvents, ServerToClientEvents>;

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 512 * 1024;
const MAX_REDIRECTS = 3;
const USER_AGENT = "Mozilla/5.0 (compatible; SpireLinkPreview/1.0; +https://thespire)";

/** Kinds whose bodies get unfurled. */
const UNFURLABLE_KINDS = new Set(["say", "me", "ooc"]);

const URL_RX = /https?:\/\/[^\s<>"')\]]+/i;

export function extractFirstUrl(body: string): string | null {
  // Skip quoted lines so re-quoting someone's link doesn't re-unfurl it
  // on every reply down the chain.
  const ownLines = body.split("\n").filter((l) => !l.trimStart().startsWith(">")).join("\n");
  const m = URL_RX.exec(ownLines);
  if (!m) return null;
  // Trim common trailing punctuation that rides along in prose.
  return m[0].replace(/[.,;:!?]+$/, "");
}

function isPrivateIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p as [number, number, number, number];
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) || // CGNAT
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast + reserved
  );
}

function isPrivateIPv6(ip: string): boolean {
  const low = ip.toLowerCase();
  return (
    low === "::" || low === "::1" ||
    low.startsWith("fe80") || // link-local
    low.startsWith("fc") || low.startsWith("fd") || // unique-local
    low.startsWith("::ffff:") // v4-mapped — re-check the v4 part
      ? low.startsWith("::ffff:") ? isPrivateIPv4(low.slice(7)) : true
      : false
  );
}

/** Resolve the hostname and refuse anything that lands in private space. */
async function isSafeHost(hostname: string): Promise<boolean> {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  // Raw IP literals skip DNS.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return !isPrivateIPv4(host);
  if (host.includes(":")) return !isPrivateIPv6(host.replace(/^\[|\]$/g, ""));
  try {
    const addrs = await lookup(host, { all: true, verbatim: true });
    if (addrs.length === 0) return false;
    return addrs.every((a) => (a.family === 4 ? !isPrivateIPv4(a.address) : !isPrivateIPv6(a.address)));
  } catch {
    return false;
  }
}

/** Fetch with manual redirects, per-hop validation, timeout, size cap.
 *  Returns the HTML text or null. */
async function fetchHtml(startUrl: string): Promise<string | null> {
  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let u: URL;
    try { u = new URL(current); } catch { return null; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!(await isSafeHost(u.hostname))) return null;

    try {
      const res = await fetchWithTimeout(current, {
        redirect: "manual",
        headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
      }, FETCH_TIMEOUT_MS);
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return null;
        current = new URL(loc, current).toString();
        continue;
      }
      if (!res.ok) return null;
      const ctype = res.headers.get("content-type") ?? "";
      if (!/text\/html|application\/xhtml/i.test(ctype)) return null;
      // Stream with a hard byte cap — og tags live in <head>, so even
      // truncated HTML parses fine.
      const reader = res.body?.getReader();
      if (!reader) return null;
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          chunks.push(value);
          if (total >= MAX_BODY_BYTES) { void reader.cancel().catch(() => {}); break; }
        }
      }
      const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      return buf.toString("utf8");
    } catch {
      return null;
    }
  }
  return null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)));
}

/** Pull a meta tag's content by property/name, tolerant of attribute order. */
function metaContent(html: string, key: string): string | undefined {
  const rx = new RegExp(
    `<meta[^>]+(?:property|name)=["']${key.replace(/[:.]/g, "\\$&")}["'][^>]*>`,
    "i",
  );
  const tag = rx.exec(html)?.[0];
  if (!tag) return undefined;
  const content = /content=["']([^"']*)["']/i.exec(tag)?.[1];
  return content ? decodeEntities(content).trim() : undefined;
}

function parseOg(html: string, finalUrl: string): LinkPreview | null {
  const head = html.slice(0, 200_000);
  const title = metaContent(head, "og:title")
    ?? metaContent(head, "twitter:title")
    ?? (() => {
      const t = /<title[^>]*>([^<]*)<\/title>/i.exec(head)?.[1];
      return t ? decodeEntities(t).trim() : undefined;
    })();
  const description = metaContent(head, "og:description")
    ?? metaContent(head, "twitter:description")
    ?? metaContent(head, "description");
  let imageUrl = metaContent(head, "og:image")
    ?? metaContent(head, "og:image:url")
    ?? metaContent(head, "twitter:image");
  const siteName = metaContent(head, "og:site_name");
  if (imageUrl) {
    try {
      const abs = new URL(imageUrl, finalUrl);
      imageUrl = abs.protocol === "http:" || abs.protocol === "https:" ? abs.toString() : undefined;
    } catch { imageUrl = undefined; }
  }
  if (!title && !description && !imageUrl) return null;
  return {
    url: finalUrl,
    ...(title ? { title: title.slice(0, 200) } : {}),
    ...(description ? { description: description.slice(0, 300) } : {}),
    ...(imageUrl ? { imageUrl: imageUrl.slice(0, 1000) } : {}),
    ...(siteName ? { siteName: siteName.slice(0, 100) } : {}),
  };
}

/** Cache-aware unfurl of one URL. Returns null when nothing previewable. */
async function unfurlUrl(db: Db, url: string): Promise<LinkPreview | null> {
  const cached = (await db.select().from(ogUnfurlCache).where(eq(ogUnfurlCache.url, url)).limit(1))[0];
  if (cached && +cached.fetchedAt > Date.now() - CACHE_TTL_MS) {
    try {
      const j = JSON.parse(cached.json) as LinkPreview | Record<string, never>;
      return "url" in j ? (j as LinkPreview) : null;
    } catch { return null; }
  }
  const html = await fetchHtml(url);
  const preview = html ? parseOg(html, url) : null;
  await db.insert(ogUnfurlCache)
    .values({ url, json: preview ? JSON.stringify(preview) : "{}", fetchedAt: new Date() })
    .onConflictDoUpdate({
      target: ogUnfurlCache.url,
      set: { json: preview ? JSON.stringify(preview) : "{}", fetchedAt: new Date() },
    });
  return preview;
}

/** Parse a stored link_preview_json into a wire LinkPreview (hidden /
 *  malformed → undefined). Shared by every row→ChatMessage mapper. */
export function linkPreviewFromRow(json: string | null | undefined): LinkPreview | undefined {
  if (!json) return undefined;
  try {
    const j = JSON.parse(json) as { hidden?: boolean; url?: string } & LinkPreview;
    if (j.hidden || !j.url) return undefined;
    return j;
  } catch {
    return undefined;
  }
}

/**
 * The fire-and-forget job: unfurl `body`'s first link and attach the
 * card to the message, then broadcast the refreshed row. No-ops when
 * the message vanished, was deleted, or already carries a card or
 * tombstone (author removed it before we finished).
 */
export async function unfurlAndAttach(db: Db, io: Io, args: {
  messageId: string;
  roomId: string;
  kind: string;
  body: string;
}): Promise<void> {
  if (!UNFURLABLE_KINDS.has(args.kind)) return;
  const url = extractFirstUrl(args.body);
  if (!url) return;
  const preview = await unfurlUrl(db, url);
  if (!preview) return;
  // Attach only when the slot is still empty — guards both the author's
  // early removal and double-processing.
  const updated = await db.run(sql`
    UPDATE messages SET link_preview_json = ${JSON.stringify(preview)}
    WHERE id = ${args.messageId} AND link_preview_json IS NULL AND deleted_at IS NULL`);
  if (Number(updated.changes ?? 0) === 0) return;
  const row = (await db.select().from(messages).where(eq(messages.id, args.messageId)).limit(1))[0];
  if (!row) return;
  // Viewer-aware broadcast: an 18+-stamped row's card+body must not reach
  // minor occupants of a flipped-back room (see emitMessageUpdate).
  const { emitMessageUpdate } = await import("./routes/messages.js");
  await emitMessageUpdate(io, db, row);
}
