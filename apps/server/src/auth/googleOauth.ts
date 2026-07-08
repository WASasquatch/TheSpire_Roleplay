/**
 * Google OAuth (sign-in) plumbing for /auth/google.
 *
 * Env-gated the same way as the mailer (process.env.KEY + exported
 * `configured` boolean): when the client id/secret are unset,
 * `googleConfigured` is false and the sign-in-with-Google button never
 * lights up. The feature team fills the stub bodies below (consent URL
 * builder + code→identity exchange) against this fixed contract.
 *
 * Config (via env / Fly secrets):
 *   GOOGLE_CLIENT_ID     - OAuth 2.0 Web client id
 *   GOOGLE_CLIENT_SECRET - OAuth 2.0 Web client secret
 *   GOOGLE_REDIRECT_URI  - optional explicit callback URL; when unset it is
 *                          derived per-request as
 *                          `${proto}://${host}/auth/google/callback`
 *                          (honoring CANONICAL_HOST when set)
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { fetchWithTimeout } from "../lib/fetchWithTimeout.js";

const clientId = process.env.GOOGLE_CLIENT_ID ?? "";
const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "";

/** True once both the client id and secret are present. */
export const googleConfigured = !!clientId && !!clientSecret;

/** Exported for the feature team to build the token-exchange request. */
export { clientId, clientSecret };

/**
 * Resolve the OAuth redirect (callback) URI for this request.
 *
 * Prefers an explicit `GOOGLE_REDIRECT_URI` (so an operator can pin it to the
 * exact value registered in the Google Cloud console). Otherwise derives
 * `${proto}://${host}/auth/google/callback` from the request, honoring
 * `x-forwarded-proto` / `x-forwarded-host` behind Fly's proxy, and swapping in
 * `CANONICAL_HOST` (https) when that env is set so a *.fly.dev hit still yields
 * the canonical-domain callback that's registered with Google.
 */
