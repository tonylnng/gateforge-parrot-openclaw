/**
 * Thin REST client for the Parrot plugin. Adds Authorization headers and
 * surfaces typed errors. The UI is served from the same origin as the API
 * when in production, so we use relative URLs.
 *
 * Field shapes mirror packages/plugin/src/routes/* — keep them in sync.
 */
const API_BASE = "/gateforge-parrot/api/v1";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface RequestOpts {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  token?: string | null;
  idempotencyKey?: string;
  query?: Record<string, string | undefined>;
}

async function request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

  let url = `${API_BASE}${path}`;
  if (opts.query) {
    const usp = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null && v !== "") usp.set(k, v);
    }
    const qs = usp.toString();
    if (qs) url += `?${qs}`;
  }

  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let code: string | undefined;
    let message = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      code = data?.error?.code;
      message = data?.error?.message ?? message;
    } catch {
      /* ignore */
    }
    throw new ApiError(message, res.status, code);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// -- Types ----------------------------------------------------------------

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExp: number;
  refreshTokenExp: number;
}

export interface SignupResponse extends AuthTokens {
  user: { id: string; email: string; tenantId: string };
}

export interface LoginResponse extends AuthTokens {
  user: { id: string; email: string; tenantId: string };
  kdf: { salt: string; memoryCostKiB: number; timeCost: number; parallelism: number };
  wrappedMasterKey: string;
}

