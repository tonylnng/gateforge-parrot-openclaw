/**
 * Drizzle schema for GateForge Parrot.
 *
 * All tables are prefixed with the configured `database.schemaPrefix`
 * (default `parrot_`) to coexist with OpenClaw's own tables in the same DB.
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
      title: text("title"), // optional plaintext title (user-set). Use encryptedTitle for sensitive.
      encryptedTitle: text("encrypted_title"), // base64 ciphertext (AES-256-GCM)
      // Conversation key wrapped with user's master key. The server only sees the wrapped form.
      wrappedConversationKey: text("wrapped_conversation_key").notNull(), // base64
      createdAt: integer("created_at").notNull(),
      updatedAt: integer("updated_at").notNull(),
      archived: integer("archived").notNull().default(0),
    },
    (table) => ({
      ownerIdx: index(`${t("conversations")}_owner_idx`).on(table.ownerId, table.tenantId),
      updatedIdx: index(`${t("conversations")}_updated_idx`).on(table.tenantId, table.updatedAt),
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

  return { tenants, users, conversations, messages, apiKeys, auditLog, refreshTokens };
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
      createdAt: pgBigint("created_at", { mode: "number" }).notNull(),
      updatedAt: pgBigint("updated_at", { mode: "number" }).notNull(),
      archived: pgInteger("archived").notNull().default(0),
    },
    (table) => ({
      ownerIdx: pgIndex(`${t("conversations")}_owner_idx`).on(table.ownerId, table.tenantId),
      updatedIdx: pgIndex(`${t("conversations")}_updated_idx`).on(table.tenantId, table.updatedAt),
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

  return { tenants, users, conversations, messages, apiKeys, auditLog, refreshTokens };
}

/** Logical table names regardless of driver, for typed access. */
export type SchemaTables = ReturnType<typeof buildSqliteSchema>;

// Silence unused import warnings for primaryKey helpers which are reserved
// for future composite-PK migrations.
void primaryKey;
void pgPrimaryKey;
void sql;
