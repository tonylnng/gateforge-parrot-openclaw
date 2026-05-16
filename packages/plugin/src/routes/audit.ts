/**
 * Audit-log read routes.
 *
 *   - GET /audit            — cursor-paginated entries, newest-first
 *   - GET /audit/verify     — recompute the hash chain and report tamper status
 *
 * Both routes require the `audit:read` scope. Audit entries store
 * non-sensitive metadata only — never ciphertext, never plaintext content.
 */
import { and, asc, desc, eq, lt } from "drizzle-orm";

import type { DbHandle } from "../db/index.js";
import { principalFromRequest, AuthError } from "../auth/principal.js";
import { principalFromAny, requireScopeStrict } from "../auth/apikey.js";
import { nextAuditHash } from "../crypto/server.js";
import { sendError, sendJson } from "../http/respond.js";
import type { HttpRequest, HttpResponse, ParrotConfig } from "../types.js";

export interface AuditCtx {
  cfg: ParrotConfig;
  db: DbHandle;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export async function listAudit(ctx: AuditCtx, req: HttpRequest, res: HttpResponse): Promise<void> {
  let principal;
  try {
    principal = await principalFromAny(ctx.cfg, ctx.db, req, principalFromRequest);
    requireScopeStrict(principal, "audit:read");
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 401;
    sendError(res, status, "unauthorized", (e as Error).message);
    return;
  }

  const url = new URL(req.url, "http://placeholder");
  const limit = clamp(parseInt(url.searchParams.get("limit") ?? "", 10) || DEFAULT_LIMIT, 1, MAX_LIMIT);
  const cursor = url.searchParams.get("cursor");
  const action = url.searchParams.get("action") ?? undefined;
  const actorId = url.searchParams.get("actorId") ?? undefined;

  // Cursor is an opaque base64 of the createdAt of the last row seen.
  let beforeTs: number | null = null;
  if (cursor) {
    try {
      beforeTs = parseInt(Buffer.from(cursor, "base64").toString("utf8"), 10);
      if (Number.isNaN(beforeTs)) beforeTs = null;
    } catch {
      beforeTs = null;
    }
  }

  const t = ctx.db.schema.auditLog;
  const conditions = [eq(t.tenantId, principal.tenantId)];
  if (beforeTs !== null) conditions.push(lt(t.createdAt, beforeTs));
  if (action) conditions.push(eq(t.action, action));
  if (actorId) conditions.push(eq(t.actorId, actorId));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (await (ctx.db.drizzle as any)
    .select()
    .from(t)
    .where(and(...conditions))
    .orderBy(desc(t.createdAt))
    .limit(limit + 1)) as Array<{
      id: string;
      tenantId: string;
      actorId: string | null;
      action: string;
      resource: string | null;
      prevHash: string | null;
      hash: string;
      payload: string | null;
      createdAt: number;
    }>;

  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map((r) => ({
    id: r.id,
    actorId: r.actorId,
    action: r.action,
    resource: r.resource,
    payload: r.payload ? safeJson(r.payload) : null,
    hash: r.hash,
    prevHash: r.prevHash,
    createdAt: r.createdAt,
  }));
  const nextCursor = hasMore
    ? Buffer.from(String(items[items.length - 1].createdAt)).toString("base64")
    : null;

  sendJson(res, 200, { items, nextCursor });
}

/**
 * Walks the audit log oldest-first and recomputes the hash chain. Reports
 * the first row at which the chain breaks (if any). Bounded at 10k entries
 * per call so this stays cheap; for larger tenants run it on a worker.
 */
export async function verifyAudit(ctx: AuditCtx, req: HttpRequest, res: HttpResponse): Promise<void> {
  let principal;
  try {
    principal = await principalFromAny(ctx.cfg, ctx.db, req, principalFromRequest);
    requireScopeStrict(principal, "audit:read");
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 401;
    sendError(res, status, "unauthorized", (e as Error).message);
    return;
  }

  if (!ctx.cfg.audit.hashChain) {
    sendJson(res, 200, {
      ok: true,
      checked: 0,
      hashChainEnabled: false,
      note: "Hash chain is disabled in config; nothing to verify.",
    });
    return;
  }

  const t = ctx.db.schema.auditLog;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (await (ctx.db.drizzle as any)
    .select()
    .from(t)
    .where(eq(t.tenantId, principal.tenantId))
    .orderBy(asc(t.createdAt))
    .limit(10_000)) as Array<{
      id: string;
      tenantId: string;
      actorId: string | null;
      action: string;
      resource: string | null;
      prevHash: string | null;
      hash: string;
      payload: string | null;
      createdAt: number;
    }>;

  let prev: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const expected = nextAuditHash(prev, {
      tenantId: r.tenantId,
      actorId: r.actorId,
      action: r.action,
      resource: r.resource,
      payload: r.payload ? safeJson(r.payload) : null,
      createdAt: r.createdAt,
    });
    if (r.prevHash !== prev || r.hash !== expected) {
      sendJson(res, 200, {
        ok: false,
        checked: i + 1,
        breakAt: { id: r.id, createdAt: r.createdAt, action: r.action },
        expected,
        actual: r.hash,
      });
      return;
    }
    prev = r.hash;
  }

  sendJson(res, 200, { ok: true, checked: rows.length, hashChainEnabled: true });
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
