/**
 * Server-side crypto helpers.
 *
 * IMPORTANT: The server NEVER possesses the user's master key. It only sees
 * wrapped keys and ciphertext. The helpers here are limited to:
 *
 *   - generating salts/IVs (random bytes)
 *   - SHA-256 hashing (audit log, token hashing)
 *   - hash-chained audit log construction
 *
 * All AES encryption and Argon2id KDF for key derivation happen in the
 * browser; see `packages/ui/src/lib/crypto.ts` (Phase 3) and the PoC at
 * `poc/crypto.ts`.
 */
import { createHash, randomBytes } from "node:crypto";

export function randomBase64(byteLength: number): string {
  return randomBytes(byteLength).toString("base64");
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Canonicalize an object for stable hashing — keys sorted alphabetically. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** Compute the next audit-log hash from the previous hash + entry payload. */
export function nextAuditHash(prevHash: string | null, entry: Record<string, unknown>): string {
  return sha256Hex(`${prevHash ?? ""}|${canonicalJson(entry)}`);
}
