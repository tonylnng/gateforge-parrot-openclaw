/**
 * Webhook subscription routes.
 *
 *   - GET    /webhooks         — list subscriptions for the current user/tenant
 *   - POST   /webhooks         — create a subscription; secret returned ONCE
 *   - PATCH  /webhooks/:id     — toggle enabled, edit events/url
 *   - DELETE /webhooks/:id     — drop subscription
 *   - POST   /webhooks/:id/test — enqueue a `webhook.ping` event
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import type { DbHandle } from "../db/index.js";
import { principalFromRequest, AuthError } from "../auth/principal.js";
import { principalFromAny, requireScopeStrict } from "../auth/apikey.js";
import { appendAudit } from "../auth/audit.js";
import { readJsonBody, sendError, sendJson } from "../http/respond.js";
import { enqueueEvent, WEBHOOK_EVENTS } from "../webhooks/dispatcher.js";
import type { HttpRequest, HttpResponse, ParrotConfig, ParrotLogger } from "../types.js";

export interface WebhookCtx {
  cfg: ParrotConfig;
  db: DbHandle;
  logger: ParrotLogger;
}

const createSchema = z.object({
  url: z.string().url().max(2000),
  events: z.array(z.enum([...WEBHOOK_EVENTS, "*"] as unknown as [string, ...string[]])).min(1),
});

const patchSchema = z
  .object({
    url: z.string().url().max(2000).optional(),
    events: z.array(z.enum([...WEBHOOK_EVENTS, "*"] as unknown as [string, ...string[]])).min(1).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "no fields to update" });

export async function listWebhooks(ctx: WebhookCtx, req: HttpRequest, res: HttpResponse): Promise<void> {
  let principal;
  try {
    principal = await principalFromAny(ctx.cfg, ctx.db, req, principalFromRequest);
    requireScopeStrict(principal, "webhooks:manage");
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 401;
    sendError(res, status, "unauthorized", (e as Error).message);
    return;
  }

  const t = ctx.db.schema.webhooks;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (await (ctx.db.drizzle as any)
    .select({
      id: t.id,
      url: t.url,
      events: t.events,
      enabled: t.enabled,
      createdAt: t.createdAt,
      disabledAt: t.disabledAt,
      lastDeliveryAt: t.lastDeliveryAt,
      consecutiveFailures: t.consecutiveFailures,
    })
    .from(t)
    .where(and(eq(t.tenantId, principal.tenantId), eq(t.userId, principal.userId)))
    .orderBy(desc(t.createdAt))
    .limit(100)) as Array<{
      id: string;
      url: string;
      events: string;
      enabled: number;
      createdAt: number;
      disabledAt: number | null;
      lastDeliveryAt: number | null;
      consecutiveFailures: number;
    }>;

  sendJson(res, 200, {
    webhooks: rows.map((r) => ({
      id: r.id,
      url: r.url,
      events: safeParseEvents(r.events),
      enabled: r.enabled === 1,
      createdAt: r.createdAt,
      disabledAt: r.disabledAt,
      lastDeliveryAt: r.lastDeliveryAt,
      consecutiveFailures: r.consecutiveFailures,
    })),
  });
}

export async function createWebhook(ctx: WebhookCtx, req: HttpRequest, res: HttpResponse): Promise<void> {
  let principal;
  try {
    principal = await principalFromAny(ctx.cfg, ctx.db, req, principalFromRequest);
    requireScopeStrict(principal, "webhooks:manage");
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
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    sendError(res, 400, "validation_error", parsed.error.message);
    return;
  }

  // Reject obvious local/private URLs — we don't want webhooks pinging
  // host-internal services. Tenants can override via config later.
  if (isLikelyPrivateUrl(parsed.data.url)) {
    sendError(res, 400, "invalid_url", "Webhook URL must be a publicly reachable HTTPS endpoint.");
    return;
  }

  const secret = `whsec_${randomBytes(24).toString("base64url")}`;
  const secretHash = createHash("sha256").update(secret).digest("hex");
  const id = randomUUID();
  const now = Date.now();
  const t = ctx.db.schema.webhooks;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (ctx.db.drizzle as any).insert(t).values({
    id,
    tenantId: principal.tenantId,
    userId: principal.userId,
    url: parsed.data.url,
    secretHash,
    secret,
    events: JSON.stringify(parsed.data.events),
    enabled: 1,
    createdAt: now,
    disabledAt: null,
    lastDeliveryAt: null,
    consecutiveFailures: 0,
  });

  await appendAudit(ctx.db, ctx.cfg, {
    tenantId: principal.tenantId,
    actorId: principal.userId,
    action: "webhook.create",
    resource: id,
    payload: { events: parsed.data.events, url: parsed.data.url },
  });

  sendJson(res, 201, {
    webhook: {
      id,
      url: parsed.data.url,
      events: parsed.data.events,
      enabled: true,
      createdAt: now,
      // ⚠ shown ONCE
      secret,
    },
  });
}

export async function patchWebhook(
  ctx: WebhookCtx,
  req: HttpRequest,
  res: HttpResponse,
  webhookId: string,
): Promise<void> {
  let principal;
  try {
    principal = await principalFromAny(ctx.cfg, ctx.db, req, principalFromRequest);
    requireScopeStrict(principal, "webhooks:manage");
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 401;
    sendError(res, status, "unauthorized", (e as Error).message);
    return;
  }

  const owned = await loadOwnedWebhook(ctx.db, webhookId, principal.userId, principal.tenantId);
  if (!owned) {
    sendError(res, 404, "not_found", "Webhook not found.");
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

  if (parsed.data.url && isLikelyPrivateUrl(parsed.data.url)) {
    sendError(res, 400, "invalid_url", "Webhook URL must be a publicly reachable HTTPS endpoint.");
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updates: Record<string, any> = {};
  if (parsed.data.url !== undefined) updates.url = parsed.data.url;
  if (parsed.data.events !== undefined) updates.events = JSON.stringify(parsed.data.events);
  if (parsed.data.enabled !== undefined) {
    updates.enabled = parsed.data.enabled ? 1 : 0;
    updates.disabledAt = parsed.data.enabled ? null : Date.now();
    if (parsed.data.enabled) updates.consecutiveFailures = 0;
  }

  const t = ctx.db.schema.webhooks;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (ctx.db.drizzle as any).update(t).set(updates).where(eq(t.id, webhookId));

  await appendAudit(ctx.db, ctx.cfg, {
    tenantId: principal.tenantId,
    actorId: principal.userId,
    action: "webhook.update",
    resource: webhookId,
    payload: { fields: Object.keys(parsed.data) },
  });

  sendJson(res, 200, { ok: true });
}

export async function deleteWebhook(
  ctx: WebhookCtx,
  req: HttpRequest,
  res: HttpResponse,
  webhookId: string,
): Promise<void> {
  let principal;
  try {
    principal = await principalFromAny(ctx.cfg, ctx.db, req, principalFromRequest);
    requireScopeStrict(principal, "webhooks:manage");
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 401;
    sendError(res, status, "unauthorized", (e as Error).message);
    return;
  }

  const owned = await loadOwnedWebhook(ctx.db, webhookId, principal.userId, principal.tenantId);
  if (!owned) {
    sendError(res, 404, "not_found", "Webhook not found.");
    return;
  }

  const t = ctx.db.schema.webhooks;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (ctx.db.drizzle as any).delete(t).where(eq(t.id, webhookId));

  await appendAudit(ctx.db, ctx.cfg, {
    tenantId: principal.tenantId,
    actorId: principal.userId,
    action: "webhook.delete",
    resource: webhookId,
  });

  sendJson(res, 200, { ok: true });
}

export async function testWebhook(
  ctx: WebhookCtx,
  req: HttpRequest,
  res: HttpResponse,
  webhookId: string,
): Promise<void> {
  let principal;
  try {
    principal = await principalFromAny(ctx.cfg, ctx.db, req, principalFromRequest);
    requireScopeStrict(principal, "webhooks:manage");
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 401;
    sendError(res, status, "unauthorized", (e as Error).message);
    return;
  }

  const owned = await loadOwnedWebhook(ctx.db, webhookId, principal.userId, principal.tenantId);
  if (!owned) {
    sendError(res, 404, "not_found", "Webhook not found.");
    return;
  }

  await enqueueEvent(
    ctx.db,
    {
      tenantId: principal.tenantId,
      event: "webhook.ping",
      payload: { webhookId, requestedBy: principal.userId, at: Date.now() },
    },
    ctx.logger,
  );

  sendJson(res, 202, { ok: true, queued: true });
}

async function loadOwnedWebhook(db: DbHandle, id: string, userId: string, tenantId: string): Promise<{ id: string } | null> {
  const t = db.schema.webhooks;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (await (db.drizzle as any)
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.id, id), eq(t.userId, userId), eq(t.tenantId, tenantId)))
    .limit(1)) as Array<{ id: string }>;
  return rows[0] ?? null;
}

function safeParseEvents(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((s): s is string => typeof s === "string");
  } catch {
    /* */
  }
  return [];
}

function isLikelyPrivateUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return true;
    // Allow http only for localhost in dev — but block production private ranges.
    const host = u.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") return u.protocol !== "http:" && false;
    // Block obvious private ranges.
    if (host.startsWith("10.") || host.startsWith("192.168.") || host === "0.0.0.0") return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    if (host.endsWith(".local") || host.endsWith(".internal")) return true;
    return false;
  } catch {
    return true;
  }
}
