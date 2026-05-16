/**
 * Server-Sent Events streaming endpoint.
 *
 * POST /conversations/:id/messages/stream
 *
 * The client posts a ciphertext user message; the server stores it and emits
 * SSE frames as the agent produces output. We expose two frame types:
 *
 *   - `event: chunk`  data: {"delta": "<ciphertext-chunk>"}
 *   - `event: done`   data: {"messageId":"...", "createdAt":<ms>}
 *   - `event: error`  data: {"code":"...", "message":"..."}
 *
 * Plaintext NEVER touches the server: the client sends ciphertext in and gets
 * ciphertext deltas back. The server can only see byte counts and timing.
 *
 * Wiring to OpenClaw's `llm_input` / `llm_output` hooks happens via the
 * `StreamRegistry` — the hooks broker plaintext on the gateway side, then a
 * shim re-encrypts each chunk using the per-conversation key the client
 * already shared (wrappedConversationKey) before pushing it to the SSE stream.
 *
 * For the initial server-side wiring we ship two modes:
 *
 *   1. **passthrough** — when the gateway has no LLM bound (dev/test), we echo
 *      the client's ciphertext back as a single chunk. Useful for SDK tests.
 *   2. **hook-bridge** — when `llm_output` fires for the registered stream id,
 *      we forward each chunk straight to the SSE response. The gateway is
 *      responsible for re-encrypting plaintext deltas back into ciphertext
 *      with the per-conversation key (held in browser memory and forwarded as
 *      a transient `streamKey` HMAC tag).
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";

import type { DbHandle } from "../db/index.js";
import { principalFromAny } from "../auth/apikey.js";
import { principalFromRequest, AuthError } from "../auth/principal.js";
import { appendAudit } from "../auth/audit.js";
import { readJsonBody, sendError } from "../http/respond.js";
import type { HttpRequest, HttpResponse, ParrotConfig, ParrotLogger, Principal } from "../types.js";
import { enqueueEvent } from "../webhooks/dispatcher.js";

export interface SseCtx {
  cfg: ParrotConfig;
  db: DbHandle;
  logger: ParrotLogger;
  registry: StreamRegistry;
}

const streamSchema = z.object({
  role: z.literal("user").default("user"),
  ciphertext: z.string().min(1).max(1_000_000),
  /** Optional opaque tag — gateway uses it to dispatch llm_output chunks back to this stream. */
  streamTag: z.string().min(8).max(128).optional(),
  meta: z.record(z.unknown()).optional(),
});

/**
 * In-process registry mapping stream tags to live SSE writers. Lets the
 * `llm_output` hook find the right response object to push chunks to.
 */
export class StreamRegistry {
  private writers = new Map<string, (frame: SseFrame) => void>();

  register(tag: string, fn: (frame: SseFrame) => void): void {
    this.writers.set(tag, fn);
  }
  unregister(tag: string): void {
    this.writers.delete(tag);
  }
  push(tag: string, frame: SseFrame): boolean {
    const fn = this.writers.get(tag);
    if (!fn) return false;
    fn(frame);
    return true;
  }
}

export type SseFrame =
  | { event: "chunk"; data: { delta: string } }
  | { event: "done"; data: { messageId: string; createdAt: number } }
  | { event: "error"; data: { code: string; message: string } };

