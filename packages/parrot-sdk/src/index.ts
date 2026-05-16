/**
 * `@gateforge/parrot-sdk` — client library for the GateForge Parrot API.
 *
 * The SDK exclusively handles **ciphertext** — your application is responsible
 * for deriving the master key from the user's password (using the parameters
 * served at login) and unwrapping per-conversation keys before encrypting or
 * decrypting messages. The SDK provides crypto helpers from `./crypto` for
 * that purpose.
 *
 * Usage:
 *
 * ```ts
 * import { ParrotClient } from "@gateforge/parrot-sdk";
 * import { encryptMessage, decryptMessage, unwrapContentKey } from "@gateforge/parrot-sdk/crypto";
 *
 * const client = new ParrotClient({
 *   baseUrl: "https://example.com/gateforge-parrot/api/v1",
 *   apiKey: "pk_live_xxxx.yyyy",
 * });
 *
 * const sessions = await client.listSessions();
 * ```
 */
import * as Crypto from "./crypto.js";

export * from "./crypto.js";

// ---- types ------------------------------------------------------------------

export interface ClientOptions {
  /** Base URL, e.g. `https://gw.example.com/gateforge-parrot/api/v1`. */
  baseUrl: string;
  /** API key (preferred) — `pk_<env>_<random>.<secret>` */
  apiKey?: string;
  /** JWT access token (alternative to apiKey). */
  accessToken?: string;
  /** Optional custom fetch (e.g. for testing or Node 18). */
  fetch?: typeof fetch;
  /** Default timeout for non-streaming calls. */
  timeoutMs?: number;
}

export interface SessionSummary {
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

export interface MessageSummary {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  ciphertext: string;
  meta: string | null;
  createdAt: number;
}

export interface CreateSessionInput {
  /** Pre-wrapped conversation key (base64 AES-KW). */
  wrappedConversationKey: string;
  /** Encrypted title (base64 AES-256-GCM). */
  encryptedTitle?: string;
  /** Optional non-sensitive plaintext title (legacy/dev only). */
  title?: string;
  /** Optional OpenClaw agent id to bind. */
  agentId?: string;
}

export interface PatchSessionInput {
  encryptedTitle?: string;
  title?: string;
  isPinned?: boolean;
  isArchived?: boolean;
  agentId?: string | null;
}

export interface SendMessageInput {
  role?: "user" | "assistant" | "system" | "tool";
  /** Encrypted payload (base64). */
  ciphertext: string;
  meta?: Record<string, unknown>;
  /** Optional idempotency key — caller must persist if they need replay safety. */
  idempotencyKey?: string;
}

export interface StreamMessageInput extends SendMessageInput {
  /** Stable tag so the gateway can route llm_output chunks back to this stream. */
  streamTag?: string;
}

export type StreamFrame =
  | { event: "chunk"; data: { delta: string } }
  | { event: "done"; data: { messageId: string; createdAt: number } }
  | { event: "error"; data: { code: string; message: string } };

export interface ApiKeyInfo {
  id: string;
  label: string;
  scopes: string[];
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export interface IssuedApiKey extends ApiKeyInfo {
  /** Plaintext token — shown ONCE. */
  token: string;
  keyPrefix: string;
}

export interface WebhookInfo {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  createdAt: number;
  disabledAt: number | null;
  lastDeliveryAt: number | null;
  consecutiveFailures: number;
}

export interface CreatedWebhook extends WebhookInfo {
  /** Plaintext signing secret — shown ONCE. */
  secret: string;
}

export interface WebhookDelivery {
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

export interface SessionExport {
  schemaVersion: 1;
  exportedAt: number;
  conversation: SessionSummary;
  messages: MessageSummary[];
  note?: string;
}

export interface AgentDescriptor {
  id: string;
  name: string;
  description?: string;
  model?: string;
  vendor?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  capabilities?: string[];
}

export interface AuditEntry {
  id: string;
  actorId: string | null;
  action: string;
  resource: string | null;
  payload: unknown;
  hash: string;
  prevHash: string | null;
  createdAt: number;
}

export interface AuditPage {
  items: AuditEntry[];
  nextCursor: string | null;
}

export interface AuditVerifyResult {
  ok: boolean;
  checked: number;
  hashChainEnabled?: boolean;
  breakAt?: { id: string; createdAt: number; action: string };
  expected?: string;
  actual?: string;
  note?: string;
}

export interface PatchApiKeyInput {
  label?: string;
  scopes?: string[];
}

// ---- errors -----------------------------------------------------------------

export class ParrotError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ParrotError";
  }
}

// ---- client -----------------------------------------------------------------

export class ParrotClient {
  private fetchImpl: typeof fetch;
  private baseUrl: string;
  private timeoutMs: number;
  private headers: () => Record<string, string>;

