/**
 * Server-side signing + verification for chat-export manifests.
 *
 * The key is DERIVED from SESSION_SECRET via HKDF with a dedicated label,
 * so the export signature and the session-cookie secret are never the
 * same bytes — leaking/rotating one reasoning doesn't entangle the other,
 * and the derivation is one-way. Symmetric HMAC-SHA256: only this server
 * can produce OR check a signature, which matches the dispute model
 * (staff adjudicate against the server's own records).
 *
 * What gets signed is the CANONICAL payload (ids/bodies/timestamps), never
 * the rendered HTML — see packages/shared/src/export.ts.
 */
import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import {
  canonicalizeExportPayload,
  EXPORT_MANIFEST_VERSION,
  type ExportManifest,
  type ExportPayload,
} from "@thekeep/shared";

/** Lazily-derived, process-lifetime signing subkey. */
let cachedKey: Buffer | null = null;
function signingKey(): Buffer {
  if (cachedKey) return cachedKey;
  const secret = process.env.SESSION_SECRET ?? "";
  // HKDF-SHA256 → a 32-byte subkey. Empty salt is fine (the secret is the
  // entropy source); the `info` label domain-separates this from any other
  // future use of the same secret.
  const derived = hkdfSync(
    "sha256",
    Buffer.from(secret, "utf8"),
    Buffer.alloc(0),
    Buffer.from("thekeep-export-sig-v1", "utf8"),
    32,
  );
  cachedKey = Buffer.from(derived);
  return cachedKey;
}

function hmacHex(canonical: string): string {
  return createHmac("sha256", signingKey()).update(canonical, "utf8").digest("hex");
}

function sha256Hex(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Sign a payload. Returns the hex HMAC and the SHA-256 content hash (the
 * same bytes are hashed and signed). The content hash is what we persist
 * in the receipt row — it lets a submitted file be confirmed even after
 * the underlying messages age out of retention, and it carries no message
 * content (privacy-safe to keep indefinitely).
 */
export function signExportPayload(payload: ExportPayload): {
  signature: string;
  contentHash: string;
} {
  const canonical = canonicalizeExportPayload(payload);
  return { signature: hmacHex(canonical), contentHash: sha256Hex(canonical) };
}

export interface VerifyResult {
  /** True only when the signature matches AND the manifest is well-formed. */
  valid: boolean;
  /** Human-readable reason when `valid` is false. */
  reason?: string;
  /** The recomputed content hash (present whenever the payload parsed),
   *  for cross-checking against the stored receipt row. */
  contentHash?: string;
}

/**
 * Verify a manifest's signature against this server's key. Pure crypto —
 * the caller separately cross-checks the receipt table. Constant-time
 * comparison so a near-miss signature can't be brute-forced byte by byte.
 */
export function verifyExportManifest(manifest: ExportManifest): VerifyResult {
  if (!manifest || typeof manifest !== "object") {
    return { valid: false, reason: "No manifest found in the file." };
  }
  if (manifest.version !== EXPORT_MANIFEST_VERSION) {
    return { valid: false, reason: `Unsupported manifest version (${manifest.version}).` };
  }
  if (typeof manifest.signature !== "string" || !/^[0-9a-f]+$/i.test(manifest.signature)) {
    return { valid: false, reason: "Malformed signature." };
  }
  let canonical: string;
  let contentHash: string;
  try {
    canonical = canonicalizeExportPayload(manifest.payload);
    contentHash = sha256Hex(canonical);
  } catch {
    return { valid: false, reason: "Manifest payload could not be read." };
  }
  const expected = Buffer.from(hmacHex(canonical), "hex");
  const got = Buffer.from(manifest.signature, "hex");
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
    return { valid: false, reason: "Signature does not match. The file was altered or not produced by this server.", contentHash };
  }
  return { valid: true, contentHash };
}