export interface ConversationRow {
  id: string;
  title: string | null;
  encryptedTitle: string | null;
  wrappedConversationKey: string;
  agentId: string | null;
  isPinned: boolean;
  isArchived: boolean;
  pinnedAt: number | null;
  archivedAt: number | null;
  lastMessageAt: number | null;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

export type SessionFilter = "active" | "pinned" | "archived" | "all";

export interface MessageRow {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  ciphertext: string;
  meta: string | null;
  createdAt: number;
}

export interface ApiKeyRow {
  id: string;
  prefix: string;
  label: string;
  scopes: string[];
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface WebhookRow {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  failureCount: number;
  createdAt: number;
}

export interface WebhookDeliveryRow {
  id: string;
  eventType: string;
  attempt: number;
  responseCode: number | null;
  deliveredAt: number | null;
  nextRetryAt: number | null;
  lastError: string | null;
  createdAt: number;
  payload: Record<string, unknown> | null;
}

export interface AgentRow {
  id: string;
  name: string;
  description?: string;
  model?: string;
  vendor?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  capabilities?: string[];
}

export interface AuditEntryRow {
  id: string;
  actorId: string | null;
  action: string;
  resource: string | null;
  payload: unknown;
  hash: string;
  prevHash: string | null;
  createdAt: number;
}

export interface AuditVerifyRow {
  ok: boolean;
  checked: number;
  hashChainEnabled?: boolean;
  breakAt?: { id: string; createdAt: number; action: string };
  expected?: string;
  actual?: string;
  note?: string;
}

export interface SessionExportRow {
  schemaVersion: 1;
  exportedAt: number;
  conversation: ConversationRow;
  messages: MessageRow[];
  note?: string;
}

export type StreamFrame =
  | { event: "chunk"; data: { delta: string } }
  | { event: "done"; data: { messageId: string; createdAt: number } }
  | { event: "error"; data: { code: string; message: string } };

// -- Endpoint surface -----------------------------------------------------

export const api = {
  // Auth
  signup: (body: {
    email: string;
    password: string;
    kdfSalt: string;
    kdfMemoryCostKiB: number;
    kdfTimeCost: number;
    kdfParallelism: number;
    wrappedMasterKey: string;
    tenantId?: string;
  }) => request<SignupResponse>("/auth/signup", { method: "POST", body }),

  login: (body: { email: string; password: string; tenantId?: string }) =>
    request<LoginResponse>("/auth/login", { method: "POST", body }),

  refresh: (refreshToken: string) =>
    request<AuthTokens>("/auth/refresh", { method: "POST", body: { refreshToken } }),

  logout: (refreshToken: string) =>
    request<{ ok: boolean }>("/auth/logout", { method: "POST", body: { refreshToken } }),

  whoami: (token: string) =>
    request<{ userId: string; tenantId: string; scopes: string[] }>("/auth/whoami", { token }),

  // Conversations / sessions
  listConversations: (token: string, filter: SessionFilter = "active") =>
    request<{ conversations: ConversationRow[] }>("/conversations", {
      token,
      query: { filter },
    }),

  createConversation: (
    token: string,
    body: { title?: string; encryptedTitle?: string; wrappedConversationKey: string; agentId?: string },
    idempotencyKey?: string,
  ) =>
    request<{
      conversation: {
        id: string;
        createdAt: number;
        updatedAt: number;
        isPinned: boolean;
        isArchived: boolean;
        messageCount: number;
      };
    }>("/conversations", { method: "POST", body, token, idempotencyKey }),

  patchConversation: (
    token: string,
    conversationId: string,
    body: { title?: string; encryptedTitle?: string; isPinned?: boolean; isArchived?: boolean; agentId?: string | null },
  ) => request<{ conversation: ConversationRow }>(`/conversations/${conversationId}`, { method: "PATCH", body, token }),

  deleteConversation: (token: string, conversationId: string) =>
    request<{ ok: true }>(`/conversations/${conversationId}`, { method: "DELETE", token }),

  // Messages
  listMessages: (token: string, conversationId: string) =>
    request<{ messages: MessageRow[] }>(`/conversations/${conversationId}/messages`, { token }),

  appendMessage: (
    token: string,
    conversationId: string,
    body: { role: "user" | "assistant" | "system" | "tool"; ciphertext: string; meta?: Record<string, unknown> },
    idempotencyKey?: string,
  ) =>
    request<{ message: { id: string; createdAt: number } }>(`/conversations/${conversationId}/messages`, {
      method: "POST",
      body,
      token,
      idempotencyKey,
    }),

  // API keys
  listApiKeys: (token: string) => request<{ apikeys: ApiKeyRow[] }>("/apikeys", { token }),

  issueApiKey: (token: string, body: { label: string; scopes: string[]; expiresAt?: number }) =>
    request<{ apikey: ApiKeyRow; token: string }>("/apikeys", { method: "POST", body, token }),

  revokeApiKey: (token: string, id: string) =>
    request<{ ok: true }>(`/apikeys/${id}`, { method: "DELETE", token }),

  // Webhooks
  listWebhooks: (token: string) => request<{ webhooks: WebhookRow[] }>("/webhooks", { token }),

  createWebhook: (token: string, body: { url: string; events: string[]; secret?: string }) =>
    request<{ webhook: WebhookRow; secret: string }>("/webhooks", { method: "POST", body, token }),

  patchWebhook: (token: string, id: string, body: { url?: string; events?: string[]; active?: boolean }) =>
    request<{ webhook: WebhookRow }>(`/webhooks/${id}`, { method: "PATCH", body, token }),

  deleteWebhook: (token: string, id: string) =>
    request<{ ok: true }>(`/webhooks/${id}`, { method: "DELETE", token }),

  testWebhook: (token: string, id: string) =>
    request<{ ok: true; deliveryId: string }>(`/webhooks/${id}/test`, { method: "POST", token }),

  // Phase 2 closeout additions
  getConversation: (token: string, id: string) =>
    request<{ conversation: ConversationRow }>(`/conversations/${id}`, { token }),

  exportConversation: (token: string, id: string) =>
    request<SessionExportRow>(`/conversations/${id}/export`, { token }),

  patchApiKey: (token: string, id: string, body: { label?: string; scopes?: string[] }) =>
    request<{ ok: true }>(`/apikeys/${id}`, { method: "PATCH", body, token }),

  listDeliveries: (token: string, id: string) =>
    request<{ deliveries: WebhookDeliveryRow[] }>(`/webhooks/${id}/deliveries`, { token }),

  listAgents: (token: string) => request<{ agents: AgentRow[] }>("/agents", { token }),

  getAgent: (token: string, id: string) =>
    request<{ agent: AgentRow }>(`/agents/${id}`, { token }),

  listAudit: (
    token: string,
    opts: { cursor?: string; limit?: number; action?: string; actorId?: string } = {},
  ) =>
    request<{ items: AuditEntryRow[]; nextCursor: string | null }>("/audit", {
      token,
      query: {
        cursor: opts.cursor,
        limit: opts.limit !== undefined ? String(opts.limit) : undefined,
        action: opts.action,
        actorId: opts.actorId,
      },
    }),

  verifyAudit: (token: string) => request<AuditVerifyRow>("/audit/verify", { token }),
};

/**
 * Open an SSE stream against POST /conversations/:id/messages/stream and yield
 * each parsed frame. The conversation key is supplied externally so the caller
 * can decrypt the ciphertext deltas; this helper is crypto-agnostic.
 *
 * The async iterator terminates when the server emits `event: done` or when
 * the underlying connection closes. Errors yield an `error` frame before
 * returning so the UI can render a friendly message.
 */
export async function* streamMessage(
  token: string,
  conversationId: string,
  body: { role?: "user" | "assistant" | "system" | "tool"; ciphertext: string; meta?: Record<string, unknown>; streamTag?: string },
  opts: { idempotencyKey?: string } = {},
): AsyncGenerator<StreamFrame, void, void> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  };
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

  const res = await fetch(`${API_BASE}/conversations/${conversationId}/messages/stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ role: body.role ?? "user", ...body }),
  });
  if (!res.ok || !res.body) {
    let message = `${res.status} ${res.statusText}`;
    let code = `http_${res.status}`;
    try {
      const j = await res.json();
      code = j?.error?.code ?? code;
      message = j?.error?.message ?? message;
    } catch {
      /* */
    }
    yield { event: "error", data: { code, message } };
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const frame = parseSseBlock(block);
        if (frame) {
          yield frame;
          if (frame.event === "done") return;
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* */
    }
  }
}

function parseSseBlock(block: string): StreamFrame | null {
  let event = "message";
  let dataLine = "";
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) dataLine += (dataLine ? "\n" : "") + line.slice("data:".length).trim();
  }
  if (!dataLine) return null;
  try {
    const data = JSON.parse(dataLine);
    if (event === "chunk" || event === "done" || event === "error") return { event, data } as StreamFrame;
  } catch {
    /* */
  }
  return null;
}