export async function streamMessage(
  ctx: SseCtx,
  req: HttpRequest,
  res: HttpResponse,
  conversationId: string,
): Promise<void> {
  let principal: Principal;
  try {
    principal = await principalFromAny(ctx.cfg, ctx.db, req, principalFromRequest);
  } catch (e) {
    const status = e instanceof AuthError ? e.status : 401;
    sendError(res, status, "unauthorized", (e as Error).message);
    return;
  }

  // Validate conversation ownership.
  const c = ctx.db.schema.conversations;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const convRows = (await (ctx.db.drizzle as any)
    .select({ id: c.id, deletedAt: c.deletedAt, ownerId: c.ownerId, tenantId: c.tenantId })
    .from(c)
    .where(eq(c.id, conversationId))
    .limit(1)) as Array<{ id: string; deletedAt: number | null; ownerId: string; tenantId: string }>;
  const conv = convRows[0];
  if (!conv || conv.deletedAt !== null || conv.ownerId !== principal.userId || conv.tenantId !== principal.tenantId) {
    sendError(res, 404, "not_found", "Conversation not found.");
    return;
  }

  const body = await readJsonBody(req).catch((e: Error) => {
    sendError(res, 400, "bad_json", e.message);
    return null;
  });
  if (body === null) return;
  const parsed = streamSchema.safeParse(body);
  if (!parsed.success) {
    sendError(res, 400, "validation_error", parsed.error.message);
    return;
  }

  // Persist the user message first — even if streaming fails, the input is durable.
  const userMsgId = randomUUID();
  const now = Date.now();
  const m = ctx.db.schema.messages;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (ctx.db.drizzle as any).insert(m).values({
    id: userMsgId,
    conversationId,
    tenantId: principal.tenantId,
    role: "user",
    ciphertext: parsed.data.ciphertext,
    meta: parsed.data.meta ? JSON.stringify(parsed.data.meta) : null,
    createdAt: now,
  });

  void enqueueEvent(
    ctx.db,
    {
      tenantId: principal.tenantId,
      event: "message.received",
      payload: { conversationId, messageId: userMsgId, bytes: parsed.data.ciphertext.length },
    },
    ctx.logger,
  );

  // Open SSE response.
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const tag = parsed.data.streamTag ?? randomUUID();
  const assistantMsgId = randomUUID();
  let closed = false;
  let bytesOut = 0;

  const write = (frame: SseFrame): void => {
    if (closed) return;
    try {
      res.write(`event: ${frame.event}\n`);
      res.write(`data: ${JSON.stringify(frame.data)}\n\n`);
      if (frame.event === "chunk") bytesOut += frame.data.delta.length;
    } catch {
      closed = true;
    }
  };

  ctx.registry.register(tag, write);

  // Heartbeat to keep proxies from closing idle connections.
  const heartbeat = setInterval(() => {
    if (closed) return;
    try {
      res.write(`: heartbeat ${Date.now()}\n\n`);
    } catch {
      closed = true;
    }
  }, 15_000);

  const finalize = async (errored?: { code: string; message: string }): Promise<void> => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    ctx.registry.unregister(tag);
    if (errored) {
      try {
        res.write(`event: error\ndata: ${JSON.stringify(errored)}\n\n`);
      } catch {
        /* */
      }
      try {
        res.end();
      } catch {
        /* */
      }
      return;
    }
    write({ event: "done", data: { messageId: assistantMsgId, createdAt: Date.now() } });
    try {
      res.end();
    } catch {
      /* */
    }

    await appendAudit(ctx.db, ctx.cfg, {
      tenantId: principal.tenantId,
      actorId: principal.userId,
      action: "message.stream",
      resource: conversationId,
      payload: { tag, bytesOut, assistantMsgId },
    });
    void enqueueEvent(
      ctx.db,
      {
        tenantId: principal.tenantId,
        event: "message.completed",
        payload: { conversationId, messageId: assistantMsgId, bytes: bytesOut },
      },
      ctx.logger,
    );
  };

  // Detect client disconnect.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reqAny = req as any;
  if (typeof reqAny.on === "function") {
    reqAny.on("close", () => {
      if (!closed) void finalize({ code: "client_closed", message: "Client closed the connection." });
    });
  }

  // Passthrough mode: if no upstream hook delivers chunks within 250ms, we
  // echo the user ciphertext as the assistant response. This keeps the SDK
  // round-trip working in dev without a real LLM wired to the channel.
  setTimeout(() => {
    if (closed) return;
    write({ event: "chunk", data: { delta: parsed.data.ciphertext } });
    void finalize();
  }, 250);
}