  constructor(opts: ClientOptions) {
    if (!opts.baseUrl) throw new Error("baseUrl is required");
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.headers = () => {
      const h: Record<string, string> = { Accept: "application/json" };
      if (opts.apiKey) h.Authorization = `Bearer ${opts.apiKey}`;
      else if (opts.accessToken) h.Authorization = `Bearer ${opts.accessToken}`;
      return h;
    };
  }

  // ---- sessions ----

  async listSessions(filter: "active" | "pinned" | "archived" | "all" = "active"): Promise<SessionSummary[]> {
    const r = await this.request("GET", `/conversations?filter=${encodeURIComponent(filter)}`);
    return ((r as { conversations: SessionSummary[] }).conversations ?? []);
  }

  async createSession(input: CreateSessionInput): Promise<{ id: string; createdAt: number }> {
    const r = await this.request("POST", "/conversations", input);
    return (r as { conversation: { id: string; createdAt: number } }).conversation;
  }

  async patchSession(id: string, patch: PatchSessionInput): Promise<void> {
    await this.request("PATCH", `/conversations/${encodeURIComponent(id)}`, patch);
  }

  async deleteSession(id: string): Promise<void> {
    await this.request("DELETE", `/conversations/${encodeURIComponent(id)}`);
  }

  async pinSession(id: string, pinned = true): Promise<void> {
    return this.patchSession(id, { isPinned: pinned });
  }

  async archiveSession(id: string, archived = true): Promise<void> {
    return this.patchSession(id, { isArchived: archived });
  }

  async renameSession(id: string, encryptedTitle: string): Promise<void> {
    return this.patchSession(id, { encryptedTitle });
  }

  async getSession(id: string): Promise<SessionSummary> {
    const r = await this.request("GET", `/conversations/${encodeURIComponent(id)}`);
    return (r as { conversation: SessionSummary }).conversation;
  }

  async exportSession(id: string): Promise<SessionExport> {
    return (await this.request("GET", `/conversations/${encodeURIComponent(id)}/export`)) as SessionExport;
  }

  // ---- messages ----

  async listMessages(sessionId: string): Promise<MessageSummary[]> {
    const r = await this.request("GET", `/conversations/${encodeURIComponent(sessionId)}/messages`);
    return (r as { messages: MessageSummary[] }).messages ?? [];
  }

  async sendMessage(sessionId: string, input: SendMessageInput): Promise<{ id: string; createdAt: number }> {
    const r = await this.request(
      "POST",
      `/conversations/${encodeURIComponent(sessionId)}/messages`,
      input,
      input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : undefined,
    );
    return (r as { message: { id: string; createdAt: number } }).message;
  }

