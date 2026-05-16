/**
 * API key management routes — issue, list, revoke.
 *
 * The plaintext API key is returned exactly once on POST /apikeys; afterwards
 * only the public prefix and metadata are visible. The wrapped master key copy
 * sent with the issue request is stored as-is (server cannot decrypt it).
 *
 * The user must be authenticated with a JWT — API keys cannot manage other API
 * keys unless they hold the `apikeys:manage` scope.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import type { DbHandle } from "../db/index.js";
import { principalFromRequest, AuthError } from "../auth/principal.js";
import { principalFromAny, requireScopeStrict, generateApiKey, SCOPES, type Scope } from "../auth/apikey.js";
import { appendAudit } from "../auth/audit.js";
import { readJsonBody, sendError, sendJson } from "../http/respond.js";
import type { HttpRequest, HttpResponse, ParrotConfig } from "../types.js";

export interface ApiKeyCtx {
  cfg: ParrotConfig;
  db: DbHandle;
}

const issueSchema = z.object({
  label: z.string().min(1).max(120),
  scopes: z.array(z.enum(SCOPES as unknown as [string, ...string[]])).min(1),
  /** Wrapped master key copy derived from the API key inside the browser. */
  wrappedMasterKey: z.string().min(16),
  env: z.enum(["live", "test"]).optional(),
});

const patchSchema = z
  .object({
    label: z.string().min(1).max(120).optional(),
    scopes: z.array(z.enum(SCOPES as unknown as [string, ...string[]])).min(1).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "no fields to update" });

export async function listApiKeys(ctx: ApiKeyCtx, req: HttpRequest, res: HttpResponse): Promise<void> {
  let principal;
  try {
    principal = await principalFromAny(ctx.cfg, ctx.db, req, principalFromRequest);
    requireScopeStrict(principal, "apikeys:manage");
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 401;
    sendError(res, status, "unauthorized", (e as Error).message);
    return;
  }

  const t = ctx.db.schema.apiKeys;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (await (ctx.db.drizzle as any)
    .select({
      id: t.id,
      label: t.label,
      scopes: t.scopes,
      createdAt: t.createdAt,
      lastUsedAt: t.lastUsedAt,
      revokedAt: t.revokedAt,
    })
    .from(t)
    .where(and(eq(t.tenantId, principal.tenantId), eq(t.userId, principal.userId)))
    .orderBy(desc(t.createdAt))
    .limit(100)) as Array<{
      id: string;
      label: string;
      scopes: string;
      createdAt: number;
      lastUsedAt: number | null;
      revokedAt: number | null;
    }>;

  sendJson(res, 200, {
    apiKeys: rows.map((r) => ({
      id: r.id,
      label: r.label,
      scopes: safeParseScopes(r.scopes),
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
      revokedAt: r.revokedAt,
      // We deliberately do not include the prefix here — the prefix is in the
      // (un-stored) plaintext token only. Listing shows id + label only.
    })),
  });
}

export async function issueApiKey(ctx: ApiKeyCtx, req: HttpRequest, res: HttpResponse): Promise<void> {
  let principal;
  try {
    principal = await principalFromRequest(ctx.cfg, req);
    requireScopeStrict(principal, "apikeys:manage");
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 401;
    sendError(res, status, "unauthorized", (e as Error).message);
    return;
  }

  const body = await readJsonBody(req).catch((e: Error) => {
    sendError(res, 400, "bad_json", e.message);
    return null;
  });
  if (body === null) return;
  const parsed = issueSchema.safeParse(body);
  if (!parsed.success) {
    sendError(res, 400, "validation_error", parsed.error.message);
    return;
  }

  const generated = generateApiKey(parsed.data.env ?? "live");
  const id = randomUUID();
  const now = Date.now();
  const t = ctx.db.schema.apiKeys;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (ctx.db.drizzle as any).insert(t).values({
    id,
    tenantId: principal.tenantId,
    userId: principal.userId,
    label: parsed.data.label,
    keyHash: generated.keyHash,
    wrappedMasterKey: parsed.data.wrappedMasterKey,
    scopes: JSON.stringify(parsed.data.scopes),
    createdAt: now,
    lastUsedAt: null,
    revokedAt: null,
  });

  await appendAudit(ctx.db, ctx.cfg, {
    tenantId: principal.tenantId,
    actorId: principal.userId,
    action: "apikey.issue",
    resource: id,
    payload: { scopes: parsed.data.scopes, env: parsed.data.env ?? "live" },
  });

  sendJson(res, 201, {
    apiKey: {
      id,
      label: parsed.data.label,
      scopes: parsed.data.scopes,
      createdAt: now,
      keyPrefix: generated.keyPrefix,
      // ⚠ shown ONCE — never returned again
      token: generated.token,
    },
  });
}

