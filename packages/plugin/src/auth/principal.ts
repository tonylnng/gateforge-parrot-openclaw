/**
 * Resolve an authenticated principal from an incoming HTTP request.
 * Supports `Authorization: Bearer <jwt>` and `?token=<jwt>` (the latter for
 * WebSocket upgrade only).
 *
 * NEVER trust the tenantId from the URL — always derive it from the verified JWT.
 */
import type { HttpRequest, ParrotConfig, Principal } from "../types.js";
import { TokenError, verifyToken } from "./jwt.js";

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status: number = 401,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export async function principalFromRequest(
  cfg: ParrotConfig,
  req: HttpRequest,
  opts: { allowQueryToken?: boolean } = {},
): Promise<Principal> {
  const header = readHeader(req, "authorization");
  let token: string | undefined;
  if (header?.toLowerCase().startsWith("bearer ")) {
    token = header.slice("bearer ".length).trim();
  }
  if (!token && opts.allowQueryToken) {
    const url = new URL(req.url, "http://placeholder");
    token = url.searchParams.get("token") ?? undefined;
  }
  if (!token) throw new AuthError("missing bearer token");

  try {
    return await verifyToken(cfg, token, "access");
  } catch (err) {
    if (err instanceof TokenError) {
      throw new AuthError(err.message, err.code === "expired" ? 401 : 403);
    }
    throw new AuthError("invalid token", 401);
  }
}

export function readHeader(req: HttpRequest, name: string): string | undefined {
  const v = req.headers[name] ?? req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v;
}

/** Scope-check helper. */
export function requireScope(principal: Principal, scope: string): void {
  if (principal.scopes.includes(scope) || principal.scopes.includes("admin")) return;
  throw new AuthError(`missing required scope: ${scope}`, 403);
}
