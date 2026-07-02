/**
 * Affiliates v2 — "Roleplay Communities" web data layer.
 *
 * Thin fetch wrappers over the `/affiliates`, `/me/affiliates`, and
 * `/admin/affiliates` endpoints (see `apps/server/src/routes/affiliates.ts`),
 * plus the two link helpers the card + portal render with:
 *   - `outUrl(id)`    — the card's href; the server 302s it to the partner's
 *     target while counting an outbound hit.
 *   - `linkBackUrl(hash)` — the absolute `/a/<hash>` the partner pastes on their
 *     own site; hitting it counts an inbound hit and 302s back to us.
 *
 * Authed calls pass `credentials: "include"` (session cookie); the public card
 * list is anonymous-safe. Re-exports the shared affiliate types so consumers
 * import shapes + fetchers from one place.
 */
import type {
  AdminAffiliate,
  AffiliateSubmitInput,
  MyAffiliate,
  PublicAffiliatesResult,
} from "@thekeep/shared";
import { affiliateLinkBackUrl } from "@thekeep/shared";

// Re-export the shared contract so callers can `import { PublicAffiliateCard,
// fetchPublicAffiliates } from "../lib/affiliates.js"` without a second import.
export type {
  AdminAffiliate,
  AffiliateClickDirection,
  AffiliateKind,
  AffiliateStatus,
  AffiliateSubmitInput,
  LegacyAffiliateBadge,
  MyAffiliate,
  PublicAffiliateCard,
  PublicAffiliatesResult,
} from "@thekeep/shared";
export { AFFILIATE_LIMITS, isValidAffiliateUrl } from "@thekeep/shared";

/** Pull `{ error }` out of a non-OK response, falling back to the status. */
async function jsonOrThrow<T>(r: Response): Promise<T> {
  const j = (await r.json().catch(() => null)) as ({ error?: string } & T) | null;
  if (!r.ok) throw new Error(j?.error ?? `Request failed (${r.status}).`);
  return j as T;
}

/* ---------- public ---------- */

/**
 * GET /affiliates — approved `card` rows + enabled legacy raw-html badges for the
 * Roleplay Communities section. Anonymous-safe. Swallows transport failures into
 * an empty result so the section renders its empty/CTA state rather than an error
 * on a cold start.
 */
export async function fetchPublicAffiliates(): Promise<PublicAffiliatesResult> {
  try {
    const r = await fetch("/affiliates", { credentials: "include" });
    if (!r.ok) return { cards: [], legacy: [] };
    const j = (await r.json()) as {
      affiliates?: PublicAffiliatesResult["cards"];
      legacy?: PublicAffiliatesResult["legacy"];
    };
    return { cards: j.affiliates ?? [], legacy: j.legacy ?? [] };
  } catch {
    return { cards: [], legacy: [] };
  }
}

/* ---------- self-service (logged-in member owns the entry) ---------- */

/** POST /affiliates/submit — create a card (lands as `pending`). Throws with the
 *  server's message on a limit / validation failure so the form can surface it. */
export async function submitAffiliate(input: AffiliateSubmitInput): Promise<MyAffiliate> {
  const r = await fetch("/affiliates/submit", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return jsonOrThrow<MyAffiliate>(r);
}

/** GET /me/affiliates — the viewer's own entries, newest first (+ link-back once
 *  approved). Throws on transport/permission failure. */
export async function fetchMyAffiliates(): Promise<MyAffiliate[]> {
  const r = await fetch("/me/affiliates", { credentials: "include" });
  const j = await jsonOrThrow<{ affiliates: MyAffiliate[] }>(r);
  return j.affiliates;
}

/** PATCH /me/affiliates/:id — owner edit. Editing an approved card re-opens
 *  review (server flips it back to `pending`). */
export async function updateMyAffiliate(
  id: string,
  patch: Partial<AffiliateSubmitInput>,
): Promise<MyAffiliate> {
  const r = await fetch(`/me/affiliates/${encodeURIComponent(id)}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  return jsonOrThrow<MyAffiliate>(r);
}

/** DELETE /me/affiliates/:id — owner withdraw. */
export async function withdrawMyAffiliate(id: string): Promise<void> {
  const r = await fetch(`/me/affiliates/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });
  await jsonOrThrow<{ ok: true }>(r);
}

/* ---------- admin (view_admin_affiliates read / manage_affiliates write) ---------- */

/** GET /admin/affiliates — ALL rows (pending + legacy html), owner name joined,
 *  pending first. */
export async function fetchAdminAffiliates(): Promise<AdminAffiliate[]> {
  const r = await fetch("/admin/affiliates", { credentials: "include" });
  const j = await jsonOrThrow<{ affiliates: AdminAffiliate[] }>(r);
  return j.affiliates;
}

/** PATCH /admin/affiliates/:id — any field, incl. review state / visibility /
 *  sort order. Approve = `{ status: "approved" }`, reject = `{ status:
 *  "rejected", reviewNote }`. */
export async function adminUpdateAffiliate(
  id: string,
  patch: Record<string, unknown>,
): Promise<AdminAffiliate> {
  const r = await fetch(`/admin/affiliates/${encodeURIComponent(id)}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  return jsonOrThrow<AdminAffiliate>(r);
}

/** POST /admin/affiliates — admin-authored card (auto-approved) OR a legacy
 *  raw-html row (`{ kind: "html", label, html }`). */
export async function adminCreateAffiliate(
  body: Record<string, unknown>,
): Promise<AdminAffiliate> {
  const r = await fetch("/admin/affiliates", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return jsonOrThrow<AdminAffiliate>(r);
}

/** DELETE /admin/affiliates/:id — delete (cascades the click log). */
export async function adminDeleteAffiliate(id: string): Promise<void> {
  const r = await fetch(`/admin/affiliates/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });
  await jsonOrThrow<{ ok: true }>(r);
}

/* ---------- link helpers ---------- */

/**
 * The card's href. Root-relative so it hits our outbound redirect route on the
 * same origin; the server counts an `out` click and 302s to the partner's
 * target. Rendered on an `<a target="_blank" rel="noopener noreferrer
 * sponsored">`.
 */
export function outUrl(id: string): string {
  return `/affiliates/out/${encodeURIComponent(id)}`;
}

/**
 * The absolute link-back a partner pastes on their own site (`/a/<hash>`). Built
 * from the current page origin so it resolves whichever host the member is on
 * (the same origin the server would report). Mirrors the server's
 * `affiliateLinkBackUrl`.
 */
export function linkBackUrl(hash: string): string {
  return affiliateLinkBackUrl(window.location.origin, hash);
}
