/**
 * Auth REST routes: signup, login, refresh, logout, whoami.
 *
 * All routes consume/produce JSON. The browser performs Argon2id key
 * derivation itself; the server only stores the resulting `wrappedMasterKey`
 * (and a separate `passwordHash` for auth).
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { DbHandle } from "../db/index.js";
import { hashPassword, policyFromConfig, verifyPassword } from "../auth/password.js";
import { hashToken, issueTokenPair, verifyToken } from "../auth/jwt.js";
import { appendAudit } from "../auth/audit.js";
import { sendError, sendJson, readJsonBody } from "../http/respond.js";
import { principalFromRequest, readHeader } from "../auth/principal.js";
import type { HttpRequest, HttpResponse, ParrotConfig } from "../types.js";

const signupSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(12).max(1024),
  kdfSalt: z.string().min(8), // base64
  kdfMemoryCostKiB: z.number().int().min(8_192).max(1_048_576),
  kdfTimeCost: z.number().int().min(1).max(20),
  kdfParallelism: z.number().int().min(1).max(16),
  wrappedMasterKey: z.string().min(16), // base64
  tenantId: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(1024),
  tenantId: z.string().optional(),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(10),
});

export interface AuthContext {
  cfg: ParrotConfig;
  db: DbHandle;
}

export async function handleSignup(ctx: AuthContext, req: HttpRequest, res: HttpResponse): Promise<void> {
  if (ctx.cfg.auth.registration === "closed") {
    sendError(res, 403, "registration_closed", "User registration is disabled.");
    return;
  }

  const body = await readJsonBody(req).catch((e: Error) => {
    sendError(res, 400, "bad_json", e.message);
    return null;
  });
  if (body === null) return;
  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) {
    sendError(res, 400, "validation_error", parsed.error.message);
    return;
  }

  const input = parsed.data;
  const tenantId =
    ctx.cfg.tenancy.mode === "single" ? ctx.cfg.tenancy.defaultTenantId : (input.tenantId ?? ctx.cfg.tenancy.defaultTenantId);

  // Check uniqueness
  const usersT = ctx.db.schema.users;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const existing = (await (ctx.db.drizzle as any)
    .select({ id: usersT.id })
    .from(usersT)
    .where(and(eq(usersT.tenantId, tenantId), eq(usersT.email, input.email)))
    .limit(1)) as Array<{ id: string }>;
  if (existing.length > 0) {
    sendError(res, 409, "user_exists", "A user with that email already exists in this tenant.");
    return;
  }

  // Ensure tenant row exists
  await ensureTenant(ctx.db, tenantId);

  const passwordHash = await hashPassword(input.password, policyFromConfig(ctx.cfg));
  const id = randomUUID();
  const now = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (ctx.db.drizzle as any).insert(usersT).values({
    id,
    tenantId,
    email: input.email,
    passwordHash,
    kdfSalt: input.kdfSalt,
    kdfMemoryCostKiB: input.kdfMemoryCostKiB,
    kdfTimeCost: input.kdfTimeCost,
    kdfParallelism: input.kdfParallelism,
    wrappedMasterKey: input.wrappedMasterKey,
    status: "active",
    createdAt: now,
  });

  await appendAudit(ctx.db, ctx.cfg, {
    tenantId,
    actorId: id,
    action: "user.signup",
    payload: { email: input.email },
  });

  const tokens = await issueTokenPair(ctx.cfg, {
    userId: id,
    tenantId,
    scopes: ["user"],
  });
  await persistRefreshToken(ctx.db, { jti: tokens.refreshJti, tokenHash: tokens.refreshTokenHash, userId: id, tenantId, expiresAt: tokens.refreshTokenExp * 1000, req });

  sendJson(res, 201, {
    user: { id, email: input.email, tenantId },
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExp: tokens.accessTokenExp,
    refreshTokenExp: tokens.refreshTokenExp,
  });
}

export async function handleLogin(ctx: AuthContext, req: HttpRequest, res: HttpResponse): Promise<void> {
  const body = await readJsonBody(req).catch((e: Error) => {
    sendError(res, 400, "bad_json", e.message);
    return null;
  });
  if (body === null) return;
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    sendError(res, 400, "validation_error", parsed.error.message);
    return;
  }
  const input = parsed.data;
  const tenantId =
    ctx.cfg.tenancy.mode === "single" ? ctx.cfg.tenancy.defaultTenantId : (input.tenantId ?? ctx.cfg.tenancy.defaultTenantId);

  const usersT = ctx.db.schema.users;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (await (ctx.db.drizzle as any)
    .select()
    .from(usersT)
    .where(and(eq(usersT.tenantId, tenantId), eq(usersT.email, input.email)))
    .limit(1)) as Array<{
      id: string;
      passwordHash: string;
      status: string;
      kdfSalt: string;
      kdfMemoryCostKiB: number;
      kdfTimeCost: number;
      kdfParallelism: number;
      wrappedMasterKey: string;
    }>;
  const user = rows[0];
  // Constant-time-ish path: always run verifyPassword to avoid timing leaks
  // about whether the email exists.
  const dummy = "$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const ok = await verifyPassword(user?.passwordHash ?? dummy, input.password);
  if (!user || !ok || user.status !== "active") {
    await appendAudit(ctx.db, ctx.cfg, {
      tenantId,
      action: "login.fail",
      payload: { email: input.email },
    });
    sendError(res, 401, "invalid_credentials", "Invalid email or password.");
    return;
  }

  const tokens = await issueTokenPair(ctx.cfg, { userId: user.id, tenantId, scopes: ["user"] });
  await persistRefreshToken(ctx.db, { jti: tokens.refreshJti, tokenHash: tokens.refreshTokenHash, userId: user.id, tenantId, expiresAt: tokens.refreshTokenExp * 1000, req });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (ctx.db.drizzle as any).update(usersT).set({ lastLoginAt: Date.now() }).where(eq(usersT.id, user.id));

  await appendAudit(ctx.db, ctx.cfg, {
    tenantId,
    actorId: user.id,
    action: "login.success",
  });

  sendJson(res, 200, {
    user: { id: user.id, email: input.email, tenantId },
    // Key material the browser needs to derive its KEK and unwrap the master key:
    kdf: {
      salt: user.kdfSalt,
      memoryCostKiB: user.kdfMemoryCostKiB,
      timeCost: user.kdfTimeCost,
      parallelism: user.kdfParallelism,
    },
    wrappedMasterKey: user.wrappedMasterKey,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExp: tokens.accessTokenExp,
    refreshTokenExp: tokens.refreshTokenExp,
  });
}

export async function handleRefresh(ctx: AuthContext, req: HttpRequest, res: HttpResponse): Promise<void> {
  const body = await readJsonBody(req).catch((e: Error) => {
    sendError(res, 400, "bad_json", e.message);
    return null;
  });
  if (body === null) return;
  const parsed = refreshSchema.safeParse(body);
  if (!parsed.success) {
    sendError(res, 400, "validation_error", parsed.error.message);
    return;
  }

  try {
    const principal = await verifyToken(ctx.cfg, parsed.data.refreshToken, "refresh");
    const tokenHash = hashToken(parsed.data.refreshToken);
    const tokenT = ctx.db.schema.refreshTokens;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (await (ctx.db.drizzle as any)
      .select()
      .from(tokenT)
      .where(eq(tokenT.tokenHash, tokenHash))
      .limit(1)) as Array<{ id: string; revokedAt: number | null; expiresAt: number }>;
    const stored = rows[0];
    if (!stored || stored.revokedAt || stored.expiresAt < Date.now()) {
      sendError(res, 401, "refresh_invalid", "Refresh token is no longer valid.");
      return;
    }

    // Rotate: revoke old, issue new pair
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (ctx.db.drizzle as any).update(tokenT).set({ revokedAt: Date.now() }).where(eq(tokenT.id, stored.id));
    const next = await issueTokenPair(ctx.cfg, {
      userId: principal.userId,
      tenantId: principal.tenantId,
      scopes: principal.scopes,
    });
    await persistRefreshToken(ctx.db, {
      jti: next.refreshJti,
      tokenHash: next.refreshTokenHash,
      userId: principal.userId,
      tenantId: principal.tenantId,
      expiresAt: next.refreshTokenExp * 1000,
      req,
    });

    sendJson(res, 200, {
      accessToken: next.accessToken,
      refreshToken: next.refreshToken,
      accessTokenExp: next.accessTokenExp,
      refreshTokenExp: next.refreshTokenExp,
    });
  } catch {
    sendError(res, 401, "refresh_invalid", "Refresh token is no longer valid.");
  }
}

export async function handleLogout(ctx: AuthContext, req: HttpRequest, res: HttpResponse): Promise<void> {
  const body = await readJsonBody(req).catch(() => ({}));
  const parsed = refreshSchema.safeParse(body);
  if (parsed.success) {
    const tokenHash = hashToken(parsed.data.refreshToken);
    const tokenT = ctx.db.schema.refreshTokens;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (ctx.db.drizzle as any).update(tokenT).set({ revokedAt: Date.now() }).where(eq(tokenT.tokenHash, tokenHash));
  }
  sendJson(res, 200, { ok: true });
}

export async function handleWhoami(ctx: AuthContext, req: HttpRequest, res: HttpResponse): Promise<void> {
  try {
    const principal = await principalFromRequest(ctx.cfg, req);
    sendJson(res, 200, { userId: principal.userId, tenantId: principal.tenantId, scopes: principal.scopes });
  } catch (e) {
    sendError(res, 401, "unauthorized", (e as Error).message);
  }
}

interface PersistRefreshArgs {
  jti: string;
  tokenHash: string;
  userId: string;
  tenantId: string;
  expiresAt: number;
  req: HttpRequest;
}
async function persistRefreshToken(db: DbHandle, args: PersistRefreshArgs): Promise<void> {
  const tokenT = db.schema.refreshTokens;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db.drizzle as any).insert(tokenT).values({
    id: args.jti,
    tenantId: args.tenantId,
    userId: args.userId,
    tokenHash: args.tokenHash,
    expiresAt: args.expiresAt,
    createdAt: Date.now(),
    userAgent: readHeader(args.req, "user-agent") ?? null,
    ip: args.req.socket?.remoteAddress ?? null,
  });
}

async function ensureTenant(db: DbHandle, tenantId: string): Promise<void> {
  const tenantsT = db.schema.tenants;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (await (db.drizzle as any)
    .select({ id: tenantsT.id })
    .from(tenantsT)
    .where(eq(tenantsT.id, tenantId))
    .limit(1)) as Array<{ id: string }>;
  if (rows.length > 0) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db.drizzle as any).insert(tenantsT).values({
    id: tenantId,
    displayName: tenantId,
    createdAt: Date.now(),
    settings: null,
  });
}
