/**
 * OPTIONAL MaxMind GeoLite2-City database manager (accuracy upgrade over the
 * bundled `geoip-lite` snapshot used by resolveGeo).
 *
 * When an admin supplies MaxMind credentials (account ID + license key), this
 * module downloads `GeoLite2-City.mmdb` to the PERSISTENT `/data` volume — NOT
 * the ephemeral app image — so it survives restarts and is fetched at most once
 * per refresh window rather than every boot. `resolveGeo` prefers this reader
 * (country + region + city) when it is loaded, and silently falls back to the
 * bundled geoip-lite snapshot otherwise.
 *
 * PRIVACY: unchanged from resolveGeo — the IP is looked up in-memory here and
 * only the coarse country/region is ever returned to the caller for storage.
 *
 * EULA: the GeoLite2 license requires the DB be no more than 30 days stale; the
 * refresh window below re-downloads well inside that. Nothing is downloaded
 * unless credentials are configured.
 */
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import maxmind, { type CityResponse, type Reader } from "maxmind";

/** Re-download when the on-disk DB is older than this (well under the 30d EULA cap). */
const REFRESH_MS = 25 * 24 * 60 * 60 * 1000; // 25 days
/** How often the background timer re-checks staleness. */
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours
const DOWNLOAD_TIMEOUT_MS = 60_000;
const EDITION = "GeoLite2-City";
const DOWNLOAD_URL = `https://download.maxmind.com/geoip/databases/${EDITION}/download?suffix=tar.gz`;

export interface GeoCredentials {
  accountId: string;
  licenseKey: string;
}

export interface GeoDbStatus {
  /** Whether admin credentials are configured (regardless of load success). */
  configured: boolean;
  /** Whether a City reader is currently loaded and serving lookups. */
  loaded: boolean;
  /** Epoch ms the on-disk DB file was last modified, or null. */
  dbMtimeMs: number | null;
  /** Last successful download epoch ms, or null. */
  lastDownloadMs: number | null;
  /** Last error message from a download/open attempt, or null. */
  lastError: string | null;
}

let dataDir: string | null = null;
let creds: GeoCredentials | null = null;
let reader: Reader<CityResponse> | null = null;
let lastDownloadMs: number | null = null;
let lastError: string | null = null;
let refreshInFlight: Promise<void> | null = null;
let timer: NodeJS.Timeout | null = null;

function dbPath(): string | null {
  return dataDir ? path.join(dataDir, "geoip", `${EDITION}.mmdb`) : null;
}

/**
 * Extract the single `*.mmdb` member from a MaxMind `.tar.gz` buffer. The
 * archive is a standard ustar tar (one dated directory holding the .mmdb plus
 * license/readme files); entry paths are short so no GNU long-name handling is
 * needed. Returns the DB bytes, or null if no .mmdb entry is present.
 */
