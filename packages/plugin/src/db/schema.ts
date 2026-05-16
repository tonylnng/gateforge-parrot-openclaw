/**
 * Drizzle schema for GateForge Parrot.
 *
 * All tables are prefixed with the configured `database.schemaPrefix`
 * (default `gateforge_parrot_`) to coexist with OpenClaw's own tables in the same DB.
 *
 * Both PostgreSQL and SQLite drivers expose the same logical columns. Where
 * column types differ we pick a portable representation: timestamps are stored
 * as integer Unix milliseconds, binary blobs as base64-encoded text, and JSON
 * payloads as text. This keeps the data dump cross-portable.
 */
import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, primaryKey, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import {
  pgTable,
  text as pgText,
  integer as pgInteger,
  bigint as pgBigint,
  primaryKey as pgPrimaryKey,
  index as pgIndex,
  uniqueIndex as pgUniqueIndex,
} from "drizzle-orm/pg-core";

/** Build SQLite schema with a runtime-resolved table-name prefix. */
export function buildSqliteSchema(prefix: string) {
  const t = (name: string) => `${prefix}${name}`;

  const tenants = sqliteTable(t("tenants"), {
    id: text("id").primaryKey(),
    displayName: text("display_name").notNull(),
    createdAt: integer("created_at").notNull(),
    settings: text("settings"), // JSON blob
  });

  const users = sqliteTable(
    t("users"),
    {
      id: text("id").primaryKey(),
      tenantId: text("tenant_id").notNull(),
      email: text("email").notNull(),
      passwordHash: text("password_hash").notNull(), // Argon2id encoded string
      // Wrapped master key + Argon2 parameters for browser-side KDF.
      // The plaintext master key NEVER touches the server.
      kdfSalt: text("kdf_salt").notNull(), // base64
      kdfMemoryCostKiB: integer("kdf_memory_cost_kib").notNull(),
      kdfTimeCost: integer("kdf_time_cost").notNull(),
      kdfParallelism: integer("kdf_parallelism").notNull(),
      wrappedMasterKey: text("wrapped_master_key").notNull(), // base64 AES-KW(MK, KEK)
      status: text("status").notNull().default("active"), // active | locked | deleted
      createdAt: integer("created_at").notNull(),
      lastLoginAt: integer("last_login_at"),
    },
    (table) => ({
      tenantEmailUnique: uniqueIndex(`${t("users")}_tenant_email_uniq`).on(table.tenantId, table.email),
      tenantIdx: index(`${t("users")}_tenant_idx`).on(table.tenantId),
    }),
  );

  const conversations = sqliteTable(
    t("conversations"),
    {
      id: text("id").primaryKey(),
      tenantId: text("tenant_id").notNull(),
      ownerId: text("owner_id").notNull(),
      title: text("title"), // optional plaintext title (legacy/dev). Production should always use encryptedTitle.
      encryptedTitle: text("encrypted_title"), // base64 ciphertext (AES-256-GCM) — preferred
      // Conversation key wrapped with user's master key. The server only sees the wrapped form.
      wrappedConversationKey: text("wrapped_conversation_key").notNull(), // base64
      agentId: text("agent_id"), // OpenClaw agent reference (Phase 2b)
      isPinned: integer("is_pinned").notNull().default(0),
      isArchived: integer("is_archived").notNull().default(0),
      pinnedAt: integer("pinned_at"),
      archivedAt: integer("archived_at"),
      lastMessageAt: integer("last_message_at"),
      messageCount: integer("message_count").notNull().default(0),
      createdAt: integer("created_at").notNull(),
      updatedAt: integer("updated_at").notNull(),
      deletedAt: integer("deleted_at"), // soft-delete; crypto-shred drops wrappedConversationKey
    },
    (table) => ({
      ownerIdx: index(`${t("conversations")}_owner_idx`).on(table.ownerId, table.tenantId),
      updatedIdx: index(`${t("conversations")}_updated_idx`).on(table.tenantId, table.updatedAt),
      pinnedIdx: index(`${t("conversations")}_pinned_idx`).on(table.ownerId, table.isPinned, table.lastMessageAt),
    }),
  );

  const messages = sqliteTable(
    t("messages"),
    {
      id: text("id").primaryKey(),
      conversationId: text("conversation_id").notNull(),
      tenantId: text("tenant_id").notNull(),
      // role is plaintext because it's required for prompt assembly even
      // before the server can decrypt anything (it can't). The actual content
      // payload is ciphertext.
      role: text("role").notNull(), // user | assistant | system | tool
      // ciphertext = AES-256-GCM(plaintext, conversationKey, iv); base64 packed as iv||ct||tag.
      ciphertext: text("ciphertext").notNull(),
      // Optional non-sensitive metadata visible to the server (model name,
      // token counts) — never put PII here.
      meta: text("meta"), // JSON
      createdAt: integer("created_at").notNull(),
    },
    (table) => ({
      conversationIdx: index(`${t("messages")}_conversation_idx`).on(table.conversationId, table.createdAt),
      tenantIdx: index(`${t("messages")}_tenant_idx`).on(table.tenantId),
    }),
  );

  const apiKeys = sqliteTable(
    t("api_keys"),
    {
      id: text("id").primaryKey(),
      tenantId: text("tenant_id").notNull(),
      userId: text("user_id").notNull(),
      label: text("label").notNull(),
      // Hash of the API key (we never store the key itself).
      keyHash: text("key_hash").notNull(),
      // Per-key wrapped master key copy — derived once at key issuance from the
      // user's plaintext master key inside their browser, then sent here wrapped
      // with a key derived from the API key value itself.
      wrappedMasterKey: text("wrapped_master_key").notNull(),
      scopes: text("scopes").notNull(), // JSON array
      createdAt: integer("created_at").notNull(),
      lastUsedAt: integer("last_used_at"),
      revokedAt: integer("revoked_at"),
    },
    (table) => ({
      keyHashIdx: uniqueIndex(`${t("api_keys")}_key_hash_uniq`).on(table.keyHash),
      userIdx: index(`${t("api_keys")}_user_idx`).on(table.userId),
    }),
  );

  const auditLog = sqliteTable(
    t("audit_log"),
    {
      id: text("id").primaryKey(),
      tenantId: text("tenant_id").notNull(),
      actorId: text("actor_id"),
      action: text("action").notNull(), // login.success, conversation.create, message.send, etc.
      resource: text("resource"),
      // Hash-chained for tamper evidence: hash = SHA256(prevHash || canonicalJson(entry)).
      prevHash: text("prev_hash"),
      hash: text("hash").notNull(),
      payload: text("payload"), // JSON, NON-sensitive metadata only
      createdAt: integer("created_at").notNull(),
    },
    (table) => ({
      tenantTimeIdx: index(`${t("audit_log")}_tenant_time_idx`).on(table.tenantId, table.createdAt),
      actorIdx: index(`${t("audit_log")}_actor_idx`).on(table.actorId),
    }),
  );

  const refreshTokens = sqliteTable(
    t("refresh_tokens"),
    {
      id: text("id").primaryKey(), // jti
      tenantId: text("tenant_id").notNull(),
      userId: text("user_id").notNull(),
      tokenHash: text("token_hash").notNull(),
      expiresAt: integer("expires_at").notNull(),
      revokedAt: integer("revoked_at"),
      createdAt: integer("created_at").notNull(),
      userAgent: text("user_agent"),
      ip: text("ip"),
    },
    (table) => ({
      userIdx: index(`${t("refresh_tokens")}_user_idx`).on(table.userId),
      hashIdx: uniqueIndex(`${t("refresh_tokens")}_hash_uniq`).on(table.tokenHash),
    }),
  );

  const webhooks = sqliteTable(
    t("webhooks"),
    {
      id: text("id").primaryKey(),
      tenantId: text("tenant_id").notNull(),
      userId: text("user_id").notNull(),
      url: text("url").notNull(),
      secretHash: text("secret_hash").notNull(), // sha256 of HMAC secret (we keep secret in column too — see secret)
      secret: text("secret").notNull(), // shown once to creator, used by us to sign deliveries
      events: text("events").notNull(), // JSON array
      enabled: integer("enabled").notNull().default(1),
      createdAt: integer("created_at").notNull(),
      disabledAt: integer("disabled_at"),
      lastDeliveryAt: integer("last_delivery_at"),
      consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    },
    (table) => ({
      tenantIdx: index(`${t("webhooks")}_tenant_idx`).on(table.tenantId),
      userIdx: index(`${t("webhooks")}_user_idx`).on(table.userId),
    }),
  );

  const webhookDeliveries = sqliteTable(
    t("webhook_deliveries"),
    {
      id: text("id").primaryKey(),
      webhookId: text("webhook_id").notNull(),
      eventType: text("event_type").notNull(),
      payload: text("payload").notNull(), // JSON, metadata only — no plaintext
      attempt: integer("attempt").notNull().default(1),
      responseCode: integer("response_code"),
      deliveredAt: integer("delivered_at"),
      nextRetryAt: integer("next_retry_at"),
      lastError: text("last_error"),
      createdAt: integer("created_at").notNull(),
    },
    (table) => ({
      webhookIdx: index(`${t("webhook_deliveries")}_webhook_idx`).on(table.webhookId, table.createdAt),
      pendingIdx: index(`${t("webhook_deliveries")}_pending_idx`).on(table.nextRetryAt),
    }),
  );

  const idempotency = sqliteTable(
    t("idempotency"),
    {
      id: text("id").primaryKey(), // sha256(tenantId|principalId|key)
      tenantId: text("tenant_id").notNull(),
      principalId: text("principal_id").notNull(),
      idempotencyKey: text("idempotency_key").notNull(),
      method: text("method").notNull(),
      path: text("path").notNull(),
      responseStatus: integer("response_status").notNull(),
      responseBody: text("response_body").notNull(),
      createdAt: integer("created_at").notNull(),
      expiresAt: integer("expires_at").notNull(),
    },
    (table) => ({
      expiresIdx: index(`${t("idempotency")}_expires_idx`).on(table.expiresAt),
    }),
  );

  return { tenants, users, conversations, messages, apiKeys, auditLog, refreshTokens, webhooks, webhookDeliveries, idempotency };
}

