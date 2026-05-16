/**
 * Tiny router that dispatches HTTP requests on the plugin's mount paths.
 *
 * We deliberately avoid pulling in Express / Fastify — the OpenClaw plugin
 * runtime registers routes one at a time, and we want a minimal surface area.
 */
import { makeStaticHandler } from "./static.js";
import { applyCors, sendError, sendJson } from "./respond.js";
import { handleLogin, handleLogout, handleRefresh, handleSignup, handleWhoami } from "../routes/auth.js";
import { appendMessage, createConversation, listConversations, listMessages } from "../routes/conversations.js";
import type { DbHandle } from "../db/index.js";
import type { HttpRequest, HttpResponse, OpenClawPluginApiLite, ParrotConfig, ParrotLogger } from "../types.js";

export function registerHttp(args: {
  api: OpenClawPluginApiLite;
  cfg: ParrotConfig;
  db: DbHandle;
  logger: ParrotLogger;
}): void {
  const { api, cfg, db, logger } = args;
  const apiBase = cfg.api.basePath.replace(/\/+$/, "");
  const authCtx = { cfg, db };
  const convCtx = { cfg, db };

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

  // -- Conversations ------------------------------------------------------
  api.registerHttpRoute({
    path: `${apiBase}/conversations`,
    method: "GET",
    auth: "plugin",
    handler: wrap(logger, (req, res) => listConversations(convCtx, req, res)),
  });
  api.registerHttpRoute({
    path: `${apiBase}/conversations`,
    method: "POST",
    auth: "plugin",
    handler: wrap(logger, (req, res) => createConversation(convCtx, req, res)),
  });

  // Messages — parameterized by conversation id.
  // We register one route per verb and parse the id from the URL.
  api.registerHttpRoute({
    path: `${apiBase}/conversations/:id/messages`,
    method: "GET",
    auth: "plugin",
    handler: wrap(logger, (req, res) => listMessages(convCtx, req, res, extractId(req.url, `${apiBase}/conversations/`, "/messages"))),
  });
  api.registerHttpRoute({
    path: `${apiBase}/conversations/:id/messages`,
    method: "POST",
    auth: "plugin",
    handler: wrap(logger, (req, res) => appendMessage(convCtx, req, res, extractId(req.url, `${apiBase}/conversations/`, "/messages"))),
  });

  logger.info(`HTTP routes registered under ${apiBase}`);
}

function extractId(url: string, prefix: string, suffix: string): string {
  const pathname = url.split("?")[0];
  const start = pathname.indexOf(prefix);
  if (start === -1) return "";
  const tail = pathname.slice(start + prefix.length);
  const end = tail.indexOf(suffix);
  return end === -1 ? tail : tail.slice(0, end);
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
