/**
 * Thin REST client for the Parrot plugin. Adds Authorization headers and
 * surfaces typed errors. The UI is served from the same origin as the API
 * when in production, so we use relative URLs.
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
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  token?: string | null;
}

async function request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${API_BASE}${path}`, {
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

// -- Auth ----------------------------------------------------------------

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

export const api = {
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

  listConversations: (token: string) =>
    request<{
      conversations: Array<{
        id: string;
        title: string | null;
        encryptedTitle: string | null;
        wrappedConversationKey: string;
        createdAt: number;
        updatedAt: number;
      }>;
    }>("/conversations", { token }),

  createConversation: (token: string, body: { title?: string; encryptedTitle?: string; wrappedConversationKey: string }) =>
    request<{ conversation: { id: string; createdAt: number; updatedAt: number } }>("/conversations", {
      method: "POST",
      body,
      token,
    }),

  listMessages: (token: string, conversationId: string) =>
    request<{
      messages: Array<{ id: string; role: string; ciphertext: string; meta: string | null; createdAt: number }>;
    }>(`/conversations/${conversationId}/messages`, { token }),

  appendMessage: (
    token: string,
    conversationId: string,
    body: { role: "user" | "assistant" | "system" | "tool"; ciphertext: string; meta?: Record<string, unknown> },
  ) => request<{ message: { id: string; createdAt: number } }>(`/conversations/${conversationId}/messages`, {
    method: "POST",
    body,
    token,
  }),
};
