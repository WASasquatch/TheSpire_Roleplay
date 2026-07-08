/**
 * Coarse geo resolution for analytics.
 *
 * PRIVACY CONTRACT: the raw client IP is used ONLY to derive a coarse country
 * (in-memory) and is then discarded — it NEVER lands in the analytics tables.
 * `resolveGeo` returns an ISO country code (region when the data set carries
 * one) and the caller persists only that. The `flyRegion` edge-PoP tag from the
 * request header is a separate WEAK fallback (the Fly datacenter the request
 * landed on), NOT the visitor's actual country.
 *
 * DATA SOURCE: `geoip-lite` bundles a MaxMind GeoLite2 snapshot inside the npm
 * package, so lookups work with no license key and no network — the data is
 * baked into the Docker image at `pnpm install` time (the Dockerfile copies the
 * whole workspace, node_modules included), which survives Fly's ephemeral FS.
 * The snapshot is country-accurate; it drifts slowly, refreshed by bumping the
 * package (its `updatedb` script needs a free MaxMind key, but *using* the
 * bundled data does not). Region/city are usually blank in the bundled set, so
 * `region` stays null until a City data set is in use.
 *
 * OPTIONAL UPGRADE: when an admin supplies MaxMind credentials, `geoDb` loads a
 * downloaded `GeoLite2-City.mmdb` from the persistent `/data` volume and this
 * function prefers it (country + region) — falling back to the bundled snapshot
 * automatically. See geoDb.ts. No caller changes are needed either way.
 */
import geoip from "geoip-lite";
import { lookupCity } from "./geoDb.js";

export interface GeoResult {
  /** ISO 3166-1 alpha-2 country code, or null when unresolved. */
  country: string | null;
  /** Sub-region (needs a GeoLite2-City DB); null until then. */
  region: string | null;
}

/**
 * Resolve a coarse country/region from the raw client IP. The IP is consumed
 * here and MUST be discarded by the caller afterwards. `flyRegion` is accepted
 * so a caller could fall back to it, but it is NOT the visitor's country and is
 * stored separately.
 *
 * Returns `{ country: null, region: null }` when the IP is absent, private, or
 * not in the data set (e.g. loopback / LAN addresses in local dev).
 */
export function resolveGeo(
  ip: string | null | undefined,
  _flyRegion: string | null | undefined,
): GeoResult {
  if (!ip) return { country: null, region: null };
  try {
    // Prefer the optional MaxMind City reader when an admin has configured it;
    // fall back to the bundled geoip-lite snapshot when it's absent or has no
    // country for this IP.
    const city = lookupCity(ip);
    if (city && city.country) return city;

    const hit = geoip.lookup(ip);
    if (!hit) return { country: null, region: null };
    // MaxMind country codes are ISO 3166-1 alpha-2. Guard defensively so a
    // malformed value can't smuggle a non-code string into a stored row.
    const country =
      typeof hit.country === "string" && hit.country.length === 2
        ? hit.country.toUpperCase()
        : null;
    const region =
      typeof hit.region === "string" && hit.region.trim()
        ? hit.region.trim()
        : null;
    return { country, region };
  } catch {
    // A bad address or an unexpected reader error must never break ingestion.
    return { country: null, region: null };
  }
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
