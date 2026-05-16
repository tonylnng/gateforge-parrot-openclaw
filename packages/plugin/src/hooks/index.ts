/**
 * OpenClaw lifecycle hook handlers.
 *
 * The hooks themselves stay strictly observational on the server. Real prompt
 * assembly with decrypted history happens on the client; the server only ever
 * sees ciphertext or non-sensitive metadata.
 *
 * SSE streaming bridge: when `llm_output` fires with a `meta.streamTag` set,
 * we forward the chunk to the matching SSE writer via the `StreamRegistry`.
 * The gateway is responsible for re-encrypting plaintext deltas with the
 * client-shared conversation key before they reach this hook — see
 * INTEGRATION_API.md "Streaming wire" for details.
 */
import type { DbHandle } from "../db/index.js";
import { appendAudit } from "../auth/audit.js";
import { enqueueEvent, startDispatcher } from "../webhooks/dispatcher.js";
import type { StreamRegistry } from "../routes/sse.js";
import type { OpenClawPluginApiLite, ParrotConfig, ParrotLogger } from "../types.js";
import { CHANNEL_ID } from "../types.js";

export interface HookArgs {
  api: OpenClawPluginApiLite;
  cfg: ParrotConfig;
  db: DbHandle;
  logger: ParrotLogger;
  streamRegistry: StreamRegistry;
}

export function registerHooks(args: HookArgs): { stopDispatcher: () => void } {
  const { api, cfg, db, logger, streamRegistry } = args;

  api.registerHook("llm_input", async (payload) => {
    if (payload.channelId !== CHANNEL_ID) return;
    logger.debug("llm_input observed", { messages: payload.messages.length });
    await appendAudit(db, cfg, {
      tenantId: cfg.tenancy.defaultTenantId,
      action: "llm.input",
      payload: { messageCount: payload.messages.length },
    });
  });

  api.registerHook("llm_output", async (payload) => {
    if (payload.channelId !== CHANNEL_ID) return;
    logger.debug("llm_output observed", { length: payload.content.length });
    await appendAudit(db, cfg, {
      tenantId: cfg.tenancy.defaultTenantId,
      action: "llm.output",
      payload: { bytes: payload.content.length },
    });

    // Bridge into active SSE streams. The gateway must have set
    // `meta.streamTag` and have already re-encrypted the chunk against the
    // per-conversation key. If the chunk is plaintext (no streamTag), we skip
    // — Parrot never leaks plaintext over the wire on its API surface.
    const tag = typeof payload.meta?.streamTag === "string" ? (payload.meta.streamTag as string) : undefined;
    if (!tag) return;
    streamRegistry.push(tag, { event: "chunk", data: { delta: payload.content } });
  });

  api.registerHook("session_start", async (payload) => {
    if (payload.channelId !== CHANNEL_ID) return;
    void enqueueEvent(
      db,
      {
        tenantId: cfg.tenancy.defaultTenantId,
        event: "session.created",
        payload: { sessionId: payload.sessionId, at: Date.now() },
      },
      logger,
    );
  });

  api.registerHook("gateway_start", () => {
    logger.info(`Parrot ready on channel '${CHANNEL_ID}'`);
  });

  api.registerHook("gateway_stop", () => {
    logger.info("Parrot shutting down");
  });

  const stopDispatcher = startDispatcher(db, logger);
  return { stopDispatcher };
}
