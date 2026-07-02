/**
 * Coarse geo resolution for analytics (plan_ext.md §2c, §7).
 *
 * PRIVACY CONTRACT: the raw client IP is used ONLY to derive a coarse country
 * (in-memory) and is then discarded — it NEVER lands in the analytics tables.
 * Today `resolveGeo` returns `{ country: null, region: null }` for every input;
 * the `flyRegion` edge-PoP tag from the request header is the only geo signal we
 * currently persist, and it is a WEAK fallback (the Fly datacenter the request
 * landed on), not the visitor's actual country.
 *
 * TODO (GeoLite2 hook): to turn on real country/region resolution, bake a
 * MaxMind `GeoLite2-Country.mmdb` (or City for region) into the Docker image at
 * build time (needs a MaxMind license: MAXMIND_ACCOUNT_ID + MAXMIND_LICENSE_KEY
 * build secrets — the DB is NOT downloaded at runtime, Fly's FS is ephemeral),
 * add the `maxmind` npm reader, `maxmind.open(<path>)` once at boot into a
 * module-level reader, and have `resolveGeo` look the IP up + map to the ISO
 * country code (region once the City DB is in use). Everything downstream
 * already stores only the coarse code and discards the IP, so no other change
 * is needed. A scheduled CI job must re-bake the DB every ≤30 days per the
 * GeoLite2 EULA. Until that is wired, this stub keeps `geo_country` nullable.
 */

export interface GeoResult {
  /** ISO 3166-1 alpha-2 country code, or null when unresolved. */
  country: string | null;
  /** Sub-region (needs a GeoLite2-City DB); null until then. */
  region: string | null;
}

/**
 * Resolve a coarse country/region from the raw client IP. The IP is consumed
 * here and MUST be discarded by the caller afterwards. `flyRegion` is accepted
 * so a future implementation could fall back to it, but it is NOT the visitor's
 * country and is stored separately.
 *
 * Returns `{ country: null, region: null }` for now (see the TODO above).
 */
export function resolveGeo(
  _ip: string | null | undefined,
  _flyRegion: string | null | undefined,
): GeoResult {
  // GeoLite2 lookup goes here once the .mmdb reader is plugged in.
  return { country: null, region: null };
}

/**
 * Read Fly's edge-PoP region code from the request headers (e.g. "iad", "lhr").
 * This is the datacenter that terminated the request, a weak proxy for "near
 * the visitor" — stored as `fly_region`, never treated as the country. Returns
 * null when absent (local dev, non-Fly hosts) or malformed.
 */
export function readFlyRegion(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const raw = headers["fly-region"];
  const val = Array.isArray(raw) ? raw[0] : raw;
  if (typeof val !== "string") return null;
  const trimmed = val.trim().toLowerCase();
  // Fly region codes are short 3-letter PoP identifiers; cap defensively so a
  // spoofed header on a non-Fly deploy can't smuggle a large string into a row.
  if (!trimmed || trimmed.length > 8) return null;
  return trimmed;
}