export function extractMmdbFromTarGz(gz: Buffer): Buffer | null {
  const tar = gunzipSync(gz);
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    // A pair of all-zero blocks marks end-of-archive.
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeField = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = parseInt(sizeField, 8) || 0;
    const dataStart = offset + 512;
    if (name.endsWith(".mmdb")) {
      return Buffer.from(tar.subarray(dataStart, dataStart + size));
    }
    // Advance past this entry's data, rounded up to the next 512-byte block.
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

async function downloadDb(): Promise<void> {
  const target = dbPath();
  if (!target || !creds) return;
  const auth = Buffer.from(`${creds.accountId}:${creds.licenseKey}`).toString("base64");
  const res = await fetch(DOWNLOAD_URL, {
    headers: { authorization: `Basic ${auth}` },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) {
    // 401 = bad credentials; surface a compact, non-secret-leaking message.
    throw new Error(`MaxMind download failed (${res.status} ${res.statusText}).`);
  }
  const gz = Buffer.from(await res.arrayBuffer());
  const mmdb = extractMmdbFromTarGz(gz);
  if (!mmdb || mmdb.length < 1024) {
    throw new Error("MaxMind archive contained no usable .mmdb.");
  }
  mkdirSync(path.dirname(target), { recursive: true });
  // Write to a temp file then rename so a crash mid-write can't leave a
  // truncated DB that the reader would choke on at next boot.
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, mmdb);
  // Validate the freshly written DB opens before swapping it in.
  const next = await maxmind.open<CityResponse>(tmp);
  renameSync(tmp, target);
  reader = next;
  lastDownloadMs = statSync(target).mtimeMs;
  lastError = null;
}

function dbMtimeMs(): number | null {
  const p = dbPath();
  return p && existsSync(p) ? statSync(p).mtimeMs : null;
}

function isStale(): boolean {
  const mtime = dbMtimeMs();
  if (mtime === null) return true;
  return Date.now() - mtime > REFRESH_MS;
}

/**
 * Ensure the reader reflects current credentials + freshness. Opens an existing
 * on-disk DB immediately (fast, offline) and downloads a fresh copy only when
 * missing or stale. Never throws — failures are recorded in status and the
 * caller keeps using the bundled geoip-lite fallback.
 */
async function refresh(): Promise<void> {
  if (!creds) {
    reader = null;
    return;
  }
  try {
    const p = dbPath();
    // Open whatever is already on disk first so lookups work before any network.
    if (!reader && p && existsSync(p)) {
      reader = await maxmind.open<CityResponse>(p);
    }
    if (isStale()) {
      await downloadDb();
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }
}

/** Coalesce concurrent refreshes into one in-flight promise. */
function kickRefresh(): Promise<void> {
  if (!refreshInFlight) refreshInFlight = refresh().finally(() => (refreshInFlight = null));
  return refreshInFlight;
}

/**
 * Set the persistent data directory once at boot (sibling of the SQLite DB) and
 * apply any stored credentials. Safe to call once per process start.
 */
export function initGeoDb(dir: string, initialCreds: GeoCredentials | null): Promise<void> {
  dataDir = dir;
  return applyGeoCredentials(initialCreds);
}

/**
 * Apply credentials (or clear them when either field is blank) and kick off a
 * refresh. Returns the refresh promise so a caller (e.g. the admin save
 * endpoint) can await the first download and report success/failure. Safe to
 * call whenever an admin saves the settings.
 */
export function applyGeoCredentials(next: GeoCredentials | null): Promise<void> {
  if (!next || !next.accountId.trim() || !next.licenseKey.trim()) {
    creds = null;
    reader = null;
    lastError = null;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    return Promise.resolve();
  }
  creds = { accountId: next.accountId.trim(), licenseKey: next.licenseKey.trim() };
  if (!timer) {
    timer = setInterval(() => void kickRefresh(), CHECK_INTERVAL_MS);
    // Don't hold the process open for the timer alone.
    timer.unref?.();
  }
  return kickRefresh();
}

/**
 * Synchronous coarse lookup via the City reader, or null when no reader is
 * loaded (caller then falls back to geoip-lite). Returns only coarse fields;
 * the IP is not retained.
 */
export function lookupCity(ip: string): { country: string | null; region: string | null } | null {
  if (!reader) return null;
  const hit = reader.get(ip);
  if (!hit) return { country: null, region: null };
  const country =
    typeof hit.country?.iso_code === "string" && hit.country.iso_code.length === 2
      ? hit.country.iso_code.toUpperCase()
      : null;
  const sub = hit.subdivisions?.[0]?.iso_code;
  const region = typeof sub === "string" && sub.trim() ? sub.trim() : null;
  return { country, region };
}

export function geoDbStatus(): GeoDbStatus {
  return {
    configured: creds !== null,
    loaded: reader !== null,
    dbMtimeMs: dbMtimeMs(),
    lastDownloadMs,
    lastError,
  };
}
