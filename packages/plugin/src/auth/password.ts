/**
 * Password hashing helpers. We use Argon2id via `argon2` (a libsodium-backed
 * native binding). Defaults match OWASP recommendations and the values
 * documented in SECURITY.md (m=64MiB, t=3, p=4).
 *
 * NOTE: This hash is for AUTHENTICATION ONLY. The browser independently
 * derives a separate KEK via Argon2id over a different salt for key wrapping.
 * The server can verify password correctness without ever seeing the KEK or
 * the master key.
 */
import argon2 from "argon2";

import type { ParrotConfig } from "../types.js";

export interface PasswordPolicy {
  memoryCostKiB: number;
  timeCost: number;
  parallelism: number;
}

export function policyFromConfig(cfg: ParrotConfig): PasswordPolicy {
  return {
    memoryCostKiB: cfg.auth.argon2.memoryCostKiB,
    timeCost: cfg.auth.argon2.timeCost,
    parallelism: cfg.auth.argon2.parallelism,
  };
}

export async function hashPassword(password: string, policy: PasswordPolicy): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: policy.memoryCostKiB,
    timeCost: policy.timeCost,
    parallelism: policy.parallelism,
  });
}

export async function verifyPassword(encodedHash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(encodedHash, password);
  } catch {
    return false;
  }
}

/** Constant-time check whether a stored hash needs rehashing under new policy. */
export function needsRehash(encodedHash: string, policy: PasswordPolicy): boolean {
  // Parse the Argon2 encoded string: $argon2id$v=19$m=65536,t=3,p=4$...
  const m = encodedHash.match(/m=(\d+),t=(\d+),p=(\d+)/);
  if (!m) return true;
  const [, memStr, timeStr, parStr] = m;
  const mem = Number(memStr);
  const time = Number(timeStr);
  const par = Number(parStr);
  return mem < policy.memoryCostKiB || time < policy.timeCost || par < policy.parallelism;
}
