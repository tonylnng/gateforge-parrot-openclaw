/**
 * OpenClaw lifecycle hook handlers.
 *
 * Parrot stays out of the agent's prompt-building path on purpose: the
 * agent sees only the transient plaintext that the BFF gateway already passes
 * it; we never inject or rewrite. These hooks exist for observability and
 * audit only.
 *
 * Real prompt assembly with decrypted history happens in the gateway path,
 * not here — see PLUGIN_DESIGN.md "Phase 2" for the full plan.
 */
import type { DbHandle } from "../db/index.js";
import { appendAudit } from "../auth/audit.js";
import type { OpenClawPluginApiLite, ParrotConfig, ParrotLogger } from "../types.js";
import { CHANNEL_ID } from "../types.js";

export function registerHooks(args: { api: OpenClawPluginApiLite; cfg: ParrotConfig; db: DbHandle; logger: ParrotLogger }): void {
  const { api, cfg, db, logger } = args;

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
  });

  api.registerHook("gateway_start", () => {
    logger.info(`Parrot ready on channel '${CHANNEL_ID}'`);
  });

  api.registerHook("gateway_stop", () => {
    logger.info("Parrot shutting down");
  });
}
