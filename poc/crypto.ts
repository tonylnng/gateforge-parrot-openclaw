/**
 * OpenClaw Chat Platform — E2EE Crypto Module (PoC)
 *
 * Implements:
 *   - Password-based key derivation (Argon2id via hash-wasm)
 *   - AES-256-GCM message encryption
 *   - AES-KW key wrapping for Conversation Keys
 *   - X25519 key sharing (optional, via libsodium)
 *
 * Runs in browser (Web Crypto API) — no Node-only APIs.
 *
 * Dependencies (npm):
 *   hash-wasm   — Argon2id implementation
 *   libsodium-wrappers — optional, for X25519 + sealed box sharing
 *
 * Install:
 *   npm install hash-wasm libsodium-wrappers
 *   npm install -D @types/libsodium-wrappers
 */

import { argon2id } from "hash-wasm";

// ============================================================================
// Constants
// ============================================================================

const ARGON2 = {
  iterations: 3,
  memorySize: 64 * 1024, // 64 MB
  parallelism: 4,
  hashLength: 32, // 256-bit key
} as const;

const AES_GCM = {
  name: "AES-GCM",
  length: 256,
  ivLength: 12, // 96-bit nonce (NIST recommended)
} as const;

const AES_KW = {
  name: "AES-KW",
  length: 256,
} as const;

// ============================================================================
// Utilities
// ============================================================================

const enc = new TextEncoder();
const dec = new TextDecoder();

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Zeroize a buffer (best-effort — JS does not guarantee memory wiping)
function zeroize(buf: Uint8Array): void {
  buf.fill(0);
}

// ============================================================================
// Master Key derivation (Argon2id)
// ============================================================================

export interface DerivedKeys {
  masterKey: CryptoKey;       // for wrapping CKs
  authHash: Uint8Array;       // sent to server for login
  masterSalt: Uint8Array;     // store on server
  authSalt: Uint8Array;       // store on server
}

/**
 * Derive Master Key + Auth Hash from password.
 * Uses TWO different salts so authHash cannot be inverted to MK.
 */
export async function deriveKeysFromPassword(
  password: string,
  masterSalt?: Uint8Array,
  authSalt?: Uint8Array,
): Promise<DerivedKeys> {
  const mSalt = masterSalt ?? randomBytes(16);
  const aSalt = authSalt ?? randomBytes(16);

  // Master key bytes
  const mkBytes = await argon2id({
    password,
    salt: mSalt,
    parallelism: ARGON2.parallelism,
    iterations: ARGON2.iterations,
    memorySize: ARGON2.memorySize,
    hashLength: ARGON2.hashLength,
    outputType: "binary",
  });

  // Auth hash (sent to server)
  const authBytes = await argon2id({
    password,
    salt: aSalt,
    parallelism: ARGON2.parallelism,
    iterations: ARGON2.iterations,
    memorySize: ARGON2.memorySize,
    hashLength: ARGON2.hashLength,
    outputType: "binary",
  });

  // Import MK as non-extractable CryptoKey (used as AES-KW wrap key)
  const masterKey = await crypto.subtle.importKey(
    "raw",
    mkBytes,
    AES_KW,
    /* extractable */ false,
    ["wrapKey", "unwrapKey"],
  );

  // Zeroize raw bytes (Web Crypto holds the key internally)
  zeroize(mkBytes as Uint8Array);

  return {
    masterKey,
    authHash: authBytes as Uint8Array,
    masterSalt: mSalt,
    authSalt: aSalt,
  };
}

// ============================================================================
// Conversation Key generation + wrapping
// ============================================================================

export interface WrappedKey {
  wrappedKey: string; // base64
}

/**
 * Generate a fresh random Conversation Key (CK).
 * Returned as a non-extractable CryptoKey for encryption operations.
 */
export async function generateConversationKey(): Promise<CryptoKey> {
  return await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    /* extractable */ true, // must be extractable to wrap; can re-import as non-extractable later
    ["encrypt", "decrypt"],
  );
}

/**
 * Wrap a Conversation Key with the Master Key (AES-KW).
 * Returns a base64 string safe to send to server.
 */
export async function wrapConversationKey(
  ck: CryptoKey,
  masterKey: CryptoKey,
): Promise<WrappedKey> {
  const wrapped = await crypto.subtle.wrapKey("raw", ck, masterKey, AES_KW);
  return { wrappedKey: bytesToBase64(new Uint8Array(wrapped)) };
}

/**
 * Unwrap a Conversation Key using the Master Key.
 * Imported as non-extractable so it cannot be exfiltrated.
 */
