-- GateForge Parrot — initial schema (PostgreSQL)
-- {{prefix}} is replaced with the configured schemaPrefix (default: gateforge_parrot_)

CREATE TABLE IF NOT EXISTS {{prefix}}tenants (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  created_at    BIGINT NOT NULL,
  settings      TEXT
);

CREATE TABLE IF NOT EXISTS {{prefix}}users (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL,
  email                TEXT NOT NULL,
  password_hash        TEXT NOT NULL,
  kdf_salt             TEXT NOT NULL,
  kdf_memory_cost_kib  INTEGER NOT NULL,
  kdf_time_cost        INTEGER NOT NULL,
  kdf_parallelism      INTEGER NOT NULL,
  wrapped_master_key   TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'active',
  created_at           BIGINT NOT NULL,
  last_login_at        BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS {{prefix}}users_tenant_email_uniq
  ON {{prefix}}users (tenant_id, email);
CREATE INDEX IF NOT EXISTS {{prefix}}users_tenant_idx
  ON {{prefix}}users (tenant_id);

CREATE TABLE IF NOT EXISTS {{prefix}}conversations (
  id                        TEXT PRIMARY KEY,
  tenant_id                 TEXT NOT NULL,
  owner_id                  TEXT NOT NULL,
  title                     TEXT,
  encrypted_title           TEXT,
  wrapped_conversation_key  TEXT NOT NULL,
  agent_id                  TEXT,
  is_pinned                 INTEGER NOT NULL DEFAULT 0,
  is_archived               INTEGER NOT NULL DEFAULT 0,
  pinned_at                 BIGINT,
  archived_at               BIGINT,
  last_message_at           BIGINT,
  message_count             INTEGER NOT NULL DEFAULT 0,
  created_at                BIGINT NOT NULL,
  updated_at                BIGINT NOT NULL,
  deleted_at                BIGINT
);
CREATE INDEX IF NOT EXISTS {{prefix}}conversations_owner_idx
  ON {{prefix}}conversations (owner_id, tenant_id);
CREATE INDEX IF NOT EXISTS {{prefix}}conversations_updated_idx
  ON {{prefix}}conversations (tenant_id, updated_at);
CREATE INDEX IF NOT EXISTS {{prefix}}conversations_pinned_idx
  ON {{prefix}}conversations (owner_id, is_pinned, last_message_at);

CREATE TABLE IF NOT EXISTS {{prefix}}messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  tenant_id       TEXT NOT NULL,
  role            TEXT NOT NULL,
  ciphertext      TEXT NOT NULL,
  meta            TEXT,
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS {{prefix}}messages_conversation_idx
  ON {{prefix}}messages (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS {{prefix}}messages_tenant_idx
  ON {{prefix}}messages (tenant_id);

CREATE TABLE IF NOT EXISTS {{prefix}}api_keys (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  user_id             TEXT NOT NULL,
  label               TEXT NOT NULL,
  key_hash            TEXT NOT NULL,
  wrapped_master_key  TEXT NOT NULL,
  scopes              TEXT NOT NULL,
  created_at          BIGINT NOT NULL,
  last_used_at        BIGINT,
  revoked_at          BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS {{prefix}}api_keys_key_hash_uniq
  ON {{prefix}}api_keys (key_hash);
CREATE INDEX IF NOT EXISTS {{prefix}}api_keys_user_idx
  ON {{prefix}}api_keys (user_id);

CREATE TABLE IF NOT EXISTS {{prefix}}audit_log (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  actor_id    TEXT,
  action      TEXT NOT NULL,
  resource    TEXT,
  prev_hash   TEXT,
  hash        TEXT NOT NULL,
  payload     TEXT,
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS {{prefix}}audit_log_tenant_time_idx
  ON {{prefix}}audit_log (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS {{prefix}}audit_log_actor_idx
  ON {{prefix}}audit_log (actor_id);

CREATE TABLE IF NOT EXISTS {{prefix}}refresh_tokens (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  token_hash  TEXT NOT NULL,
  expires_at  BIGINT NOT NULL,
  revoked_at  BIGINT,
  created_at  BIGINT NOT NULL,
  user_agent  TEXT,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS {{prefix}}refresh_tokens_user_idx
  ON {{prefix}}refresh_tokens (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS {{prefix}}refresh_tokens_hash_uniq
  ON {{prefix}}refresh_tokens (token_hash);

CREATE TABLE IF NOT EXISTS {{prefix}}webhooks (
  id                     TEXT PRIMARY KEY,
  tenant_id              TEXT NOT NULL,
  user_id                TEXT NOT NULL,
  url                    TEXT NOT NULL,
  secret_hash            TEXT NOT NULL,
  secret                 TEXT NOT NULL,
  events                 TEXT NOT NULL,
  enabled                INTEGER NOT NULL DEFAULT 1,
  created_at             BIGINT NOT NULL,
  disabled_at            BIGINT,
  last_delivery_at       BIGINT,
  consecutive_failures   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS {{prefix}}webhooks_tenant_idx
  ON {{prefix}}webhooks (tenant_id);
CREATE INDEX IF NOT EXISTS {{prefix}}webhooks_user_idx
  ON {{prefix}}webhooks (user_id);

CREATE TABLE IF NOT EXISTS {{prefix}}webhook_deliveries (
  id              TEXT PRIMARY KEY,
  webhook_id      TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  payload         TEXT NOT NULL,
  attempt         INTEGER NOT NULL DEFAULT 1,
  response_code   INTEGER,
  delivered_at    BIGINT,
  next_retry_at   BIGINT,
  last_error      TEXT,
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS {{prefix}}webhook_deliveries_webhook_idx
  ON {{prefix}}webhook_deliveries (webhook_id, created_at);
CREATE INDEX IF NOT EXISTS {{prefix}}webhook_deliveries_pending_idx
  ON {{prefix}}webhook_deliveries (next_retry_at);

CREATE TABLE IF NOT EXISTS {{prefix}}idempotency (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  principal_id      TEXT NOT NULL,
  idempotency_key   TEXT NOT NULL,
  method            TEXT NOT NULL,
  path              TEXT NOT NULL,
  response_status   INTEGER NOT NULL,
  response_body     TEXT NOT NULL,
  created_at        BIGINT NOT NULL,
  expires_at        BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS {{prefix}}idempotency_expires_idx
  ON {{prefix}}idempotency (expires_at);
