/**
 * HTTP response helpers and a tiny JSON body reader.
 */
import type { HttpRequest, HttpResponse } from "../types.js";

export function sendJson(res: HttpResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(payload);
}

export function sendError(
  res: HttpResponse,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
  requestId?: string,
): void {
  const errBody: Record<string, unknown> = { code, message };
  if (details) errBody.details = details;
  if (requestId) errBody.requestId = requestId;
  sendJson(res, status, { error: errBody });
}

/** Read the full request body (max 1 MiB by default) and parse as JSON. */
export async function readJsonBody<T = unknown>(req: HttpRequest, maxBytes = 1_048_576): Promise<T> {
  const chunks: Buffer[] = [];
  let received = 0;
  return new Promise<T>((resolve, reject) => {
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        reject(new Error("payload too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({} as T);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T);
      } catch (e) {
        reject(new Error(`invalid JSON: ${(e as Error).message}`));
      }
    });
    req.on("error", reject);
  });
}

export function applyCors(res: HttpResponse, origin?: string): void {
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");
}
