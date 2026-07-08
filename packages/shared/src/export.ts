/**
 * Chat-export helpers, shared by the `/export` command (which parses the
 * user's duration + builds the download hint) and the `GET /rooms/:id/export`
 * route (which re-derives the window defensively from the same rules). Keeping
 * the parse + clamp logic here means the command's friendly "clamped to X"
 * notice and the route's actual query window can never disagree.
 *
 * An export is a download of the room's recent messages as a formatted HTML
 * log. The requested window is always clamped to (a) how long messages are
 * actually retained — you can't export what's already been swept — and (b) a
 * hard ceiling so a single request can't try to serialize an unbounded history.
 */

import { formatDurationCompact } from "./duration.js";

/** Hard ceiling on the export window regardless of retention (30 days). Keeps
 *  any one request bounded even when retention is "infinite" (global 0). */
export const MAX_EXPORT_MS = 30 * 24 * 60 * 60 * 1000;

/** Window used when `/export` is run with no duration argument (12 hours). */
export const DEFAULT_EXPORT_MS = 12 * 60 * 60 * 1000;

/** Upper bound on rows serialized into one export. The route takes the most
 *  recent N within the window; anything older is dropped (and flagged in the
 *  document header) so the query + string build stay cheap and non-blocking. */
export const EXPORT_MAX_MESSAGES = 5000;

const MS = { d: 86_400_000, h: 3_600_000, m: 60_000 } as const;

/**
 * Parse a human duration like `5h`, `90m`, `2d`, `1d6h`, or a bare number
 * (treated as hours). Returns milliseconds, or null if nothing usable parsed
 * or the total is zero. Case/whitespace insensitive; combined units sum.
 */
export function parseExportDuration(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  // Bare number → hours (e.g. `/export 5` == `/export 5h`).
  if (/^\d+$/.test(s)) {
    const h = parseInt(s, 10);
    return h > 0 ? h * MS.h : null;
  }
  // One-or-more <number><unit> chunks. Longest unit spellings first so e.g.
  // "min" matches as minutes rather than "m" + leftover "in".
  const re = /(\d+)\s*(days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m)/g;
  let total = 0;
  let matched = false;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(s)) !== null) {
    matched = true;
    const n = parseInt(mm[1]!, 10);
    const unit = mm[2]![0]; // d | h | m
    total += n * (unit === "d" ? MS.d : unit === "h" ? MS.h : MS.m);
  }
  return matched && total > 0 ? total : null;
}

/**
 * Effective retention window for a room in ms: the per-room expiry override if
 * set, else the global retention, else `Infinity` (kept indefinitely). The
 * per-room override wins because the sweep applies it regardless of the global
 * value.
 */
export function effectiveRetentionMs(
  globalRetentionMs: number,
  roomExpiryMinutes: number | null | undefined,
): number {
  if (roomExpiryMinutes != null && roomExpiryMinutes > 0) return roomExpiryMinutes * MS.m;
  if (globalRetentionMs > 0) return globalRetentionMs;
  return Infinity;
}

/**
 * Clamp a requested export window to what's actually exportable: never longer
 * than retention (you can't export swept messages) and never past the hard
 * {@link MAX_EXPORT_MS} ceiling. Always returns a positive, finite ms value.
 */
export function clampExportMs(
  requestedMs: number,
  globalRetentionMs: number,
  roomExpiryMinutes: number | null | undefined,
): number {
  const retention = effectiveRetentionMs(globalRetentionMs, roomExpiryMinutes);
  return Math.max(MS.m, Math.min(requestedMs, retention, MAX_EXPORT_MS));
}

/* ============================================================
 *  Tamper-evident manifest
 *
 *  An export carries a signed MANIFEST so a downloaded log can be
 *  proven authentic against the server (not obfuscated — obfuscation
 *  buys nothing; anyone can decode + re-encode). The server signs the
 *  CANONICAL message DATA (ids, bodies, timestamps), never the rendered
 *  HTML — so a theme/timezone difference never invalidates a log, and
 *  cosmetic edits to the visible markup are simply ignored by the
 *  verifier (which re-renders from the signed payload).
 *
 *  Symmetric HMAC: only the server can mint OR verify a signature, which
 *  is exactly the dispute model (staff adjudicate). The verifier
 *  recomputes the HMAC with the server key and cross-checks the content
 *  hash against the receipt row recorded at export time.
 * ============================================================ */

