/**
 * Conversation + message REST routes. All payload bodies are ciphertext from
 * the client's perspective; the server stores them as-is and never decrypts.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";

import type { DbHandle } from "../db/index.js";
import { principalFromRequest } from "../auth/principal.js";
import { appendAudit } from "../auth/audit.js";
import { readJsonBody, sendError, sendJson } from "../http/respond.js";
import type { HttpRequest, HttpResponse, ParrotConfig } from "../types.js";

export interface ConvCtx {
  cfg: ParrotConfig;
  db: DbHandle;
}

const createConvSchema = z.object({
  title: z.string().max(200).optional(),
  encryptedTitle: z.string().max(8192).optional(),
  wrappedConversationKey: z.string().min(16),
});

const appendMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system", "tool"]),
  ciphertext: z.string().min(1).max(1_000_000),
  meta: z.record(z.unknown()).optional(),
});

export async function listConversations(ctx: ConvCtx, req: HttpRequest, res: HttpResponse): Promise<void> {
  let principal;
  try {
    principal = await principalFromRequest(ctx.cfg, req);
  } catch (e) {
    sendError(res, 401, "unauthorized", (e as Error).message);
    return;
  }

  const t = ctx.db.schema.conversations;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (await (ctx.db.drizzle as any)
    .select()
    .from(t)
    .where(and(eq(t.tenantId, principal.tenantId), eq(t.ownerId, principal.userId)))
    .orderBy(desc(t.updatedAt))
    .limit(200)) as Array<{
      id: string;
      title: string | null;
      encryptedTitle: string | null;
      wrappedConversationKey: string;
      createdAt: number;
      updatedAt: number;
      archived: number;
    }>;
  sendJson(res, 200, { conversations: rows });
}

export async function createConversation(ctx: ConvCtx, req: HttpRequest, res: HttpResponse): Promise<void> {
  let principal;
  try {
    principal = await principalFromRequest(ctx.cfg, req);
  } catch (e) {
    sendError(res, 401, "unauthorized", (e as Error).message);
    return;
  }

  const body = await readJsonBody(req).catch((e: Error) => {
    sendError(res, 400, "bad_json", e.message);
    return null;
  });
  if (body === null) return;
  const parsed = createConvSchema.safeParse(body);
  if (!parsed.success) {
    sendError(res, 400, "validation_error", parsed.error.message);
    return;
  }

  const id = randomUUID();
  const now = Date.now();
  const t = ctx.db.schema.conversations;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (ctx.db.drizzle as any).insert(t).values({
    id,
    tenantId: principal.tenantId,
    ownerId: principal.userId,
    title: parsed.data.title ?? null,
    encryptedTitle: parsed.data.encryptedTitle ?? null,
    wrappedConversationKey: parsed.data.wrappedConversationKey,
    createdAt: now,
    updatedAt: now,
    archived: 0,
  });

  await appendAudit(ctx.db, ctx.cfg, {
    tenantId: principal.tenantId,
    actorId: principal.userId,
    action: "conversation.create",
    resource: id,
  });

  sendJson(res, 201, { conversation: { id, createdAt: now, updatedAt: now } });
}

export async function listMessages(ctx: ConvCtx, req: HttpRequest, res: HttpResponse, conversationId: string): Promise<void> {
  let principal;
  try {
    principal = await principalFromRequest(ctx.cfg, req);
  } catch (e) {
    sendError(res, 401, "unauthorized", (e as Error).message);
    return;
  }

  const conv = await loadOwnedConversation(ctx.db, conversationId, principal.userId, principal.tenantId);
  if (!conv) {
    sendError(res, 404, "not_found", "Conversation not found.");
    return;
  }

  const m = ctx.db.schema.messages;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (await (ctx.db.drizzle as any)
    .select()
    .from(m)
    .where(eq(m.conversationId, conversationId))
    .orderBy(asc(m.createdAt))
    .limit(1000)) as Array<{ id: string; role: string; ciphertext: string; meta: string | null; createdAt: number }>;
  sendJson(res, 200, { messages: rows });
}

export async function appendMessage(ctx: ConvCtx, req: HttpRequest, res: HttpResponse, conversationId: string): Promise<void> {
  let principal;
  try {
    principal = await principalFromRequest(ctx.cfg, req);
  } catch (e) {
    sendError(res, 401, "unauthorized", (e as Error).message);
    return;
  }

  const conv = await loadOwnedConversation(ctx.db, conversationId, principal.userId, principal.tenantId);
  if (!conv) {
    sendError(res, 404, "not_found", "Conversation not found.");
    return;
  }

  const body = await readJsonBody(req).catch((e: Error) => {
    sendError(res, 400, "bad_json", e.message);
    return null;
  });
  if (body === null) return;
  const parsed = appendMessageSchema.safeParse(body);
  if (!parsed.success) {
    sendError(res, 400, "validation_error", parsed.error.message);
    return;
  }

  const id = randomUUID();
  const now = Date.now();
  const m = ctx.db.schema.messages;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (ctx.db.drizzle as any).insert(m).values({
    id,
    conversationId,
    tenantId: principal.tenantId,
    role: parsed.data.role,
    ciphertext: parsed.data.ciphertext,
    meta: parsed.data.meta ? JSON.stringify(parsed.data.meta) : null,
    createdAt: now,
  });

  // Touch conversation updatedAt
  const c = ctx.db.schema.conversations;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (ctx.db.drizzle as any).update(c).set({ updatedAt: now }).where(eq(c.id, conversationId));

  await appendAudit(ctx.db, ctx.cfg, {
    tenantId: principal.tenantId,
    actorId: principal.userId,
    action: "message.append",
    resource: conversationId,
    payload: { role: parsed.data.role, bytes: parsed.data.ciphertext.length },
  });

  sendJson(res, 201, { message: { id, createdAt: now } });
}

async function loadOwnedConversation(
  db: DbHandle,
  conversationId: string,
  userId: string,
  tenantId: string,
): Promise<{ id: string } | null> {
  const t = db.schema.conversations;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (await (db.drizzle as any)
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.id, conversationId), eq(t.ownerId, userId), eq(t.tenantId, tenantId)))
    .limit(1)) as Array<{ id: string }>;
  return rows[0] ?? null;
}
