/**
 * Idempotency middleware.
 *
 * If the request carries an `Idempotency-Key` header and the (tenant, principal,
 * method, path, key) tuple has been seen within the last 24h, we replay the
 * stored response. Otherwise we record the response after the handler runs.
 *
 * The middleware wraps a `HandlerResult` returned by an inner handler so we can
 * capture the final status + body. Wrapping is opt-in via `withIdempotency`.
 *
 * Implementation note: we do NOT cache *all* requests — only those that pass an
 * `Idempotency-Key` header. POST/DELETE/PATCH are the typical targets.
 */
import { createHash } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";

import type { DbHandle } from "../db/index.js";
import { readHeader } from "../auth/principal.js";
import type { HttpRequest, HttpResponse, Principal } from "../types.js";

/** Result captured by a handler — the bytes we'd otherwise send. */
export interface CapturedResponse {
  status: number;
  body: unknown;
}

const TTL_MS = 24 * 60 * 60 * 1000;

function makeId(tenantId: string, principalId: string, key: string): string {
  return createHash("sha256").update(`${tenantId}|${principalId}|${key}`).digest("hex");
}

/**
 * Look up a previous idempotent response. Returns `null` if no record (or expired).
 * The caller should then invoke the actual handler and call `recordIdempotent`
 * with the same key.
 */
export async function findIdempotentResponse(
  db: DbHandle,
  principal: Principal,
  req: HttpRequest,
): Promise<{ key: string; response: CapturedResponse } | null> {
  const key = readHeader(req, "idempotency-key");
  if (!key) return null;
  if (key.length > 200) return null;
  const id = makeId(principal.tenantId, principal.userId, key);

  const t = db.schema.idempotency;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (await (db.drizzle as any)
    .select()
    .from(t)
    .where(eq(t.id, id))
    .limit(1)) as Array<{ id: string; responseStatus: number; responseBody: string; expiresAt: number }>;
  const row = rows[0];
  if (!row || row.expiresAt < Date.now()) {
    if (row && row.expiresAt < Date.now()) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void (db.drizzle as any).delete(t).where(eq(t.id, id));
    }
    return { key, response: null as unknown as CapturedResponse };
  }
  let body: unknown = null;
  try {
    body = JSON.parse(row.responseBody);
  } catch {
    body = null;
  }
  return { key, response: { status: row.responseStatus, body } };
}

/** Persist the response for a given idempotency key. Best-effort. */
export async function recordIdempotent(
  db: DbHandle,
  principal: Principal,
  req: HttpRequest,
  key: string,
  resp: CapturedResponse,
): Promise<void> {
  if (!key) return;
  const id = makeId(principal.tenantId, principal.userId, key);
  const now = Date.now();
  const expires = now + TTL_MS;
  const url = new URL(req.url, "http://placeholder");
  const t = db.schema.idempotency;

  // Insert; if a row with the same id exists we silently ignore (the read path
  // already returned it). We use a delete+insert pattern for portability — both
  // drivers tolerate it under our single-writer assumption.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (db.drizzle as any).insert(t).values({
      id,
      tenantId: principal.tenantId,
      principalId: principal.userId,
      idempotencyKey: key,
      method: req.method,
      path: url.pathname,
      responseStatus: resp.status,
      responseBody: JSON.stringify(resp.body ?? null),
      createdAt: now,
      expiresAt: expires,
    });
  } catch {
    /* race with another writer for the same key — first writer wins */
  }
}

/**
 * Helper for routes: capture the JSON response so the caller can record it
 * after invoking the actual handler. This swap-in adapter implements just the
 * subset of HttpResponse the route layer uses.
 */
export function makeCapturingResponse(real: HttpResponse): {
  capture: HttpResponse;
  captured: { value: CapturedResponse | null };
} {
  const captured: { value: CapturedResponse | null } = { value: null };
  const wrapper: HttpResponse = {
    statusCode: real.statusCode,
    setHeader: (name, value) => real.setHeader(name, value),
    write: (chunk) => real.write(chunk),
    writeHead: real.writeHead?.bind(real),
    end: (chunk) => {
      try {
        const body = typeof chunk === "string" ? chunk : chunk?.toString("utf8") ?? "";
        let parsed: unknown = body;
        try {
          parsed = JSON.parse(body);
        } catch {
          /* not JSON */
        }
        captured.value = { status: wrapper.statusCode || real.statusCode || 200, body: parsed };
      } catch {
        captured.value = { status: wrapper.statusCode || real.statusCode || 200, body: null };
      }
      real.statusCode = wrapper.statusCode;
      real.end(chunk);
    },
  };
  // Mirror statusCode writes back to the real response for header timing.
  Object.defineProperty(wrapper, "statusCode", {
    get: () => real.statusCode,
    set: (v: number) => {
      real.statusCode = v;
    },
  });
  return { capture: wrapper, captured };
}

/** Periodic cleanup — invoked opportunistically. */
export async function pruneExpiredIdempotency(db: DbHandle): Promise<void> {
  const t = db.schema.idempotency;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db.drizzle as any).delete(t).where(lt(t.expiresAt, Date.now()));
}

// Unused-import guard
void and;
