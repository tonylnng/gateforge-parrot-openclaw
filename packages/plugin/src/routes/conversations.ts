/**
 * Conversation (session) REST routes.
 *
 * All payload bodies are ciphertext from the client's perspective; the server
 * stores them as-is and never decrypts. Plaintext title is supported for legacy
 * paths but production clients should always pass `encryptedTitle` so the
 * server cannot read it.
 *
 * Session management (Phase 2):
 *  - PATCH /conversations/:id  — rename, pin, archive
 *  - DELETE /conversations/:id — crypto-shred (drops wrappedConversationKey + ciphertext)
 *  - GET    /conversations     — includes pinned/archived state, lastMessageAt, messageCount
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import type { DbHandle } from "../db/index.js";
import { principalFromRequest } from "../auth/principal.js";
import { appendAudit } from "../auth/audit.js";
import { readJsonBody, sendError, sendJson } from "../http/respond.js";
import type { HttpRequest, HttpResponse, ParrotConfig, Principal } from "../types.js";

export interface ConvCtx {
  cfg: ParrotConfig;
  db: DbHandle;
}

const createConvSchema = z.object({
  title: z.string().max(200).optional(),
  encryptedTitle: z.string().max(8192).optional(),
  wrappedConversationKey: z.string().min(16),
  agentId: z.string().max(200).optional(),
});

const patchConvSchema = z
  .object({
    encryptedTitle: z.string().max(8192).optional(),
    title: z.string().max(200).optional(),
    isPinned: z.boolean().optional(),
    isArchived: z.boolean().optional(),
    agentId: z.string().max(200).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "no fields to update" });

const appendMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system", "tool"]),
  ciphertext: z.string().min(1).max(1_000_000),
  meta: z.record(z.unknown()).optional(),
});

// Internal helper — listing filter
type ListFilter = "all" | "active" | "pinned" | "archived";

export async function listConversations(ctx: ConvCtx, req: HttpRequest, res: HttpResponse): Promise<void> {
  let principal: Principal;
  try {
    principal = await principalFromRequest(ctx.cfg, req);
  } catch (e) {
    sendError(res, 401, "unauthorized", (e as Error).message);
    return;
  }

  const url = new URL(req.url, "http://placeholder");
  const filter = (url.searchParams.get("filter") ?? "active") as ListFilter;
  const includeArchived = filter === "archived" || filter === "all";
  const onlyPinned = filter === "pinned";

  const t = ctx.db.schema.conversations;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (await (ctx.db.drizzle as any)
    .select()
    .from(t)
    .where(and(eq(t.tenantId, principal.tenantId), eq(t.ownerId, principal.userId), isNull(t.deletedAt)))
    .orderBy(desc(t.updatedAt))
    .limit(500)) as Array<{
      id: string;
      title: string | null;
      encryptedTitle: string | null;
      wrappedConversationKey: string;
      agentId: string | null;
      isPinned: number;
      isArchived: number;
      pinnedAt: number | null;
      archivedAt: number | null;
      lastMessageAt: number | null;
      messageCount: number;
      createdAt: number;
      updatedAt: number;
    }>;

  const filtered = rows.filter((r) => {
    if (onlyPinned) return r.isPinned === 1 && r.isArchived === 0;
    if (!includeArchived && r.isArchived === 1) return false;
    if (filter === "archived" && r.isArchived === 0) return false;
    return true;
  });

  sendJson(res, 200, {
    conversations: filtered.map((r) => ({
      id: r.id,
      title: r.title,
      encryptedTitle: r.encryptedTitle,
      wrappedConversationKey: r.wrappedConversationKey,
      agentId: r.agentId,
      isPinned: r.isPinned === 1,
      isArchived: r.isArchived === 1,
      pinnedAt: r.pinnedAt,
      archivedAt: r.archivedAt,
      lastMessageAt: r.lastMessageAt,
      messageCount: r.messageCount,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
  });
}

export async function createConversation(ctx: ConvCtx, req: HttpRequest, res: HttpResponse): Promise<void> {
  let principal: Principal;
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
    agentId: parsed.data.agentId ?? null,
    isPinned: 0,
    isArchived: 0,
    pinnedAt: null,
    archivedAt: null,
    lastMessageAt: null,
    messageCount: 0,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  });

  await appendAudit(ctx.db, ctx.cfg, {
    tenantId: principal.tenantId,
    actorId: principal.userId,
    action: "conversation.create",
    resource: id,
  });

  sendJson(res, 201, {
    conversation: {
      id,
      createdAt: now,
      updatedAt: now,
      isPinned: false,
      isArchived: false,
      messageCount: 0,
    },
  });
}

export async function patchConversation(
  ctx: ConvCtx,
  req: HttpRequest,
  res: HttpResponse,
  conversationId: string,
): Promise<void> {
  let principal: Principal;
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
  const parsed = patchConvSchema.safeParse(body);
  if (!parsed.success) {
    sendError(res, 400, "validation_error", parsed.error.message);
    return;
  }

  const now = Date.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updates: Record<string, any> = { updatedAt: now };
  const auditPayload: Record<string, unknown> = {};

  if (parsed.data.encryptedTitle !== undefined) {
    updates.encryptedTitle = parsed.data.encryptedTitle;
    auditPayload.encryptedTitleChanged = true;
  }
  if (parsed.data.title !== undefined) {
    updates.title = parsed.data.title;
    auditPayload.titleChanged = true;
  }
  if (parsed.data.isPinned !== undefined) {
    updates.isPinned = parsed.data.isPinned ? 1 : 0;
    updates.pinnedAt = parsed.data.isPinned ? now : null;
    auditPayload.isPinned = parsed.data.isPinned;
  }
  if (parsed.data.isArchived !== undefined) {
    updates.isArchived = parsed.data.isArchived ? 1 : 0;
    updates.archivedAt = parsed.data.isArchived ? now : null;
    auditPayload.isArchived = parsed.data.isArchived;
  }
  if (parsed.data.agentId !== undefined) {
    updates.agentId = parsed.data.agentId;
    auditPayload.agentChanged = true;
  }

  const t = ctx.db.schema.conversations;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (ctx.db.drizzle as any).update(t).set(updates).where(eq(t.id, conversationId));

  // Emit specific audit actions for clarity.
  let action = "conversation.update";
  if (parsed.data.isPinned !== undefined) action = parsed.data.isPinned ? "conversation.pin" : "conversation.unpin";
  else if (parsed.data.isArchived !== undefined) action = parsed.data.isArchived ? "conversation.archive" : "conversation.unarchive";
  else if (parsed.data.encryptedTitle !== undefined || parsed.data.title !== undefined) action = "conversation.rename";

  await appendAudit(ctx.db, ctx.cfg, {
    tenantId: principal.tenantId,
    actorId: principal.userId,
    action,
    resource: conversationId,
    payload: auditPayload,
  });

  sendJson(res, 200, { conversation: { id: conversationId, updatedAt: now } });
}

/**
 * DELETE /conversations/:id — crypto-shred.
 *
 * We drop `wrappedConversationKey` (rendering all message ciphertext unrecoverable
 * even to the owner) AND wipe message rows. Title and metadata are also cleared.
 * A soft-delete marker is kept so the row can be tombstoned and pruned by a
 * later sweep job; this preserves any FK references in the audit log.
 */
