/**
 * WebCrypto helpers used by both the bundled UI and any third-party app that
 * wants to talk to GateForge Parrot's API directly.
 *
 *   Master key  (32 bytes)  derived once per user from Argon2id(password, salt)
 *   Conversation key (32B)  generated per conversation; wrapped with master key
 *   Message ciphertext      AES-256-GCM(plaintext, conversationKey, iv)
 *                           layout: iv (12B) || ciphertext || tag (16B), base64
 *
 * The master key NEVER leaves the client. The server stores only:
 *   - kdf parameters + salt
 *   - wrapped_master_key (AES-KW)
 *   - wrapped_conversation_key (AES-KW per conversation)
 *   - encrypted_title (AES-256-GCM with conversation key)
 *   - ciphertext payload per message
 *
 * Argon2 is performed via `argon2-browser` in the UI; this module only handles
 * the AES-KW + AES-GCM steps that WebCrypto exposes natively. The KDF step is
 * intentionally a separate concern — call sites pass in the derived 32-byte KEK.
 */

const subtle = (): SubtleCrypto => {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error("WebCrypto is not available in this environment.");
  return c.subtle;
};

const IV_LEN = 12;
const TAG_LEN = 16;

// ---- base64 helpers ---------------------------------------------------------

export function b64encode(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }
  // Node.js fallback
  return Buffer.from(bytes).toString("base64");
}

export function b64decode(s: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(s, "base64"));
}

// ---- AES-KW (key wrapping) --------------------------------------------------

/** Coerce a Uint8Array (which may be backed by SharedArrayBuffer in strict TS) into a BufferSource. */
function asBuffer(u8: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(u8.byteLength);
  new Uint8Array(out).set(u8);
  return out;
}

/** Import a 32-byte raw secret as an AES-KW wrapping key. */
export async function importKekForWrap(raw32: Uint8Array): Promise<CryptoKey> {
  if (raw32.length !== 32) throw new Error("KEK must be 32 bytes");
  return subtle().importKey("raw", asBuffer(raw32), { name: "AES-KW", length: 256 }, false, ["wrapKey", "unwrapKey"]);
}

/** Generate a fresh AES-256-GCM content key (master or conversation). */
export async function generateContentKey(): Promise<CryptoKey> {
  return subtle().generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

/** Export a content key as raw 32 bytes (for wrapping or transport). */
export async function exportRawKey(key: CryptoKey): Promise<Uint8Array> {
  const raw = await subtle().exportKey("raw", key);
  return new Uint8Array(raw);
}

/** Import a raw 32-byte AES-256-GCM key. */
export async function importContentKey(raw: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey("raw", asBuffer(raw), { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

/** Wrap `contentKey` under `kek` (AES-KW). Returns base64 of the wrapped bytes. */
export async function wrapContentKey(kek: CryptoKey, contentKey: CryptoKey): Promise<string> {
  const wrapped = await subtle().wrapKey("raw", contentKey, kek, { name: "AES-KW" });
  return b64encode(new Uint8Array(wrapped));
}

/** Inverse of `wrapContentKey`. */
export async function unwrapContentKey(kek: CryptoKey, wrappedB64: string): Promise<CryptoKey> {
  const wrapped = asBuffer(b64decode(wrappedB64));
  return subtle().unwrapKey(
    "raw",
    wrapped,
    kek,
    { name: "AES-KW" },
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

// ---- AES-256-GCM message encryption -----------------------------------------

/**
 * Encrypt plaintext under `key` using AES-256-GCM with a fresh random IV.
 * Returns base64(iv || ciphertext || tag).
 */
export async function encryptMessage(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LEN));
  const enc = new TextEncoder().encode(plaintext);
  const ct = new Uint8Array(
    await subtle().encrypt({ name: "AES-GCM", iv: asBuffer(iv), tagLength: TAG_LEN * 8 }, key, asBuffer(enc)),
  );
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv, 0);
  packed.set(ct, iv.length);
  return b64encode(packed);
}

/** Decrypt a base64(iv || ciphertext || tag) blob produced by `encryptMessage`. */
export async function decryptMessage(key: CryptoKey, packedB64: string): Promise<string> {
  const packed = b64decode(packedB64);
  if (packed.length < IV_LEN + TAG_LEN) throw new Error("ciphertext too short");
  const iv = packed.slice(0, IV_LEN);
  const ct = packed.slice(IV_LEN);
  const pt = new Uint8Array(
    await subtle().decrypt({ name: "AES-GCM", iv: asBuffer(iv), tagLength: TAG_LEN * 8 }, key, asBuffer(ct)),
  );
  return new TextDecoder().decode(pt);
}

// ---- Webhook HMAC verification ---------------------------------------------

/**
 * Verify an `X-Parrot-Signature` header against the raw request body.
 * The header format is `t=<unix>,v1=<hex>`.
 * Reject if `t` is older than 5 minutes by default to prevent replay.
 */
export async function verifyWebhookSignature(
  secret: string,
  header: string,
  rawBody: string,
  toleranceSec = 300,
): Promise<boolean> {
  const parts = Object.fromEntries(
    header.split(",").map((kv) => kv.trim().split("=") as [string, string]),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!t || !v1) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > toleranceSec) return false;

  const keyData = new TextEncoder().encode(secret);
  const key = await subtle().importKey("raw", asBuffer(keyData), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(
    await subtle().sign("HMAC", key, asBuffer(new TextEncoder().encode(`${t}.${rawBody}`))),
  );
  const expected = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");

  // constant-time compare
  if (expected.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}