/** Build PostgreSQL schema with a runtime-resolved table-name prefix. */
export function buildPostgresSchema(prefix: string) {
  const t = (name: string) => `${prefix}${name}`;

  const tenants = pgTable(t("tenants"), {
    id: pgText("id").primaryKey(),
    displayName: pgText("display_name").notNull(),
    createdAt: pgBigint("created_at", { mode: "number" }).notNull(),
    settings: pgText("settings"),
  });

  const users = pgTable(
    t("users"),
    {
      id: pgText("id").primaryKey(),
      tenantId: pgText("tenant_id").notNull(),
      email: pgText("email").notNull(),
      passwordHash: pgText("password_hash").notNull(),
      kdfSalt: pgText("kdf_salt").notNull(),
      kdfMemoryCostKiB: pgInteger("kdf_memory_cost_kib").notNull(),
      kdfTimeCost: pgInteger("kdf_time_cost").notNull(),
      kdfParallelism: pgInteger("kdf_parallelism").notNull(),
      wrappedMasterKey: pgText("wrapped_master_key").notNull(),
      status: pgText("status").notNull().default("active"),
      createdAt: pgBigint("created_at", { mode: "number" }).notNull(),
      lastLoginAt: pgBigint("last_login_at", { mode: "number" }),
    },
    (table) => ({
      tenantEmailUnique: pgUniqueIndex(`${t("users")}_tenant_email_uniq`).on(table.tenantId, table.email),
      tenantIdx: pgIndex(`${t("users")}_tenant_idx`).on(table.tenantId),
    }),
  );

  const conversations = pgTable(
    t("conversations"),
    {
      id: pgText("id").primaryKey(),
      tenantId: pgText("tenant_id").notNull(),
      ownerId: pgText("owner_id").notNull(),
      title: pgText("title"),
      encryptedTitle: pgText("encrypted_title"),
      wrappedConversationKey: pgText("wrapped_conversation_key").notNull(),
      agentId: pgText("agent_id"),
      isPinned: pgInteger("is_pinned").notNull().default(0),
      isArchived: pgInteger("is_archived").notNull().default(0),
      pinnedAt: pgBigint("pinned_at", { mode: "number" }),
      archivedAt: pgBigint("archived_at", { mode: "number" }),
      lastMessageAt: pgBigint("last_message_at", { mode: "number" }),
      messageCount: pgInteger("message_count").notNull().default(0),
      createdAt: pgBigint("created_at", { mode: "number" }).notNull(),
      updatedAt: pgBigint("updated_at", { mode: "number" }).notNull(),
      deletedAt: pgBigint("deleted_at", { mode: "number" }),
    },
    (table) => ({
      ownerIdx: pgIndex(`${t("conversations")}_owner_idx`).on(table.ownerId, table.tenantId),
      updatedIdx: pgIndex(`${t("conversations")}_updated_idx`).on(table.tenantId, table.updatedAt),
      pinnedIdx: pgIndex(`${t("conversations")}_pinned_idx`).on(table.ownerId, table.isPinned, table.lastMessageAt),
    }),
  );

  const messages = pgTable(
    t("messages"),
    {
      id: pgText("id").primaryKey(),
      conversationId: pgText("conversation_id").notNull(),
      tenantId: pgText("tenant_id").notNull(),
      role: pgText("role").notNull(),
      ciphertext: pgText("ciphertext").notNull(),
      meta: pgText("meta"),
      createdAt: pgBigint("created_at", { mode: "number" }).notNull(),
    },
    (table) => ({
      conversationIdx: pgIndex(`${t("messages")}_conversation_idx`).on(table.conversationId, table.createdAt),
      tenantIdx: pgIndex(`${t("messages")}_tenant_idx`).on(table.tenantId),
    }),
  );

  const apiKeys = pgTable(
    t("api_keys"),
    {
      id: pgText("id").primaryKey(),
      tenantId: pgText("tenant_id").notNull(),
      userId: pgText("user_id").notNull(),
      label: pgText("label").notNull(),
      keyHash: pgText("key_hash").notNull(),
      wrappedMasterKey: pgText("wrapped_master_key").notNull(),
      scopes: pgText("scopes").notNull(),
      createdAt: pgBigint("created_at", { mode: "number" }).notNull(),
      lastUsedAt: pgBigint("last_used_at", { mode: "number" }),
      revokedAt: pgBigint("revoked_at", { mode: "number" }),
    },
    (table) => ({
      keyHashIdx: pgUniqueIndex(`${t("api_keys")}_key_hash_uniq`).on(table.keyHash),
      userIdx: pgIndex(`${t("api_keys")}_user_idx`).on(table.userId),
    }),
  );

  const auditLog = pgTable(
    t("audit_log"),
    {
      id: pgText("id").primaryKey(),
      tenantId: pgText("tenant_id").notNull(),
      actorId: pgText("actor_id"),
      action: pgText("action").notNull(),
      resource: pgText("resource"),
      prevHash: pgText("prev_hash"),
      hash: pgText("hash").notNull(),
      payload: pgText("payload"),
      createdAt: pgBigint("created_at", { mode: "number" }).notNull(),
    },
    (table) => ({
      tenantTimeIdx: pgIndex(`${t("audit_log")}_tenant_time_idx`).on(table.tenantId, table.createdAt),
      actorIdx: pgIndex(`${t("audit_log")}_actor_idx`).on(table.actorId),
    }),
  );

  const refreshTokens = pgTable(
    t("refresh_tokens"),
    {
      id: pgText("id").primaryKey(),
      tenantId: pgText("tenant_id").notNull(),
      userId: pgText("user_id").notNull(),
      tokenHash: pgText("token_hash").notNull(),
      expiresAt: pgBigint("expires_at", { mode: "number" }).notNull(),
      revokedAt: pgBigint("revoked_at", { mode: "number" }),
      createdAt: pgBigint("created_at", { mode: "number" }).notNull(),
      userAgent: pgText("user_agent"),
      ip: pgText("ip"),
    },
    (table) => ({
      userIdx: pgIndex(`${t("refresh_tokens")}_user_idx`).on(table.userId),
      hashIdx: pgUniqueIndex(`${t("refresh_tokens")}_hash_uniq`).on(table.tokenHash),
    }),
  );

  const webhooks = pgTable(
    t("webhooks"),
    {
      id: pgText("id").primaryKey(),
      tenantId: pgText("tenant_id").notNull(),
      userId: pgText("user_id").notNull(),
      url: pgText("url").notNull(),
      secretHash: pgText("secret_hash").notNull(),
      secret: pgText("secret").notNull(),
      events: pgText("events").notNull(),
      enabled: pgInteger("enabled").notNull().default(1),
      createdAt: pgBigint("created_at", { mode: "number" }).notNull(),
      disabledAt: pgBigint("disabled_at", { mode: "number" }),
      lastDeliveryAt: pgBigint("last_delivery_at", { mode: "number" }),
      consecutiveFailures: pgInteger("consecutive_failures").notNull().default(0),
    },
    (table) => ({
      tenantIdx: pgIndex(`${t("webhooks")}_tenant_idx`).on(table.tenantId),
      userIdx: pgIndex(`${t("webhooks")}_user_idx`).on(table.userId),
    }),
  );

  const webhookDeliveries = pgTable(
    t("webhook_deliveries"),
    {
      id: pgText("id").primaryKey(),
      webhookId: pgText("webhook_id").notNull(),
      eventType: pgText("event_type").notNull(),
      payload: pgText("payload").notNull(),
      attempt: pgInteger("attempt").notNull().default(1),
      responseCode: pgInteger("response_code"),
      deliveredAt: pgBigint("delivered_at", { mode: "number" }),
      nextRetryAt: pgBigint("next_retry_at", { mode: "number" }),
      lastError: pgText("last_error"),
      createdAt: pgBigint("created_at", { mode: "number" }).notNull(),
    },
    (table) => ({
      webhookIdx: pgIndex(`${t("webhook_deliveries")}_webhook_idx`).on(table.webhookId, table.createdAt),
      pendingIdx: pgIndex(`${t("webhook_deliveries")}_pending_idx`).on(table.nextRetryAt),
    }),
  );

  const idempotency = pgTable(
    t("idempotency"),
    {
      id: pgText("id").primaryKey(),
      tenantId: pgText("tenant_id").notNull(),
      principalId: pgText("principal_id").notNull(),
      idempotencyKey: pgText("idempotency_key").notNull(),
      method: pgText("method").notNull(),
      path: pgText("path").notNull(),
      responseStatus: pgInteger("response_status").notNull(),
      responseBody: pgText("response_body").notNull(),
      createdAt: pgBigint("created_at", { mode: "number" }).notNull(),
      expiresAt: pgBigint("expires_at", { mode: "number" }).notNull(),
    },
    (table) => ({
      expiresIdx: pgIndex(`${t("idempotency")}_expires_idx`).on(table.expiresAt),
    }),
  );

  return { tenants, users, conversations, messages, apiKeys, auditLog, refreshTokens, webhooks, webhookDeliveries, idempotency };
}

/** Logical table names regardless of driver, for typed access. */
export type SchemaTables = ReturnType<typeof buildSqliteSchema>;

// Silence unused import warnings for primaryKey helpers which are reserved
// for future composite-PK migrations.
void primaryKey;
void pgPrimaryKey;
void sql;