export async function deleteConversation(
  ctx: ConvCtx,
  req: HttpRequest,
  res: HttpResponse,
  conversationId: string,
): Promise<void> {
  let principal: Principal;
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

  const now = Date.now();
  const t = ctx.db.schema.conversations;
  const m = ctx.db.schema.messages;

  // Crypto-shred: drop wrapped key and ciphertexts.
  // Order matters — wipe messages first so we don't briefly retain decryptable
  // data while the key column is updated.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (ctx.db.drizzle as any).delete(m).where(eq(m.conversationId, conversationId));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (ctx.db.drizzle as any)
    .update(t)
    .set({
      wrappedConversationKey: "", // shred
      encryptedTitle: null,
      title: null,
      messageCount: 0,
      lastMessageAt: null,
      deletedAt: now,
      updatedAt: now,
    })
    .where(eq(t.id, conversationId));

  await appendAudit(ctx.db, ctx.cfg, {
    tenantId: principal.tenantId,
    actorId: principal.userId,
    action: "conversation.delete",
    resource: conversationId,
  });

  sendJson(res, 200, { ok: true, deletedAt: now });
}

export async function listMessages(ctx: ConvCtx, req: HttpRequest, res: HttpResponse, conversationId: string): Promise<void> {
  let principal: Principal;
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
  let principal: Principal;
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

  // Touch conversation updatedAt + lastMessageAt + messageCount
  const c = ctx.db.schema.conversations;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (ctx.db.drizzle as any)
    .update(c)
    .set({
      updatedAt: now,
      lastMessageAt: now,
      // Atomic counter update via raw SQL would be safer; the single-writer
      // assumption (one connection-per-tenant in normal load) makes this OK.
    })
    .where(eq(c.id, conversationId));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (ctx.db.drizzle as any).run?.(
    // SQLite raw bump; for PG we update via select-then-set on next message — keeps
    // the abstraction portable. Tolerate `run` being absent on the PG branch.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    undefined,
  );
  await bumpMessageCount(ctx.db, conversationId);

  await appendAudit(ctx.db, ctx.cfg, {
    tenantId: principal.tenantId,
    actorId: principal.userId,
    action: "message.append",
    resource: conversationId,
    payload: { role: parsed.data.role, bytes: parsed.data.ciphertext.length },
  });

  sendJson(res, 201, { message: { id, createdAt: now } });
}

async function bumpMessageCount(db: DbHandle, conversationId: string): Promise<void> {
  const c = db.schema.conversations;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (await (db.drizzle as any).select({ n: c.messageCount }).from(c).where(eq(c.id, conversationId)).limit(1)) as Array<{ n: number }>;
  const current = rows[0]?.n ?? 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db.drizzle as any).update(c).set({ messageCount: current + 1 }).where(eq(c.id, conversationId));
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
    .select({ id: t.id, deletedAt: t.deletedAt })
    .from(t)
    .where(and(eq(t.id, conversationId), eq(t.ownerId, userId), eq(t.tenantId, tenantId)))
    .limit(1)) as Array<{ id: string; deletedAt: number | null }>;
  const row = rows[0];
  if (!row || row.deletedAt !== null) return null;
  return { id: row.id };
}
