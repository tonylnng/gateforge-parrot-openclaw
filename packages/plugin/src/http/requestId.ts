/**
 * Per-request trace ID + cheap response-header decorator.
 *
 * Generates an opaque request ID for every inbound request and exposes it
 * on the response as `X-Parrot-Request-Id`. Handlers can read the ID off
 * the request object (set via `attachRequestId`) and surface it in error
 * envelopes for support routing.
 *
 * The ID is also used as the rate-limit bucket label when neither an API
 * key nor a JWT principal is present (rare — only public routes).
 */
import { randomUUID } from "node:crypto";
import type { HttpRequest, HttpResponse } from "../types.js";

const REQ_ID_KEY = Symbol.for("gateforge.parrot.requestId");

/** Attach a fresh request ID and emit the response header. Idempotent. */
export function attachRequestId(req: HttpRequest, res: HttpResponse): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const existing = (req as any)[REQ_ID_KEY] as string | undefined;
  if (existing) return existing;
  const id = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (req as any)[REQ_ID_KEY] = id;
  try {
    res.setHeader("X-Parrot-Request-Id", id);
  } catch {
    /* response already started — best effort */
  }
  return id;
}

/** Read the request ID if previously attached, otherwise return undefined. */
export function getRequestId(req: HttpRequest): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (req as any)[REQ_ID_KEY];
}
