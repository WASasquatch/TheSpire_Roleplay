/**
 * Same-origin image proxy, shared by every surface that has to draw a remote
 * image onto a canvas.
 *
 * The browser will happily RENDER a cross-origin image, but the canvas it
 * lands on is then TAINTED: `toDataURL` / `toBlob` throw a SecurityError.
 * That kills Overlook's PNG export and it kills the world-to-PDF export,
 * which rasterizes the whole magazine through html2canvas. Serving the bytes
 * from our own origin is what keeps both working, and it buys a content-type
 * allowlist (no SVG: a script-capable document) and an SSRF guard on the way.
 *
 * `useCORS` is NOT an alternative here. It makes the browser send an
 * anonymous request, so a host without `Access-Control-Allow-Origin` simply
 * fails to load and the image renders as a blank hole. Most of the art in a
 * world is hotlinked from wherever the author found it, so that failure mode
 * would be the common case, not the edge.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { FastifyReply } from "fastify";
import { OVERLOOK_PROXY_MAX_BYTES, OVERLOOK_PROXY_MIME_ALLOWLIST } from "@thekeep/shared";

/**
 * Refuse to resolve a hostname that lands on a private, loopback,
 * link-local, or otherwise internal address. Without this the image proxy is
 * an SSRF primitive: any user could make the server fetch its own admin API,
 * the Fly metadata endpoint, or anything else on the private network, and
 * read the bytes back through the canvas.
 */
export function isBlockedAddress(addr: string): boolean {
  const v = isIP(addr);
  if (v === 4) {
    const p = addr.split(".").map((n) => Number.parseInt(n, 10));
    const [a = 0, b = 0] = p;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (v === 6) {
    const lower = addr.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fe80")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
    // IPv4-mapped (::ffff:10.0.0.1): re-check the embedded v4 address.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped?.[1]) return isBlockedAddress(mapped[1]);
    return false;
  }
  return true;
}

/**
 * Fetch `rawUrl` and stream it back from our origin, or set an error status
 * and return an error body. Callers own authentication and any feature gate;
 * this function owns the network side only.
 *
 * Redirects are chased ONE HOP AT A TIME on purpose. `redirect: "follow"`
 * would be an SSRF hole: we would validate the first hostname and then let
 * undici quietly follow a 302 to 169.254.169.254. `redirect: "error"` closes
 * that hole but breaks most real image hosts, which redirect as a matter of
 * course (CDN edges, signed-URL handoffs, shortlinks). So: manual, re-running
 * the protocol and address checks on every new URL.
 */
export async function serveProxiedImage(
  reply: FastifyReply,
  rawUrl: string,
): Promise<{ error: string } | undefined> {
  let target: URL;
  try {
    target = new URL(rawUrl.trim());
  } catch {
    reply.code(400);
    return { error: "bad url" };
  }

  const MAX_HOPS = 4;
  let upstream: Response | null = null;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    // https only: an http hop is a mixed-content downgrade and also the
    // easy path to an internal service.
    if (target.protocol !== "https:") { reply.code(400); return { error: "https only" }; }

    // Resolve the hostname ourselves and vet every address it maps to. A
    // hostname that resolves to 127.0.0.1 is the classic bypass, so
    // checking the literal string is not enough.
    let addresses: string[];
    try {
      addresses = (await dnsLookup(target.hostname, { all: true })).map((r) => r.address);
    } catch {
      reply.code(502);
      return { error: "unreachable" };
    }
    if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
      reply.code(403);
      return { error: "blocked host" };
    }

    let res: Response;
    try {
      res = await fetch(target.toString(), {
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
        headers: { accept: OVERLOOK_PROXY_MIME_ALLOWLIST.join(",") },
      });
    } catch {
      reply.code(502);
      return { error: "fetch failed" };
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) { reply.code(502); return { error: "fetch failed" }; }
      try {
        // Resolved against the current URL so a relative Location works.
        target = new URL(location, target);
      } catch {
        reply.code(502);
        return { error: "fetch failed" };
      }
      continue; // re-vet the new target at the top of the loop
    }
    upstream = res;
    break;
  }
  if (!upstream) { reply.code(502); return { error: "too many redirects" }; }
  if (!upstream.ok || !upstream.body) { reply.code(502); return { error: "fetch failed" }; }

  const mime = (upstream.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!(OVERLOOK_PROXY_MIME_ALLOWLIST as readonly string[]).includes(mime)) {
    reply.code(415);
    return { error: "unsupported image type" };
  }
  const declared = Number.parseInt(upstream.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > OVERLOOK_PROXY_MAX_BYTES) {
    reply.code(413);
    return { error: "image too large" };
  }
  const buf = Buffer.from(await upstream.arrayBuffer());
  // Re-check after reading: content-length is a hint, not a promise.
  if (buf.byteLength > OVERLOOK_PROXY_MAX_BYTES) { reply.code(413); return { error: "image too large" }; }

  reply.header("content-type", mime);
  // Content-addressed by URL and immutable for a day. Long enough that
  // panning a busy canvas doesn't re-fetch, short enough that a replaced
  // image at a stable URL shows up the same day.
  reply.header("cache-control", "private, max-age=86400");
  // Belt and braces: these bytes are attacker-influenced, so make sure a
  // browser never interprets them as anything but an image.
  reply.header("x-content-type-options", "nosniff");
  reply.header("content-security-policy", "default-src 'none'; sandbox");
  await reply.send(buf);
  return undefined;
}
