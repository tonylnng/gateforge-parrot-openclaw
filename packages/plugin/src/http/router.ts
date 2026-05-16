/**
 * Tiny router that dispatches HTTP requests on the plugin's mount paths.
 *
 * We deliberately avoid pulling in Express / Fastify — the OpenClaw plugin
 * runtime registers routes one at a time, and we want a minimal surface area.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeStaticHandler } from "./static.js";
import { applyCors, sendError, sendJson } from "./respond.js";
import { handleLogin, handleLogout, handleRefresh, handleSignup, handleWhoami } from "../routes/auth.js";
import {
  appendMessage,
  createConversation,
  deleteConversation,
  listConversations,
  listMessages,
  patchConversation,
} from "../routes/conversations.js";
import { issueApiKey, listApiKeys, revokeApiKey } from "../routes/apikeys.js";
import {
  createWebhook,
  deleteWebhook,
  listWebhooks,
  patchWebhook,
  testWebhook,
} from "../routes/webhooks.js";
import { streamMessage, StreamRegistry } from "../routes/sse.js";
import { applyRateLimit, makeLimiters } from "./ratelimit.js";
import { findIdempotentResponse, makeCapturingResponse, recordIdempotent } from "./idempotency.js";
import { principalFromAny } from "../auth/apikey.js";
import { principalFromRequest } from "../auth/principal.js";
import type { DbHandle } from "../db/index.js";
import type { HttpRequest, HttpResponse, OpenClawPluginApiLite, ParrotConfig, ParrotLogger } from "../types.js";

export interface HttpRegistration {
  /** Stream registry used by hooks to push chunks back to SSE responses. */
  streamRegistry: StreamRegistry;
}