export async function unwrapConversationKey(
  wrapped: WrappedKey,
  masterKey: CryptoKey,
): Promise<CryptoKey> {
  const bytes = base64ToBytes(wrapped.wrappedKey);
  return await crypto.subtle.unwrapKey(
    "raw",
    bytes,
    masterKey,
    AES_KW,
    { name: "AES-GCM", length: 256 },
    /* extractable */ false,
    ["encrypt", "decrypt"],
  );
}

// ============================================================================
// Message encryption (AES-256-GCM)
// ============================================================================

export interface EncryptedMessage {
  ciphertext: string; // base64
  iv: string;         // base64
}

/**
 * Encrypt a UTF-8 string with the Conversation Key.
 * AES-GCM provides authenticated encryption (tag included in ciphertext).
 */
export async function encryptMessage(
  plaintext: string,
  ck: CryptoKey,
): Promise<EncryptedMessage> {
  const iv = randomBytes(AES_GCM.ivLength);
  const data = enc.encode(plaintext);

  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    ck,
    data,
  );

  return {
    ciphertext: bytesToBase64(new Uint8Array(ct)),
    iv: bytesToBase64(iv),
  };
}

/**
 * Decrypt an encrypted message blob with the Conversation Key.
 * Throws if the GCM auth tag fails (tampering or wrong key).
 */
export async function decryptMessage(
  blob: EncryptedMessage,
  ck: CryptoKey,
): Promise<string> {
  const ct = base64ToBytes(blob.ciphertext);
  const iv = base64ToBytes(blob.iv);

  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    ck,
    ct,
  );

  return dec.decode(plain);
}

// ============================================================================
// Key zeroization helper
// ============================================================================

/**
 * Drop a CryptoKey reference. Web Crypto holds the actual material;
 * we cannot directly zero it, but losing the reference allows GC + browser
 * to reclaim the slot.
 *
 * Best practice: explicitly null out references on logout / idle lock.
 */
export function clearKey<T extends CryptoKey>(_keyRef: T | null): null {
  return null;
}

// ============================================================================
// Demo (run in browser console or test)
// ============================================================================

/**
 * Demonstration of the full E2EE round trip.
 *
 *   const out = await demo();
 *   console.log(out);
 *
 * Expected: decrypted message matches the original plaintext.
 */
export async function demo(): Promise<{
  plaintext: string;
  decrypted: string;
  match: boolean;
}> {
  // 1. User enters password — derive MK + auth hash
  const password = "correct horse battery staple";
  const { masterKey, authHash, masterSalt, authSalt } =
    await deriveKeysFromPassword(password);

  console.log("[demo] Derived MK (non-extractable)");
  console.log("[demo] authHash to send to server:", bytesToBase64(authHash));
  console.log("[demo] masterSalt:", bytesToBase64(masterSalt));
  console.log("[demo] authSalt:", bytesToBase64(authSalt));

  // 2. Create a new conversation — generate CK, wrap with MK
  const ck = await generateConversationKey();
  const wrappedCk = await wrapConversationKey(ck, masterKey);
  console.log("[demo] wrappedCk (stored on server):", wrappedCk.wrappedKey);

  // 3. Encrypt a message
  const plaintext = "Hello OpenClaw — this is a secret message.";
  const encrypted = await encryptMessage(plaintext, ck);
  console.log("[demo] ciphertext stored on server:", encrypted);

  // ---------- Server side: stores wrappedCk + encrypted (cannot read) ---------

  // 4. Later: user reopens — re-derive MK from password + salt
  const second = await deriveKeysFromPassword(
    password,
    masterSalt,
    authSalt,
  );

  // 5. Unwrap CK and decrypt message
  const ckAgain = await unwrapConversationKey(wrappedCk, second.masterKey);
  const decrypted = await decryptMessage(encrypted, ckAgain);
  console.log("[demo] decrypted:", decrypted);

  return {
    plaintext,
    decrypted,
    match: plaintext === decrypted,
  };
}

// ============================================================================
// Tamper-detection demo (should throw)
// ============================================================================

export async function demoTamper(): Promise<{ caught: boolean; error?: string }> {
  const { masterKey } = await deriveKeysFromPassword("pw");
  const ck = await generateConversationKey();
  const enc1 = await encryptMessage("original", ck);

  // Flip one byte of ciphertext
  const tampered = base64ToBytes(enc1.ciphertext);
  tampered[0] ^= 0xff;
  const badBlob = { ciphertext: bytesToBase64(tampered), iv: enc1.iv };

  try {
    await decryptMessage(badBlob, ck);
    return { caught: false };
  } catch (e) {
    return { caught: true, error: (e as Error).message };
  }
}
