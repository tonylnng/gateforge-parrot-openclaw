/**
 * In-memory token-bucket rate limiter.
 *
 * Two buckets are checked on every authenticated request:
 *   1. per-API-key (or per-JWT-jti)
 *   2. per-tenant
 *
 * If either is empty, the request is rejected with 429. Both buckets refill
 * linearly at `refillPerSec` and are capped at `capacity`.
 *
 * The limiter is in-memory only — restart resets the buckets. For multi-process
 * deployments this should be replaced with a Redis-backed implementation, but
 * a single-process plugin sees consistent state.
 *
 * Limits are configurable per the plugin's `api.rateLimit` block. We translate
 * `{ windowMs, maxRequests }` into a sustained rate (maxRequests / windowMs).
 */
import { sendError } from "./respond.js";
import type { HttpResponse, ParrotConfig, Principal } from "../types.js";

interface Bucket {
  tokens: number;
  updatedAt: number;
}

interface LimiterConfig {
  capacity: number;
  refillPerSec: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(private cfg: LimiterConfig) {}

  /** Attempt to consume one token from `key`. Returns true on success. */
  consume(key: string, weight = 1): { allowed: boolean; remaining: number; retryAfterMs: number } {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket) {
      const tokens = this.cfg.capacity - weight;
      this.buckets.set(key, { tokens, updatedAt: now });
      return { allowed: tokens >= 0, remaining: Math.max(0, tokens), retryAfterMs: 0 };
    }

    const elapsedMs = now - bucket.updatedAt;
    const refilled = Math.min(this.cfg.capacity, bucket.tokens + (elapsedMs / 1000) * this.cfg.refillPerSec);
    bucket.tokens = refilled;
    bucket.updatedAt = now;

    if (refilled < weight) {
      const deficit = weight - refilled;
      const retryAfterMs = Math.ceil((deficit / this.cfg.refillPerSec) * 1000);
      return { allowed: false, remaining: Math.max(0, Math.floor(refilled)), retryAfterMs };
    }
    bucket.tokens -= weight;
    return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
  }

  /** Periodic cleanup of stale buckets. */
  prune(maxAgeMs = 10 * 60 * 1000): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [key, bucket] of this.buckets) {
      if (bucket.updatedAt < cutoff && bucket.tokens >= this.cfg.capacity) {
        this.buckets.delete(key);
      }
    }
  }
}

/** Build limiters from plugin config. */
export function makeLimiters(cfg: ParrotConfig): { perKey: RateLimiter; perTenant: RateLimiter } {
  const windowSec = Math.max(1, cfg.api.rateLimit.windowMs / 1000);
  const perKeyRate = cfg.api.rateLimit.maxRequests / windowSec;
  // Tenants get a 10× higher burst because many keys can share one tenant.
  const perTenantRate = perKeyRate * 10;
  return {
    perKey: new RateLimiter({ capacity: cfg.api.rateLimit.maxRequests, refillPerSec: perKeyRate }),
    perTenant: new RateLimiter({ capacity: cfg.api.rateLimit.maxRequests * 10, refillPerSec: perTenantRate }),
  };
}

/**
 * Apply both buckets and write a 429 if either is exhausted. Returns true when
 * the request should continue.
 */
export function applyRateLimit(
  limiters: { perKey: RateLimiter; perTenant: RateLimiter },
  principal: Principal,
  res: HttpResponse,
  cfg?: ParrotConfig,
): boolean {
  const capacity = cfg?.api.rateLimit.maxRequests ?? 0;
  const perKey = limiters.perKey.consume(`k:${principal.jti}`);
  if (!perKey.allowed) {
    const retryAfterSec = Math.ceil(perKey.retryAfterMs / 1000);
    const resetEpoch = Math.ceil(Date.now() / 1000) + retryAfterSec;
    res.setHeader("Retry-After", String(retryAfterSec));
    res.setHeader("X-RateLimit-Scope", "key");
    if (capacity) res.setHeader("X-RateLimit-Limit", String(capacity));
    res.setHeader("X-RateLimit-Remaining", "0");
    res.setHeader("X-RateLimit-Reset", String(resetEpoch));
    sendError(res, 429, "rate_limited", "API key rate limit exceeded. Slow down.");
    return false;
  }
  const perTenant = limiters.perTenant.consume(`t:${principal.tenantId}`);
  if (!perTenant.allowed) {
    const retryAfterSec = Math.ceil(perTenant.retryAfterMs / 1000);
    const resetEpoch = Math.ceil(Date.now() / 1000) + retryAfterSec;
    res.setHeader("Retry-After", String(retryAfterSec));
    res.setHeader("X-RateLimit-Scope", "tenant");
    if (capacity) res.setHeader("X-RateLimit-Limit", String(capacity * 10));
    res.setHeader("X-RateLimit-Remaining", "0");
    res.setHeader("X-RateLimit-Reset", String(resetEpoch));
    sendError(res, 429, "rate_limited", "Tenant rate limit exceeded. Try again shortly.");
    return false;
  }
  // Standard headers (RFC draft) — reflect the tighter per-key bucket.
  if (capacity) res.setHeader("X-RateLimit-Limit", String(capacity));
  res.setHeader("X-RateLimit-Remaining", String(perKey.remaining));
  // Approximate reset: how long until the per-key bucket is full again at the
  // configured refill rate. For an unfilled bucket this is the time to refill
  // one token; for a near-empty bucket it scales linearly. We expose the
  // window-end seconds since epoch for client back-off calculations.
  const windowSec = cfg ? Math.max(1, cfg.api.rateLimit.windowMs / 1000) : 60;
  res.setHeader("X-RateLimit-Reset", String(Math.ceil(Date.now() / 1000) + windowSec));
  // Legacy detail headers preserved for existing clients.
  res.setHeader("X-RateLimit-Remaining-Key", String(perKey.remaining));
  res.setHeader("X-RateLimit-Remaining-Tenant", String(perTenant.remaining));
  return true;
}