export function googleRedirectUri(req: FastifyRequest): string {
  const explicit = (process.env.GOOGLE_REDIRECT_URI ?? "").trim();
  if (explicit) return explicit;

  const canonicalHost = (process.env.CANONICAL_HOST ?? "").trim().toLowerCase();
  if (canonicalHost) return `https://${canonicalHost}/auth/google/callback`;

  const proto = (
    (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim()
    || req.protocol
    || "https"
  ).toLowerCase();
  const host = (
    (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim()
    || (req.headers.host as string | undefined)
    || ""
  );
  return `${proto}://${host}/auth/google/callback`;
}

/** Only these three scopes are ever requested — no Drive/Contacts/etc. */
const SCOPE = "openid email profile";

/**
 * Build the Google consent-screen URL to redirect the user to.
 *
 * `access_type=online` (we don't want a refresh token — a single identity
 * read per sign-in is all we need) and `prompt=select_account` so a user with
 * several Google accounts is always offered the chooser instead of being
 * silently signed in as whoever Google last used.
 */
export function buildConsentUrl(state: string, redirectUri: string): string {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    state,
    access_type: "online",
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q.toString()}`;
}

/** Outbound-fetch guard, modeled on unfurl.ts fetchHtml: AbortController
 *  timeout, never throw, null on any failure. */
const EXCHANGE_TIMEOUT_MS = 8_000;

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetchWithTimeout(url, init, EXCHANGE_TIMEOUT_MS);
    if (!res.ok) return null;
    const j = (await res.json()) as unknown;
    return j && typeof j === "object" ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Exchange an authorization `code` for the signed-in identity, or null on
 * failure. Two hops, both guarded (never throw):
 *   1. POST the token endpoint (form-encoded) → access_token
 *   2. GET the userinfo endpoint (Bearer) → { sub, email, email_verified, name }
 *
 * We read the identity off the userinfo endpoint rather than decoding the
 * id_token JWT locally: the userinfo response is fetched over TLS directly from
 * Google using the freshly-minted access token, so its `sub` is authoritative
 * without us having to verify a signature ourselves.
 */
export async function exchangeCodeForIdentity(
  code: string,
  redirectUri: string,
): Promise<{ sub: string; email: string; emailVerified: boolean; name: string | null } | null> {
  const form = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const token = await fetchJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const accessToken = typeof token?.access_token === "string" ? token.access_token : "";
  if (!accessToken) return null;

  const info = await fetchJson("https://www.googleapis.com/oauth2/v3/userinfo", {
    method: "GET",
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const sub = typeof info?.sub === "string" ? info.sub : "";
  const email = typeof info?.email === "string" ? info.email : "";
  if (!sub || !email) return null;
  // Google reports email_verified as a boolean or the string "true".
  const ev = info?.email_verified;
  const emailVerified = ev === true || ev === "true";
  const name = typeof info?.name === "string" && info.name.trim() ? info.name : null;
  return { sub, email, emailVerified, name };
}

/**
 * CSRF + tamper protection for the OAuth `state` round-trip.
 *
 * `state` is opaque to Google and echoed back verbatim on the callback, so an
 * attacker who can make a victim's browser hit our callback with an
 * attacker-chosen code could otherwise link/sign-in the victim into the
 * attacker's Google account (or vice-versa). We therefore mint `state` as a
 * signed, short-lived envelope: `<base64url(payload)>.<base64url(hmac)>` where
 * the MAC is HMAC-SHA256 over the payload keyed by SESSION_SECRET. On the
 * callback we recompute the MAC (constant-time compare) and reject anything
 * with a bad signature or an `iat` older than STATE_TTL_MS. The `nonce` keeps
 * two concurrent flows from producing identical strings; `uid` (link mode)
 * binds the flow to the initiating session so a signed link-state can't be
 * replayed against a different account.
 */
export interface OauthStatePayload {
  mode: "login" | "link";
  nonce: string;
  uid?: string;
  iat: number;
}

/** ~10 minutes: long enough to complete a consent screen, short enough that a
 *  leaked state URL is quickly useless. */
const STATE_TTL_MS = 10 * 60 * 1000;

function stateSecret(): string {
  // Same secret the session layer is keyed on. index.ts already refuses to
  // boot when this is unset / <32 chars, so it's always present here.
  return process.env.SESSION_SECRET ?? "";
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** Sign a state payload into `<payload>.<mac>`. Callers pass {mode, uid?}; we
 *  stamp the nonce + iat. */
export function signState(input: { mode: "login" | "link"; uid?: string }): { state: string; nonce: string } {
  const nonce = randomBytes(9).toString("base64url");
  const payload: OauthStatePayload = {
    mode: input.mode,
    nonce,
    ...(input.uid ? { uid: input.uid } : {}),
    iat: Date.now(),
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const mac = b64url(createHmac("sha256", stateSecret()).update(body).digest());
  // The caller drops `nonce` into a browser cookie the callback must echo back,
  // binding the flow to the initiating browser (CSRF / session-fixation guard) —
  // the signed state alone can't do that.
  return { state: `${body}.${mac}`, nonce };
}

/**
 * Verify + decode a state string. Returns the payload on success, or null when
 * the string is malformed, the MAC doesn't match, or it's older than the TTL.
 * Never throws.
 */
export function verifyState(str: string): OauthStatePayload | null {
  if (typeof str !== "string" || !str.includes(".")) return null;
  const dot = str.indexOf(".");
  const body = str.slice(0, dot);
  const mac = str.slice(dot + 1);
  if (!body || !mac) return null;
  const expected = b64url(createHmac("sha256", stateSecret()).update(body).digest());
  // Constant-time compare; bail if lengths differ (timingSafeEqual throws on
  // unequal-length buffers).
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: OauthStatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as OauthStatePayload;
  } catch {
    return null;
  }
  if (payload?.mode !== "login" && payload?.mode !== "link") return null;
  if (typeof payload.iat !== "number" || Date.now() - payload.iat > STATE_TTL_MS) return null;
  return payload;
}
