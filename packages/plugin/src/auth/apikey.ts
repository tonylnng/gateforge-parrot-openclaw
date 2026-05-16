/**
 * API key bearer-auth middleware.
 *
 * Wire format: `Authorization: Bearer pk_<env>_<random>.<secret>`
 *
 *   - `pk` = "parrot key" prefix
 *   - `env`  = `live` | `test` (informational)
 *   - `random` (16 chars hex) = uniquely identifies the row for fast lookup
 *   - `secret` (32 chars b64url) = checked against `keyHash` (SHA-256)
 *
 * The plaintext key is shown ONCE at creation and never stored. We hash the
 * full token (`pk_*.*`) with SHA-256 and look it up in `api_keys.key_hash`.
 *
 * Scope semantics:
 *   - JWT principal scopes are `["user"]` (broad).
 *   - API key principal scopes are explicit per RFC list — see SCOPES.
 *
 * The middleware also bumps `lastUsedAt` (fire-and-forget) for visibility.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";

import type { DbHandle } from "../db/index.js";
import { AuthError } from "./principal.js";
import { readHeader } from "./principal.js";
import type { HttpRequest, ParrotConfig, Principal } from "../types.js";

/** Canonical scope list — used by validation and OpenAPI generation. */
export const SCOPES = [
  "conversations:read",
  "conversations:write",
  "conversations:delete",
  "messages:read",
  "messages:send",
  "messages:stream",
  "apikeys:manage",
  "webhooks:manage",
  "audit:read",
  "agents:read",
] as const;
export type Scope = (typeof SCOPES)[number];

/** Issued API key returned to the caller once at creation. */
export interface IssuedApiKey {
  /** Full token: `pk_<env>_<random>.<secret>`. Shown ONCE, never persisted plaintext. */
  token: string;
  /** Public key prefix used for listing/display. */
  keyPrefix: string;
  /** SHA-256 hex hash stored server-side. */
  keyHash: string;
}

/** Generate a fresh API key. */
export function generateApiKey(env: "live" | "test" = "live"): IssuedApiKey {
  const random = randomBytes(8).toString("hex"); // 16 hex chars
  const secret = randomBytes(24).toString("base64url"); // ~32 chars
  const token = `pk_${env}_${random}.${secret}`;
  return {
    token,
    keyPrefix: `pk_${env}_${random}`,
    keyHash: createHash("sha256").update(token).digest("hex"),
  };
}

/** SHA-256 hex of a presented bearer token. */
export function hashApiKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Attempt to authenticate the request using an API key. Returns a Principal
 * if the key is valid and active; throws AuthError otherwise. If the bearer
 * token does not match the API key shape (`pk_*`), returns null so the caller
 * can fall back to JWT auth.
 */
export async function principalFromApiKey(
  cfg: ParrotConfig,
  db: DbHandle,
  req: HttpRequest,
): Promise<Principal | null> {
  void cfg;
  const header = readHeader(req, "authorization");
  if (!header?.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice("bearer ".length).trim();
  if (!token.startsWith("pk_")) return null;

  const presentedHash = hashApiKey(token);
  const presentedHashBuf = Buffer.from(presentedHash, "hex");

  const t = db.schema.apiKeys;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (await (db.drizzle as any)
    .select()
    .from(t)
    .where(eq(t.keyHash, presentedHash))
    .limit(1)) as Array<{
      id: string;
      tenantId: string;
      userId: string;
      keyHash: string;
      scopes: string;
      revokedAt: number | null;
    }>;
  const row = rows[0];
  if (!row) throw new AuthError("invalid API key", 401);

  // Constant-time compare against the stored hash (already filtered above, but
  // double-check to avoid trivial substitution attacks if the index ever
  // collides — astronomically unlikely with SHA-256).
  const storedHashBuf = Buffer.from(row.keyHash, "hex");
  if (storedHashBuf.length !== presentedHashBuf.length || !timingSafeEqual(storedHashBuf, presentedHashBuf)) {
    throw new AuthError("invalid API key", 401);
  }
  if (row.revokedAt) throw new AuthError("API key revoked", 401);

  let scopes: string[] = [];
  try {
    const parsed = JSON.parse(row.scopes);
    if (Array.isArray(parsed)) scopes = parsed.filter((s): s is string => typeof s === "string");
  } catch {
    // Malformed scopes column — treat as no scopes.
  }

  // Fire-and-forget lastUsedAt update.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  void (db.drizzle as any).update(t).set({ lastUsedAt: Date.now() }).where(eq(t.id, row.id));

  return {
    userId: row.userId,
    tenantId: row.tenantId,
    scopes,
    exp: 0, // API keys do not expire by TTL — only by revokedAt.
    jti: row.id,
  };
}

/**
 * Resolve a principal from either an API key (`pk_*`) or a JWT bearer token.
 * Errors are AuthError with appropriate status.
 */
export async function principalFromAny(
  cfg: ParrotConfig,
  db: DbHandle,
  req: HttpRequest,
  jwtFallback: (cfg: ParrotConfig, req: HttpRequest) => Promise<Principal>,
): Promise<Principal> {
  const apiKeyPrincipal = await principalFromApiKey(cfg, db, req);
  if (apiKeyPrincipal) return apiKeyPrincipal;
  return jwtFallback(cfg, req);
}

/** Throw AuthError if `scope` is not present (allowing wildcard `admin`). */
export function requireScopeStrict(principal: Principal, scope: Scope): void {
  if (principal.scopes.includes(scope) || principal.scopes.includes("admin")) return;
  // JWT principals get "user" scope which implicitly satisfies all `conversations:*` /
  // `messages:*` operations the owner can perform on their own data. API keys
  // must list scopes explicitly.
  if (principal.scopes.includes("user")) {
    const implicitlyUserAllowed: Scope[] = [
      "conversations:read",
      "conversations:write",
      "conversations:delete",
      "messages:read",
      "messages:send",
      "messages:stream",
      "apikeys:manage",
      "webhooks:manage",
      "agents:read",
    ];
    if (implicitlyUserAllowed.includes(scope)) return;
  }
  throw new AuthError(`missing required scope: ${scope}`, 403);
}
