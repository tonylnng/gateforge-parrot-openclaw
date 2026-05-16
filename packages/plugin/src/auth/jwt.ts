/**
 * JWT issuance and verification using HS256 via `jose`.
 *
 * We issue short-lived access tokens (default 15 min) and long-lived refresh
 * tokens (default 30 days). Refresh tokens are tracked server-side by jti so
 * they can be revoked individually.
 */
import { SignJWT, jwtVerify } from "jose";
import { randomBytes, createHash } from "node:crypto";

import type { ParrotConfig, Principal } from "../types.js";

export type TokenKind = "access" | "refresh";

export interface IssuedTokenPair {
  accessToken: string;
  refreshToken: string;
  accessTokenExp: number;
  refreshTokenExp: number;
  refreshJti: string;
  refreshTokenHash: string;
}

export class TokenError extends Error {
  constructor(
    message: string,
    public readonly code: "expired" | "invalid" | "revoked" = "invalid",
  ) {
    super(message);
    this.name = "TokenError";
  }
}

function secretBytes(cfg: ParrotConfig): Uint8Array {
  return new TextEncoder().encode(cfg.auth.jwtSecret);
}

const ISSUER = "gateforge-parrot";
const AUDIENCE = "gateforge-parrot-api";

export async function issueTokenPair(
  cfg: ParrotConfig,
  principal: Omit<Principal, "exp" | "jti">,
): Promise<IssuedTokenPair> {
  const now = Math.floor(Date.now() / 1000);
  const accessExp = now + cfg.auth.accessTokenTtlSeconds;
  const refreshExp = now + cfg.auth.refreshTokenTtlSeconds;
  const refreshJti = randomBytes(16).toString("hex");
  const secret = secretBytes(cfg);

  const accessToken = await new SignJWT({
    sub: principal.userId,
    tid: principal.tenantId,
    scopes: principal.scopes,
    kind: "access",
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(now)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(accessExp)
    .setJti(randomBytes(8).toString("hex"))
    .sign(secret);

  const refreshToken = await new SignJWT({
    sub: principal.userId,
    tid: principal.tenantId,
    kind: "refresh",
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt(now)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(refreshExp)
    .setJti(refreshJti)
    .sign(secret);

  return {
    accessToken,
    refreshToken,
    accessTokenExp: accessExp,
    refreshTokenExp: refreshExp,
    refreshJti,
    refreshTokenHash: hashToken(refreshToken),
  };
}

export async function verifyToken(cfg: ParrotConfig, token: string, kind: TokenKind): Promise<Principal> {
  try {
    const { payload } = await jwtVerify(token, secretBytes(cfg), {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (payload.kind !== kind) throw new TokenError("token kind mismatch");
    const userId = payload.sub;
    const tenantId = payload.tid;
    const scopes = Array.isArray(payload.scopes) ? (payload.scopes as string[]) : [];
    if (typeof userId !== "string" || typeof tenantId !== "string") {
      throw new TokenError("malformed token payload");
    }
    return {
      userId,
      tenantId,
      scopes,
      exp: payload.exp ?? 0,
      jti: typeof payload.jti === "string" ? payload.jti : "",
    };
  } catch (err) {
    if (err instanceof TokenError) throw err;
    const msg = (err as Error).message ?? "verify failed";
    if (msg.includes("exp")) throw new TokenError("token expired", "expired");
    throw new TokenError(`invalid token: ${msg}`, "invalid");
  }
}

/** SHA-256 hash of a token, used for server-side bookkeeping of refresh tokens. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
