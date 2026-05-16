/**
 * Webhook dispatcher.
 *
 * Strict metadata-only payloads. NEVER include plaintext content. Per the
 * design doc, deliverable events carry just IDs, timestamps, and counts so the
 * server (and webhook subscribers) cannot infer chat content.
 *
 * Delivery model:
 *   - HMAC-SHA256 signature over "{timestamp}.{rawBody}" using the webhook's
 *     per-row secret. Header: `X-Parrot-Signature: t=<unix>,v1=<hex>`.
 *   - Exponential backoff schedule: 0s, 30s, 2m, 10m, 30m, 1h, 4h, 12h.
 *   - Max 8 attempts within 24h; after that the row is marked `last_error` and
 *     dropped from the pending queue.
 *   - Subscriptions are auto-disabled after `disableAfterConsecutiveFailures`
 *     consecutive failures.
 */
import { createHmac, randomUUID } from "node:crypto";
import { and, asc, eq, lte } from "drizzle-orm";

import type { DbHandle } from "../db/index.js";
import type { ParrotLogger } from "../types.js";

/** Canonical event types. */
export const WEBHOOK_EVENTS = [
  "session.created",
  "session.renamed",
  "session.archived",
  "session.deleted",
  "message.received",
  "message.completed",
  "message.failed",
  "apikey.used",
  "apikey.revoked",
  "audit.alert",
  "webhook.ping",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Schedule (seconds from first attempt) for retries. */
const RETRY_DELAYS_SEC = [0, 30, 2 * 60, 10 * 60, 30 * 60, 60 * 60, 4 * 60 * 60, 12 * 60 * 60];
const MAX_ATTEMPTS = RETRY_DELAYS_SEC.length;
const AUTO_DISABLE_FAILURES = 12;
const DELIVERY_TIMEOUT_MS = 10_000;

/** Sign a webhook delivery. */
export function signWebhook(secret: string, timestamp: number, rawBody: string): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

export interface EnqueueArgs {
  tenantId: string;
  event: WebhookEvent;
  /** Metadata payload — must NEVER include plaintext content. */
  payload: Record<string, unknown>;
}

/**
 * Enqueue a webhook event for every subscribed webhook in the tenant whose
 * `events` array includes the event type. Each subscription gets its own
 * delivery row. The dispatcher loop picks them up on its next tick.
 */
export async function enqueueEvent(db: DbHandle, args: EnqueueArgs, logger: ParrotLogger): Promise<void> {
  const w = db.schema.webhooks;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const subs = (await (db.drizzle as any)
    .select()
    .from(w)
    .where(and(eq(w.tenantId, args.tenantId), eq(w.enabled, 1)))
    .limit(200)) as Array<{ id: string; events: string }>;

  if (subs.length === 0) return;

  const matching = subs.filter((s) => {
    try {
      const list = JSON.parse(s.events);
      return Array.isArray(list) && (list.includes(args.event) || list.includes("*"));
    } catch {
      return false;
    }
  });
  if (matching.length === 0) return;

  const now = Date.now();
  const d = db.schema.webhookDeliveries;
  for (const sub of matching) {
    const id = randomUUID();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db.drizzle as any).insert(d).values({
      id,
      webhookId: sub.id,
      eventType: args.event,
      payload: JSON.stringify({
        id,
        event: args.event,
        createdAt: now,
        data: args.payload,
      }),
      attempt: 1,
      responseCode: null,
      deliveredAt: null,
      nextRetryAt: now, // ready immediately
      lastError: null,
      createdAt: now,
    });
  }
  logger.debug("webhook enqueued", { event: args.event, fanout: matching.length });
}

/**
 * Worker tick — process all deliveries whose `nextRetryAt` has elapsed.
 * Returns the number of rows attempted.
 */