/** Bump when the payload shape or canonicalization changes so an older
 *  verifier refuses a newer manifest rather than mis-validating it. */
export const EXPORT_MANIFEST_VERSION = 1;

/** The signing algorithm label baked into the manifest (informational;
 *  the server only accepts this one). */
export const EXPORT_SIGN_ALGO = "HMAC-SHA256" as const;

/** One signed message row — the stable DB snapshot, NOT the rendered
 *  line. `id` is the canonical `messages.id` so a single reported post
 *  can be located within the wider signed context. */
export interface ExportPayloadMessage {
  id: string;
  kind: string;
  displayName: string;
  body: string;
  color: string | null;
  createdAt: number;
  toDisplayName: string | null;
  moodSnapshot: string | null;
  npcVoicedBy: string | null;
}

/** The exact object that gets signed. Everything a verifier needs to
 *  re-render the log AND to confirm who/when/what was exported. */
export interface ExportPayload {
  version: number;
  receiptId: string;
  roomId: string;
  roomName: string;
  exportedByUserId: string;
  exportedByUsername: string;
  generatedAtMs: number;
  windowMs: number;
  rangeStartMs: number;
  rangeEndMs: number;
  messageCount: number;
  truncated: boolean;
  messages: ExportPayloadMessage[];
}

/** The full manifest embedded (as inert JSON) in the export document and
 *  submitted to the verifier. `signature` covers {@link ExportPayload}
 *  only. */
export interface ExportManifest {
  version: number;
  receiptId: string;
  algo: typeof EXPORT_SIGN_ALGO;
  signature: string;
  payload: ExportPayload;
}

/** The DOM id of the inert `<script type="application/json">` block that
 *  carries the manifest in an exported document. Shared so the builder
 *  writes it and the verifier extracts it under the same name. */
export const EXPORT_MANIFEST_DOM_ID = "thekeep-export-manifest";

/**
 * Deterministic serialization of a value with object keys sorted
 * recursively, so the signed/hashed byte string never depends on key
 * insertion order (the verifier parses the manifest back out of the
 * file, where order isn't guaranteed). Arrays keep their order — message
 * order is meaningful. Only the JSON types the payload uses are handled.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJsonStringify(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const body = keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJsonStringify(obj[k])}`)
    .join(",");
  return `{${body}}`;
}

/** The canonical byte string for a payload — the input to both the HMAC
 *  signature and the content hash. */
export function canonicalizeExportPayload(payload: ExportPayload): string {
  return canonicalJsonStringify(payload);
}

/**
 * Pull the manifest out of an exported HTML document's inert JSON block.
 * Tolerant by design — staff paste whatever file they were handed. Returns
 * null if the block is missing or unparseable (the verifier reports that
 * as "no manifest found / not a TheKeep export"). Does NOT validate the
 * signature — that's the server's job with the secret key.
 */
export function extractExportManifest(html: string): ExportManifest | null {
  // Match the inert JSON script block by its id, in either attribute order.
  const re = new RegExp(
    `<script[^>]*id=["']${EXPORT_MANIFEST_DOM_ID}["'][^>]*>([\\s\\S]*?)<\\/script>`,
    "i",
  );
  const m = re.exec(html);
  const raw = m ? m[1] : html; // also accept a bare pasted manifest JSON
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw.trim());
    if (
      parsed && typeof parsed === "object" &&
      typeof parsed.signature === "string" &&
      parsed.payload && typeof parsed.payload === "object" &&
      Array.isArray(parsed.payload.messages)
    ) {
      return parsed as ExportManifest;
    }
  } catch {
    /* not JSON / not a manifest */
  }
  return null;
}

/** Compact human label for a ms window, e.g. `2d 3h`, `5h`, `45m`. Used in the
 *  clamp notice and the export document header. Space-joined, every non-zero
 *  d/h/m unit, no seconds, no negative guard (callers clamp the window). */
export function formatDurationShort(ms: number): string {
  return formatDurationCompact(ms, { separator: " ", zeroLabel: "0m" });
}
