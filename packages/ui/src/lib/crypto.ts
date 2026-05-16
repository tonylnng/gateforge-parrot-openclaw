/**
 * Browser-side crypto for GateForge Parrot.
 *
 * - Argon2id KDF via `hash-wasm` (browser-friendly, WebAssembly)
 * - AES-256-GCM via WebCrypto for message encryption
 * - AES-KW via WebCrypto for wrapping per-conversation keys with the master key
 *
 * Important invariants:
 *   • Master key plaintext NEVER leaves the browser.
 *   • Each conversation has its own random 256-bit key, wrapped under the
 *     master key with AES-KW before being sent to the server.
 *   • Message ciphertext is packed as: iv (12 bytes) || ciphertext || tag (16 bytes),
 *     then base64-encoded.
 */
import { argon2id } from "hash-wasm";

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface KdfParams {
  /** base64-encoded random salt */
  salt: string;
  memoryCostKiB: number;
  timeCost: number;
  parallelism: number;
}

/** Sensible defaults matching SECURITY.md and the server's Argon2 policy. */
export const DEFAULT_KDF: Omit<KdfParams, "salt"> = {
  memoryCostKiB: 65_536,
  timeCost: 3,
  parallelism: 4,
};

export function generateSalt(byteLength = 16): string {
  const buf = new Uint8Array(byteLength);
  crypto.getRandomValues(buf);
  return toBase64(buf);
}

/**
 * Derive a 256-bit key-encryption key (KEK) from a password using Argon2id.
 * The result is imported as a non-extractable WebCrypto CryptoKey for use
 * with AES-KW.
 */
export async function deriveKek(password: string, params: KdfParams): Promise<CryptoKey> {
  const saltBytes = fromBase64(params.salt);
  const hashBytes = await argon2id({
    password: enc.encode(password),
    salt: saltBytes,
    parallelism: params.parallelism,
    iterations: params.timeCost,
    memorySize: params.memoryCostKiB,
    hashLength: 32,
    outputType: "binary",
  });
  return crypto.subtle.importKey("raw", toArrayBuffer(hashBytes as Uint8Array), { name: "AES-KW", length: 256 }, false, [
    "wrapKey",
    "unwrapKey",
  ]);
}

/** Generate a fresh 256-bit AES-GCM key intended for message encryption. */
export async function generateMessageKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

/** Wrap a CryptoKey with the KEK (AES-KW). Returns base64-encoded wrapped key. */
export async function wrapKey(key: CryptoKey, kek: CryptoKey): Promise<string> {
  const wrapped = await crypto.subtle.wrapKey("raw", key, kek, { name: "AES-KW" });
  return toBase64(new Uint8Array(wrapped));
}

/** Unwrap a base64-encoded wrapped key back into a usable AES-GCM CryptoKey. */
export async function unwrapKey(wrappedB64: string, kek: CryptoKey): Promise<CryptoKey> {
  const wrappedBytes = fromBase64(wrappedB64);
  return crypto.subtle.unwrapKey(
    "raw",
    toArrayBuffer(wrappedBytes),
    kek,
    { name: "AES-KW" },
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt plaintext with the given AES-GCM key.
 * Output format: base64(iv ‖ ciphertext ‖ tag) where iv is 12 bytes and tag is 16 bytes
 * (the WebCrypto API appends the tag to the ciphertext automatically).
 */
export async function encrypt(plaintext: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = enc.encode(plaintext);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, toArrayBuffer(data)),
  );
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return toBase64(packed);
}

/** Decrypt a payload produced by {@link encrypt}. */
export async function decrypt(payloadB64: string, key: CryptoKey): Promise<string> {
  const packed = fromBase64(payloadB64);
  if (packed.length < 12 + 16) throw new Error("ciphertext too short");
  const iv = packed.subarray(0, 12);
  const ct = packed.subarray(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, key, toArrayBuffer(ct));
  return dec.decode(pt);
}

// -- Base64 helpers (no dependency) --------------------------------------

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Copy a Uint8Array view into a fresh standalone ArrayBuffer. Needed for
 *  WebCrypto APIs whose strict types reject `Uint8Array<ArrayBufferLike>`. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}
