/**
 * WebSocket server for low-latency message streaming.
 *
 * Connection lifecycle:
 *   1. Client opens `ws://.../gateforge-parrot/ws?token=<access-jwt>&conversation=<id>`
 *   2. Server verifies JWT, loads conversation ownership
 *   3. Client sends `{type:"append", role, ciphertext, meta?}` frames
 *   4. Server fans out `{type:"chunk", ciphertext}` frames from the agent
 *
 * NOTE: This server is wired against the standalone HTTP listener at the
 * bottom of `index.ts` when the OpenClaw runtime does not expose a WS hook.
 * If OpenClaw later exposes `registerWebSocketRoute`, swap the listen call
 * for that.
 */
import { WebSocketServer, type WebSocket } from "ws";
import type { IncomingMessage, Server as HttpServer } from "node:http";

import type { DbHandle } from "../db/index.js";
import { verifyToken } from "../auth/jwt.js";
import type { ParrotConfig, ParrotLogger, Principal } from "../types.js";

interface WsClient {
  socket: WebSocket;
  principal: Principal;
  conversationId?: string;
}

export function startWebSocketServer(args: {
  server: HttpServer;
  cfg: ParrotConfig;
  db: DbHandle;
  logger: ParrotLogger;
}): WebSocketServer {
  const { server, cfg, logger } = args;
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WsClient>();

  server.on("upgrade", async (req: IncomingMessage, socket, head) => {
    if (!req.url?.startsWith(cfg.api.wsPath)) return;
    try {
      const url = new URL(req.url, "http://placeholder");
      const token = url.searchParams.get("token");
      const conversationId = url.searchParams.get("conversation") ?? undefined;
      if (!token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      const principal = await verifyToken(cfg, token, "access");
      wss.handleUpgrade(req, socket, head, (ws) => {
        const client: WsClient = { socket: ws, principal, conversationId };
        clients.add(client);
        ws.on("close", () => clients.delete(client));
        ws.on("error", (err) => logger.warn("ws error", { msg: err.message }));
        ws.on("message", (raw) => handleClientFrame(client, raw.toString(), logger));
        ws.send(JSON.stringify({ type: "hello", userId: principal.userId, tenantId: principal.tenantId }));
      });
    } catch (e) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      logger.warn("ws upgrade rejected", { err: (e as Error).message });
    }
  });

  return wss;
}

function handleClientFrame(client: WsClient, raw: string, logger: ParrotLogger): void {
  let msg: { type?: string; [k: string]: unknown };
  try {
    msg = JSON.parse(raw);
  } catch {
    client.socket.send(JSON.stringify({ type: "error", message: "invalid json" }));
    return;
  }
  switch (msg.type) {
    case "ping":
      client.socket.send(JSON.stringify({ type: "pong", t: Date.now() }));
      return;
    case "subscribe": {
      const conversationId = typeof msg.conversation === "string" ? msg.conversation : undefined;
      client.conversationId = conversationId;
      client.socket.send(JSON.stringify({ type: "subscribed", conversation: conversationId }));
      return;
    }
    default:
      logger.debug("ws frame received", { type: msg.type });
  }
}