export function registerHttp(args: {
  api: OpenClawPluginApiLite;
  cfg: ParrotConfig;
  db: DbHandle;
  logger: ParrotLogger;
}): HttpRegistration {
  const { api, cfg, db, logger } = args;
  const apiBase = cfg.api.basePath.replace(/\/+$/, "");
  const authCtx = { cfg, db };
  const convCtx = { cfg, db };
  const apiKeyCtx = { cfg, db };
  const limiters = makeLimiters(cfg);
  const streamRegistry = new StreamRegistry();
  const webhookCtx = { cfg, db, logger };
  const sseCtx = { cfg, db, logger, registry: streamRegistry };

  // -- UI (bundled SPA) ---------------------------------------------------
  if (cfg.ui.enabled) {
    const handle = makeStaticHandler(cfg.ui.basePath, logger);
    api.registerHttpRoute({
      path: `${cfg.ui.basePath.replace(/\/+$/, "")}/*`,
      method: "GET",
      auth: "public",
      handler: (req, res) => handle(req, res),
    });
    api.registerHttpRoute({
      path: cfg.ui.basePath.replace(/\/+$/, ""),
      method: "GET",
      auth: "public",
      handler: (req, res) => handle(req, res),
    });
  }

  // -- Health -------------------------------------------------------------
  api.registerHttpRoute({
    path: `${apiBase}/health`,
    method: "GET",
    auth: "public",
    handler: (_req, res) => {
      sendJson(res, 200, { status: "ok", plugin: "gateforge-parrot", version: "0.1.0" });
      return true;
    },
  });

  // -- OpenAPI spec (static) ---------------------------------------------
  api.registerHttpRoute({
    path: `${apiBase}/openapi.yaml`,
    method: "GET",
    auth: "public",
    handler: (_req, res) => {
      try {
        const here = path.dirname(fileURLToPath(import.meta.url));
        // dist/http/router.js -> ../../openapi.yaml
        const candidates = [
          path.resolve(here, "../../openapi.yaml"),
          path.resolve(here, "../openapi.yaml"),
          path.resolve(here, "../../../openapi.yaml"),
        ];
        const file = candidates.find((p) => fs.existsSync(p));
        if (!file) {
          sendError(res, 404, "not_found", "openapi.yaml not bundled");
          return true;
        }
        const buf = fs.readFileSync(file);
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/yaml; charset=utf-8");
        res.setHeader("Cache-Control", "public, max-age=300");
        res.end(buf);
        return true;
      } catch (e) {
        sendError(res, 500, "internal_error", (e as Error).message);
        return true;
      }
    },
  });

  // -- CORS preflight (single broad route) --------------------------------
  api.registerHttpRoute({
    path: `${apiBase}/*`,
    method: "OPTIONS",
    auth: "public",
    handler: (req, res) => {
      const origin = (req.headers.origin as string | undefined) ?? cfg.publicBaseUrl;
      applyCors(res, origin);
      res.statusCode = 204;
      res.end();
      return true;
    },
  });

  // -- Auth ---------------------------------------------------------------
  api.registerHttpRoute({
    path: `${apiBase}/auth/signup`,
    method: "POST",
    auth: "public",
    handler: wrap(logger, (req, res) => handleSignup(authCtx, req, res)),
  });
  api.registerHttpRoute({
    path: `${apiBase}/auth/login`,
    method: "POST",
    auth: "public",
    handler: wrap(logger, (req, res) => handleLogin(authCtx, req, res)),
  });
  api.registerHttpRoute({
    path: `${apiBase}/auth/refresh`,
    method: "POST",
    auth: "public",
    handler: wrap(logger, (req, res) => handleRefresh(authCtx, req, res)),
  });
  api.registerHttpRoute({
    path: `${apiBase}/auth/logout`,
    method: "POST",
    auth: "public",
    handler: wrap(logger, (req, res) => handleLogout(authCtx, req, res)),
  });
  api.registerHttpRoute({
    path: `${apiBase}/auth/whoami`,
    method: "GET",
    auth: "plugin",
    handler: wrap(logger, (req, res) => handleWhoami(authCtx, req, res)),
  });

  // -- Conversations (sessions) -------------------------------------------
  // All conversation routes accept either JWT or API key bearer auth.
  // Per-key + per-tenant rate limiting + Idempotency-Key support applied.
  api.registerHttpRoute({
    path: `${apiBase}/conversations`,
    method: "GET",
    auth: "plugin",
    handler: gateway(logger, db, cfg, limiters, (req, res) => listConversations(convCtx, req, res)),
  });
  api.registerHttpRoute({
    path: `${apiBase}/conversations`,
    method: "POST",
    auth: "plugin",
    handler: gateway(logger, db, cfg, limiters, (req, res) => createConversation(convCtx, req, res), { idempotent: true }),
  });
  api.registerHttpRoute({
    path: `${apiBase}/conversations/:id`,
    method: "PATCH",
    auth: "plugin",
    handler: gateway(logger, db, cfg, limiters, (req, res) =>
      patchConversation(convCtx, req, res, extractIdSimple(req.url, `${apiBase}/conversations/`)),
    ),
  });
  api.registerHttpRoute({
    path: `${apiBase}/conversations/:id`,
    method: "DELETE",
    auth: "plugin",
    handler: gateway(logger, db, cfg, limiters, (req, res) =>
      deleteConversation(convCtx, req, res, extractIdSimple(req.url, `${apiBase}/conversations/`)),
    ),
  });

  // Messages — parameterized by conversation id.
  api.registerHttpRoute({
    path: `${apiBase}/conversations/:id/messages`,
    method: "GET",
    auth: "plugin",
    handler: gateway(logger, db, cfg, limiters, (req, res) =>
      listMessages(convCtx, req, res, extractId(req.url, `${apiBase}/conversations/`, "/messages")),
    ),
  });
  api.registerHttpRoute({
    path: `${apiBase}/conversations/:id/messages`,
    method: "POST",
    auth: "plugin",
    handler: gateway(
      logger,
      db,
      cfg,
      limiters,
      (req, res) => appendMessage(convCtx, req, res, extractId(req.url, `${apiBase}/conversations/`, "/messages")),
      { idempotent: true },
    ),
  });
  api.registerHttpRoute({
    path: `${apiBase}/conversations/:id/messages/stream`,
    method: "POST",
    auth: "plugin",
    handler: wrap(logger, (req, res) =>
      streamMessage(sseCtx, req, res, extractId(req.url, `${apiBase}/conversations/`, "/messages/stream")),
    ),
  });

  // -- API Keys -----------------------------------------------------------
  api.registerHttpRoute({
    path: `${apiBase}/apikeys`,
    method: "GET",
    auth: "plugin",
    handler: wrap(logger, (req, res) => listApiKeys(apiKeyCtx, req, res)),
  });
  api.registerHttpRoute({
    path: `${apiBase}/apikeys`,
    method: "POST",
    auth: "plugin",
    handler: wrap(logger, (req, res) => issueApiKey(apiKeyCtx, req, res)),
  });
  api.registerHttpRoute({
    path: `${apiBase}/apikeys/:id`,
    method: "DELETE",
    auth: "plugin",
    handler: wrap(logger, (req, res) =>
      revokeApiKey(apiKeyCtx, req, res, extractIdSimple(req.url, `${apiBase}/apikeys/`)),
    ),
  });

  // -- Webhooks -----------------------------------------------------------
  api.registerHttpRoute({
    path: `${apiBase}/webhooks`,
    method: "GET",
    auth: "plugin",
    handler: wrap(logger, (req, res) => listWebhooks(webhookCtx, req, res)),
  });
  api.registerHttpRoute({
    path: `${apiBase}/webhooks`,
    method: "POST",
    auth: "plugin",
    handler: wrap(logger, (req, res) => createWebhook(webhookCtx, req, res)),
  });
  api.registerHttpRoute({
    path: `${apiBase}/webhooks/:id`,
    method: "PATCH",
    auth: "plugin",
    handler: wrap(logger, (req, res) =>
      patchWebhook(webhookCtx, req, res, extractIdSimple(req.url, `${apiBase}/webhooks/`)),
    ),
  });
  api.registerHttpRoute({
    path: `${apiBase}/webhooks/:id`,
    method: "DELETE",
    auth: "plugin",
    handler: wrap(logger, (req, res) =>
      deleteWebhook(webhookCtx, req, res, extractIdSimple(req.url, `${apiBase}/webhooks/`)),
    ),
  });
  api.registerHttpRoute({
    path: `${apiBase}/webhooks/:id/test`,
    method: "POST",
    auth: "plugin",
    handler: wrap(logger, (req, res) =>
      testWebhook(webhookCtx, req, res, extractId(req.url, `${apiBase}/webhooks/`, "/test")),
    ),
  });

  logger.info(`HTTP routes registered under ${apiBase}`);
  return { streamRegistry };
}