  /**
   * Send a message and consume the SSE stream. Each frame is yielded to the
   * caller via async iteration; the iterator returns once the `done` frame is
   * received or the connection closes.
   */
  async *streamMessage(sessionId: string, input: StreamMessageInput): AsyncGenerator<StreamFrame, void, void> {
    const url = `${this.baseUrl}/conversations/${encodeURIComponent(sessionId)}/messages/stream`;
    const headers: Record<string, string> = {
      ...this.headers(),
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };
    if (input.idempotencyKey) headers["Idempotency-Key"] = input.idempotencyKey;
    const resp = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        role: input.role ?? "user",
        ciphertext: input.ciphertext,
        streamTag: input.streamTag,
        meta: input.meta,
      }),
    });
    if (!resp.ok || !resp.body) {
      const code = resp.headers.get("x-error-code") ?? `http_${resp.status}`;
      let msg = resp.statusText;
      try {
        const j = (await resp.json()) as { error?: { message?: string } };
        if (j?.error?.message) msg = j.error.message;
      } catch {
        /* */
      }
      throw new ParrotError(resp.status, code, msg);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
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
  }

  // ---- api keys ----

  async listApiKeys(): Promise<ApiKeyInfo[]> {
    const r = await this.request("GET", "/apikeys");
    return (r as { apiKeys: ApiKeyInfo[] }).apiKeys ?? [];
  }

  async issueApiKey(input: { label: string; scopes: string[]; wrappedMasterKey: string; env?: "live" | "test" }): Promise<IssuedApiKey> {
    const r = await this.request("POST", "/apikeys", input);
    return (r as { apiKey: IssuedApiKey }).apiKey;
  }

  async patchApiKey(id: string, patch: PatchApiKeyInput): Promise<void> {
    await this.request("PATCH", `/apikeys/${encodeURIComponent(id)}`, patch);
  }

  async revokeApiKey(id: string): Promise<void> {
    await this.request("DELETE", `/apikeys/${encodeURIComponent(id)}`);
  }

  // ---- webhooks ----

  async listWebhooks(): Promise<WebhookInfo[]> {
    const r = await this.request("GET", "/webhooks");
    return (r as { webhooks: WebhookInfo[] }).webhooks ?? [];
  }

  async createWebhook(input: { url: string; events: string[] }): Promise<CreatedWebhook> {
    const r = await this.request("POST", "/webhooks", input);
    return (r as { webhook: CreatedWebhook }).webhook;
  }

  async patchWebhook(id: string, patch: { url?: string; events?: string[]; enabled?: boolean }): Promise<void> {
    await this.request("PATCH", `/webhooks/${encodeURIComponent(id)}`, patch);
  }

  async deleteWebhook(id: string): Promise<void> {
    await this.request("DELETE", `/webhooks/${encodeURIComponent(id)}`);
  }

  async testWebhook(id: string): Promise<void> {
    await this.request("POST", `/webhooks/${encodeURIComponent(id)}/test`);
  }

  async listDeliveries(id: string): Promise<WebhookDelivery[]> {
    const r = await this.request("GET", `/webhooks/${encodeURIComponent(id)}/deliveries`);
    return (r as { deliveries: WebhookDelivery[] }).deliveries ?? [];
  }

  // ---- agents ----

  async listAgents(): Promise<AgentDescriptor[]> {
    const r = await this.request("GET", "/agents");
    return (r as { agents: AgentDescriptor[] }).agents ?? [];
  }

  async getAgent(id: string): Promise<AgentDescriptor> {
    const r = await this.request("GET", `/agents/${encodeURIComponent(id)}`);
    return (r as { agent: AgentDescriptor }).agent;
  }

  // ---- audit ----

  async listAudit(opts: { cursor?: string; limit?: number; action?: string; actorId?: string } = {}): Promise<AuditPage> {
    const qs = new URLSearchParams();
    if (opts.cursor) qs.set("cursor", opts.cursor);
    if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
    if (opts.action) qs.set("action", opts.action);
    if (opts.actorId) qs.set("actorId", opts.actorId);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return (await this.request("GET", `/audit${suffix}`)) as AuditPage;
  }

  async verifyAudit(): Promise<AuditVerifyResult> {
    return (await this.request("GET", "/audit/verify")) as AuditVerifyResult;
  }

  // ---- internals ----

  private async request(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { ...this.headers(), ...(extraHeaders ?? {}) };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const resp = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await resp.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      if (!resp.ok) {
        const err = (parsed as { error?: { code?: string; message?: string } } | null)?.error;
        throw new ParrotError(resp.status, err?.code ?? `http_${resp.status}`, err?.message ?? resp.statusText);
      }
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseSseBlock(block: string): StreamFrame | null {
  let event = "message";
  let dataLine = "";
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue; // comment / heartbeat
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

// re-export the crypto namespace for `import { Crypto } from "@gateforge/parrot-sdk"`
export { Crypto };
