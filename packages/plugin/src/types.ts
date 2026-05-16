/**
 * Shared types for the GateForge Parrot plugin.
 *
 * @packageDocumentation
 */

/** Plugin id as registered with OpenClaw. */
export const PLUGIN_ID = "gateforge-parrot" as const;
/** Channel id this plugin exposes to OpenClaw routing. */
export const CHANNEL_ID = "parrot" as const;

/**
 * Resolved plugin configuration (after defaults are applied to the raw config
 * read from OpenClaw's config tree).
 */
export interface ParrotConfig {
  enabled: boolean;
  publicBaseUrl?: string;
  ui: {
    enabled: boolean;
    basePath: string;
  };
  api: {
    basePath: string;
    wsPath: string;
    rateLimit: { windowMs: number; maxRequests: number };
  };
  auth: {
    jwtSecret: string;
    accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
    registration: "open" | "invite-only" | "closed";
    argon2: { memoryCostKiB: number; timeCost: number; parallelism: number };
  };
  database: {
    driver: "auto" | "postgres" | "sqlite";
    url?: string;
    schemaPrefix: string;
    runMigrationsOnStart: boolean;
  };
  tenancy: {
    mode: "multi" | "single";
    defaultTenantId: string;
  };
  audit: {
    enabled: boolean;
    hashChain: boolean;
  };
}

/** Subset of the OpenClaw plugin API surface this plugin uses. */
export interface OpenClawPluginApiLite {
  /** Register an HTTP route on the OpenClaw gateway. */
  registerHttpRoute(route: HttpRoute): void;
  /** Register a lifecycle hook. */
  registerHook<H extends HookName>(name: H, handler: HookHandler<H>): void;
  /** Register a CLI subcommand. */
  registerCli?: (
    setup: (ctx: { program: unknown }) => void,
    meta?: { descriptors: Array<{ name: string; description: string; hasSubcommands?: boolean }> },
  ) => void;
  /** Logger from the runtime (optional — we fall back to a console logger). */
  logger?: ParrotLogger;
  /** Gateway-wide event emitter (optional). */
  runtime?: {
    config?: unknown;
    db?: unknown;
  };
}

export interface HttpRoute {
  path: string;
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS" | "ANY";
  auth?: "plugin" | "gateway" | "public";
  handler: (req: HttpRequest, res: HttpResponse) => Promise<boolean | void> | boolean | void;
}

/** Minimal HTTP request shape that OpenClaw's gateway exposes to plugins. */
export interface HttpRequest {
  url: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: "data", cb: (chunk: Buffer) => void): unknown;
  on(event: "end", cb: () => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  socket?: { remoteAddress?: string };
}

/** Minimal HTTP response shape. */
export interface HttpResponse {
  statusCode: number;
  setHeader(name: string, value: string | string[] | number): void;
  end(chunk?: string | Buffer): void;
  write(chunk: string | Buffer): boolean;
  writeHead?(status: number, headers?: Record<string, string | string[] | number>): void;
}

/**
 * Lifecycle hooks we care about. We intentionally cover only the subset Parrot
 * uses; the SDK exposes more. Keep handler signatures conservative — we only
 * read the fields we need.
 */
export type HookName =
  | "llm_input"
  | "llm_output"
  | "message_received"
  | "message_sending"
  | "session_start"
  | "session_end"
  | "before_compaction"
  | "gateway_start"
  | "gateway_stop";

export type HookHandler<H extends HookName> = (
  payload: HookPayloadMap[H],
) => Promise<HookPayloadMap[H] | void> | HookPayloadMap[H] | void;

export interface HookPayloadMap {
  llm_input: { channelId?: string; messages: Array<{ role: string; content: string }>; meta?: Record<string, unknown> };
  llm_output: { channelId?: string; content: string; meta?: Record<string, unknown> };
  message_received: { channelId?: string; from: string; text?: string; meta?: Record<string, unknown> };
  message_sending: { channelId?: string; to: string; text?: string; meta?: Record<string, unknown> };
  session_start: { sessionId: string; channelId?: string; meta?: Record<string, unknown> };
  session_end: { sessionId: string; channelId?: string; meta?: Record<string, unknown> };
  before_compaction: { sessionId: string; messages: unknown[] };
  gateway_start: { version?: string };
  gateway_stop: Record<string, never>;
}

export interface ParrotLogger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** Authenticated principal extracted from a JWT bearer token. */
export interface Principal {
  userId: string;
  tenantId: string;
  scopes: string[];
  /** Unix seconds. */
  exp: number;
  /** JWT id (used for revocation). */
  jti: string;
}