export async function dispatchDue(db: DbHandle, logger: ParrotLogger, limit = 50): Promise<number> {
  const now = Date.now();
  const d = db.schema.webhookDeliveries;
  const w = db.schema.webhooks;

  // Fetch due deliveries — those with nextRetryAt <= now and not yet delivered.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const due = (await (db.drizzle as any)
    .select()
    .from(d)
    .where(lte(d.nextRetryAt, now))
    .orderBy(asc(d.nextRetryAt))
    .limit(limit)) as Array<{
      id: string;
      webhookId: string;
      eventType: string;
      payload: string;
      attempt: number;
      deliveredAt: number | null;
      nextRetryAt: number | null;
      createdAt: number;
    }>;

  const ready = due.filter((row) => row.deliveredAt === null);
  let count = 0;
  for (const row of ready) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const subs = (await (db.drizzle as any)
      .select({ url: w.url, secret: w.secret, enabled: w.enabled, consecutiveFailures: w.consecutiveFailures })
      .from(w)
      .where(eq(w.id, row.webhookId))
      .limit(1)) as Array<{ url: string; secret: string; enabled: number; consecutiveFailures: number }>;
    const sub = subs[0];
    if (!sub || sub.enabled !== 1) {
      // Subscription gone — mark delivered with terminal state.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db.drizzle as any)
        .update(d)
        .set({ lastError: "subscription_disabled", nextRetryAt: null, deliveredAt: now })
        .where(eq(d.id, row.id));
      continue;
    }

    count += 1;
    const timestamp = Math.floor(Date.now() / 1000);
    const sig = signWebhook(sub.secret, timestamp, row.payload);

    let ok = false;
    let responseCode: number | null = null;
    let error: string | null = null;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), DELIVERY_TIMEOUT_MS);
      try {
        const resp = await fetch(sub.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "GateForge-Parrot-Webhook/1.0",
            "X-Parrot-Event": row.eventType,
            "X-Parrot-Delivery": row.id,
            "X-Parrot-Signature": sig,
          },
          body: row.payload,
          signal: ctrl.signal,
        });
        responseCode = resp.status;
        ok = resp.status >= 200 && resp.status < 300;
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      error = (e as Error).message.slice(0, 500);
    }

    if (ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db.drizzle as any)
        .update(d)
        .set({ responseCode, deliveredAt: Date.now(), nextRetryAt: null, lastError: null })
        .where(eq(d.id, row.id));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db.drizzle as any).update(w).set({ lastDeliveryAt: Date.now(), consecutiveFailures: 0 }).where(eq(w.id, row.webhookId));
      continue;
    }

    // Failure path — schedule next retry or terminate.
    const nextAttempt = row.attempt + 1;
    if (nextAttempt > MAX_ATTEMPTS) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db.drizzle as any)
        .update(d)
        .set({ responseCode, lastError: error ?? `http_${responseCode}`, nextRetryAt: null, deliveredAt: Date.now() })
        .where(eq(d.id, row.id));
      logger.warn("webhook giving up", { id: row.id, attempt: row.attempt, code: responseCode });
    } else {
      const delaySec = RETRY_DELAYS_SEC[Math.min(nextAttempt - 1, RETRY_DELAYS_SEC.length - 1)];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db.drizzle as any)
        .update(d)
        .set({
          attempt: nextAttempt,
          responseCode,
          lastError: error ?? `http_${responseCode}`,
          nextRetryAt: Date.now() + delaySec * 1000,
        })
        .where(eq(d.id, row.id));
    }

    const newFailures = sub.consecutiveFailures + 1;
    const willDisable = newFailures >= AUTO_DISABLE_FAILURES;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db.drizzle as any)
      .update(w)
      .set(
        willDisable
          ? { consecutiveFailures: newFailures, enabled: 0, disabledAt: Date.now() }
          : { consecutiveFailures: newFailures },
      )
      .where(eq(w.id, row.webhookId));
    if (willDisable) logger.warn("webhook auto-disabled", { webhookId: row.webhookId, consecutiveFailures: newFailures });
  }
  return count;
}

/**
 * Start a periodic dispatch loop. Returns a stop function. Safe to call once
 * during plugin bootstrap.
 */
export function startDispatcher(db: DbHandle, logger: ParrotLogger, intervalMs = 5_000): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await dispatchDue(db, logger);
    } catch (e) {
      logger.error("webhook dispatcher tick failed", { error: (e as Error).message });
    } finally {
      if (!stopped) timer = setTimeout(tick, intervalMs);
    }
  };
  timer = setTimeout(tick, intervalMs);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
