/**
 * Resolves the raw config OpenClaw passes us into a fully-typed
 * {@link ParrotConfig} with defaults applied.
 *
 * The raw shape comes from the user's `openclaw.json` under
 * `plugins.entries["gateforge-parrot"]`.
 */
import type { ParrotConfig } from "./types.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Default config used when the user hasn't overridden a section. */
export const DEFAULT_CONFIG: Omit<ParrotConfig, "auth" | "publicBaseUrl"> & {
  auth: Omit<ParrotConfig["auth"], "jwtSecret"> & { jwtSecret?: string };
} = {
  enabled: true,
  ui: { enabled: true, basePath: "/parrot/ui" },
  api: {
    basePath: "/parrot/api/v1",
    wsPath: "/parrot/ws",
    rateLimit: { windowMs: 60_000, maxRequests: 120 },
  },
  auth: {
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 2_592_000,
    registration: "invite-only",
    argon2: { memoryCostKiB: 65_536, timeCost: 3, parallelism: 4 },
  },
  database: {
    driver: "auto",
    schemaPrefix: "parrot_",
    runMigrationsOnStart: true,
  },
  tenancy: { mode: "multi", defaultTenantId: "default" },
  audit: { enabled: true, hashChain: true },
};

/** Deep-merge defaults with a partial user config. */
export function resolveConfig(raw: unknown): ParrotConfig {
  const user = (raw ?? {}) as Partial<ParrotConfig>;
  const merged: ParrotConfig = {
    enabled: user.enabled ?? DEFAULT_CONFIG.enabled,
    publicBaseUrl: user.publicBaseUrl,
    ui: { ...DEFAULT_CONFIG.ui, ...(user.ui ?? {}) },
    api: {
      ...DEFAULT_CONFIG.api,
      ...(user.api ?? {}),
      rateLimit: { ...DEFAULT_CONFIG.api.rateLimit, ...(user.api?.rateLimit ?? {}) },
    },
    auth: {
      ...DEFAULT_CONFIG.auth,
      ...(user.auth ?? {}),
      jwtSecret: user.auth?.jwtSecret ?? process.env.PARROT_JWT_SECRET ?? "",
      argon2: { ...DEFAULT_CONFIG.auth.argon2, ...(user.auth?.argon2 ?? {}) },
    },
    database: { ...DEFAULT_CONFIG.database, ...(user.database ?? {}) },
    tenancy: { ...DEFAULT_CONFIG.tenancy, ...(user.tenancy ?? {}) },
    audit: { ...DEFAULT_CONFIG.audit, ...(user.audit ?? {}) },
  };

  validate(merged);
  return merged;
}

function validate(cfg: ParrotConfig): void {
  if (!cfg.enabled) return;

  if (!cfg.auth.jwtSecret || cfg.auth.jwtSecret.length < 32) {
    throw new ConfigError(
      "auth.jwtSecret must be set and at least 32 characters. " +
        "Generate one with: openssl rand -base64 48 — or set PARROT_JWT_SECRET in the environment.",
    );
  }
  if (cfg.auth.accessTokenTtlSeconds < 60) {
    throw new ConfigError("auth.accessTokenTtlSeconds must be at least 60.");
  }
  if (cfg.database.driver === "sqlite" && cfg.database.url && !cfg.database.url.startsWith("file:")) {
    throw new ConfigError("sqlite database.url must start with 'file:'");
  }
  if (cfg.database.driver === "postgres" && cfg.database.url && !cfg.database.url.startsWith("postgres")) {
    throw new ConfigError("postgres database.url must start with 'postgres://' or 'postgresql://'");
  }
}