/**
 * PATCH /apikeys/:id — rename a key or update its scope set. The key value
 * itself is never re-issued; only metadata changes.
 */
export async function patchApiKey(
  ctx: ApiKeyCtx,
  req: HttpRequest,
  res: HttpResponse,
  apiKeyId: string,
): Promise<void> {
  let principal;
  try {
    principal = await principalFromRequest(ctx.cfg, req);
    requireScopeStrict(principal, "apikeys:manage");
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 401;
    sendError(res, status, "unauthorized", (e as Error).message);
    return;
  }

  const body = await readJsonBody(req).catch((e: Error) => {
    sendError(res, 400, "bad_json", e.message);
    return null;
  });
  if (body === null) return;
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    sendError(res, 400, "validation_error", parsed.error.message);
    return;
  }

  const t = ctx.db.schema.apiKeys;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (await (ctx.db.drizzle as any)
    .select({ id: t.id, revokedAt: t.revokedAt })
    .from(t)
    .where(and(eq(t.id, apiKeyId), eq(t.userId, principal.userId), eq(t.tenantId, principal.tenantId)))
    .limit(1)) as Array<{ id: string; revokedAt: number | null }>;
  if (rows.length === 0) {
    sendError(res, 404, "not_found", "API key not found.");
    return;
  }
  if (rows[0].revokedAt !== null) {
    sendError(res, 409, "conflict", "API key is revoked; reissue instead.");
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updates: Record<string, any> = {};
  if (parsed.data.label !== undefined) updates.label = parsed.data.label;
  if (parsed.data.scopes !== undefined) updates.scopes = JSON.stringify(parsed.data.scopes);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (ctx.db.drizzle as any).update(t).set(updates).where(eq(t.id, apiKeyId));

  await appendAudit(ctx.db, ctx.cfg, {
    tenantId: principal.tenantId,
    actorId: principal.userId,
    action: "apikey.patch",
    resource: apiKeyId,
    payload: { fields: Object.keys(parsed.data) },
  });

  sendJson(res, 200, { ok: true });
}

export async function revokeApiKey(
  ctx: ApiKeyCtx,
  req: HttpRequest,
  res: HttpResponse,
  apiKeyId: string,
): Promise<void> {
  let principal;
  try {
    principal = await principalFromRequest(ctx.cfg, req);
    requireScopeStrict(principal, "apikeys:manage");
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 401;
    sendError(res, status, "unauthorized", (e as Error).message);
    return;
  }

  const t = ctx.db.schema.apiKeys;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (await (ctx.db.drizzle as any)
    .select({ id: t.id, revokedAt: t.revokedAt })
    .from(t)
    .where(and(eq(t.id, apiKeyId), eq(t.userId, principal.userId), eq(t.tenantId, principal.tenantId), isNull(t.revokedAt)))
    .limit(1)) as Array<{ id: string }>;
  if (rows.length === 0) {
    sendError(res, 404, "not_found", "API key not found or already revoked.");
    return;
  }

  const now = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (ctx.db.drizzle as any).update(t).set({ revokedAt: now }).where(eq(t.id, apiKeyId));

  await appendAudit(ctx.db, ctx.cfg, {
    tenantId: principal.tenantId,
    actorId: principal.userId,
    action: "apikey.revoke",
    resource: apiKeyId,
  });

  sendJson(res, 200, { ok: true, revokedAt: now });
}

function safeParseScopes(raw: string): Scope[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((s): s is Scope => typeof s === "string");
  } catch {
    /* fall through */
  }
  return [];
}