function extractId(url: string, prefix: string, suffix: string): string {
  const pathname = url.split("?")[0];
  const start = pathname.indexOf(prefix);
  if (start === -1) return "";
  const tail = pathname.slice(start + prefix.length);
  const end = tail.indexOf(suffix);
  return end === -1 ? tail : tail.slice(0, end);
}

function extractIdSimple(url: string, prefix: string): string {
  const pathname = url.split("?")[0];
  const start = pathname.indexOf(prefix);
  if (start === -1) return "";
  const tail = pathname.slice(start + prefix.length);
  const slash = tail.indexOf("/");
  return slash === -1 ? tail : tail.slice(0, slash);
}

function wrap(
  logger: ParrotLogger,
  fn: (req: HttpRequest, res: HttpResponse) => Promise<void> | void,
): (req: HttpRequest, res: HttpResponse) => Promise<boolean> {
  return async (req, res) => {
    try {
      const origin = (req.headers.origin as string | undefined) ?? undefined;
      if (origin) applyCors(res, origin);
      await fn(req, res);
    } catch (err) {
      logger.error("unhandled route error", { error: (err as Error).message });
      try {
        sendError(res, 500, "internal_error", "An unexpected error occurred.");
      } catch {
        /* response already sent */
      }
    }
    return true;
  };
}

/**
 * Gateway wrapper for resource routes: applies rate limiting + idempotency.
 * Skips both for unauthenticated requests (the inner handler returns 401 on
 * its own).
 */
function gateway(
  logger: ParrotLogger,
  db: DbHandle,
  cfg: ParrotConfig,
  limiters: ReturnType<typeof makeLimiters>,
  fn: (req: HttpRequest, res: HttpResponse) => Promise<void> | void,
  opts: { idempotent?: boolean } = {},
): (req: HttpRequest, res: HttpResponse) => Promise<boolean> {
  return async (req, res) => {
    try {
      const origin = (req.headers.origin as string | undefined) ?? undefined;
      if (origin) applyCors(res, origin);

      // Pre-resolve principal for rate limit / idempotency. If it fails we let
      // the inner handler emit the canonical 401.
      let principal;
      try {
        principal = await principalFromAny(cfg, db, req, principalFromRequest);
      } catch {
        await fn(req, res);
        return true;
      }
      if (!applyRateLimit(limiters, principal, res)) return true;

      if (opts.idempotent) {
        const replay = await findIdempotentResponse(db, principal, req);
        if (replay && replay.response) {
          res.statusCode = replay.response.status;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader("Idempotent-Replay", "true");
          res.end(JSON.stringify(replay.response.body));
          return true;
        }
        if (replay) {
          // Key present but no stored response — capture and record.
          const { capture, captured } = makeCapturingResponse(res);
          await fn(req, capture);
          if (captured.value) {
            void recordIdempotent(db, principal, req, replay.key, captured.value);
          }
          return true;
        }
      }

      await fn(req, res);
    } catch (err) {
      logger.error("unhandled gateway error", { error: (err as Error).message });
      try {
        sendError(res, 500, "internal_error", "An unexpected error occurred.");
      } catch {
        /* */
      }
    }
    return true;
  };
}
