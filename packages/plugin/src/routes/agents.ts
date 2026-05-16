/**
 * Agent catalogue routes.
 *
 *   - GET /agents       — list available agents (from config)
 *   - GET /agents/:id   — fetch one
 *
 * Agents are a thin metadata surface only. The plugin doesn't enforce or
 * route on them — clients use the list to populate model pickers and pass
 * the chosen `agentId` back when creating/updating a session.
 *
 * If no agents are configured we still respond 200 with an empty list,
 * which is the contract clients should assume.
 */
import { principalFromRequest } from "../auth/principal.js";
import { principalFromAny } from "../auth/apikey.js";
import { sendError, sendJson } from "../http/respond.js";
import type { DbHandle } from "../db/index.js";
import type { AgentDescriptor, HttpRequest, HttpResponse, ParrotConfig } from "../types.js";

export interface AgentCtx {
  cfg: ParrotConfig;
  db: DbHandle;
}

export async function listAgents(ctx: AgentCtx, req: HttpRequest, res: HttpResponse): Promise<void> {
  try {
    await principalFromAny(ctx.cfg, ctx.db, req, principalFromRequest);
  } catch (e) {
    sendError(res, 401, "unauthorized", (e as Error).message);
    return;
  }
  const agents = (ctx.cfg.agents ?? []).filter((a) => a.enabled !== false);
  sendJson(res, 200, { agents: agents.map(publicView) });
}

export async function getAgent(
  ctx: AgentCtx,
  req: HttpRequest,
  res: HttpResponse,
  agentId: string,
): Promise<void> {
  try {
    await principalFromAny(ctx.cfg, ctx.db, req, principalFromRequest);
  } catch (e) {
    sendError(res, 401, "unauthorized", (e as Error).message);
    return;
  }
  const agent = (ctx.cfg.agents ?? []).find((a) => a.id === agentId);
  if (!agent || agent.enabled === false) {
    sendError(res, 404, "not_found", "Agent not found.");
    return;
  }
  sendJson(res, 200, { agent: publicView(agent) });
}

function publicView(a: AgentDescriptor): AgentDescriptor {
  // Strip the `enabled` flag from the wire view — it's an internal concern.
  const { enabled: _enabled, ...rest } = a;
  void _enabled;
  return rest;
}
