# Changelog

All notable changes to GateForge Parrot will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Next: v0.4.0 (Phase 4 — Embeddable widget)
- `<script>` drop-in widget + iframe host SDK
- postMessage bridge that keeps the Master Key in the parent origin
- Embed allow-list managed through the admin panel

---

## [0.3.0] — 2026-05-16

### Added — Phase 3 (Admin Panel + Streaming UI)
- **`Admin.tsx`** (~820 lines) — three-tab admin panel served at `/gateforge-parrot/ui?admin=1`:
  - **API keys** — list, issue (one-time plaintext banner), edit (label + scopes inline), revoke
  - **Webhooks** — list, create (one-time secret banner), send ping, expandable deliveries panel, delete
  - **Audit log** — paginated (50/page, cursor-driven), action filter, `Verify chain` button calling `GET /audit/verify` with success / break banner
- **Assistant SSE streaming in the chat UI** — `Chat.tsx` now consumes `streamMessage()` from `lib/api.ts` (async generator over Server-Sent Events). Optimistic user bubble + placeholder assistant bubble that decrypts each `chunk` per-frame and is renamed to the server-issued message id on `done`.
- `useRoute()` hook in `App.tsx` — lightweight `?admin=1` toggle between Chat and Admin views (no router dependency).
- Admin theme styles in `app.css` aligned with the existing dark/light palette (`.admin`, `.panel`, `.data-table`, `.chip`, `.banner`, `.token-display`, …).

### Changed
- `README.md` roadmap and project-status sections updated to reflect Phases 1–3 shipped + new “Shipped surface” Mermaid diagram.

---

## [0.2.0] — 2026-05-16

### Added — Phase 2 (Integration API + Session Management)

#### Sessions & messages
- Full session lifecycle endpoints: `GET /conversations`, `POST /conversations`, `GET /conversations/:id`, `PATCH /conversations/:id` (rename / pin / archive), `DELETE /conversations/:id` (crypto-shred), `GET /conversations/:id/export` (5000-message cap, audited as `conversation.export`).
- Sessions sidebar UI — search, pin / archive / rename / delete, encrypted titles (client-side only).
- `POST /conversations/:id/messages` — send (idempotent via `Idempotency-Key`).
- **`POST /conversations/:id/messages/stream`** — SSE streaming wired to `llm_input` / `llm_output` hooks; ciphertext-in / re-encrypted-token-out, never persisted in plaintext.

#### Scoped API keys
- `GET /apikeys`, `POST /apikeys` (one-time plaintext token), `PATCH /apikeys/:id` (rename + scopes, 409 on revoked, audits `apikey.patch`), `DELETE /apikeys/:id` (revoke).
- Bearer auth + scope catalogue: `conversations:read|write|delete`, `messages:read|send|stream`, `apikeys:manage`, `webhooks:manage`, `audit:read`, `agents:read`.

#### Webhooks
- `GET /webhooks`, `POST /webhooks` (one-time HMAC secret banner), `POST /webhooks/:id/test`, `GET /webhooks/:id/deliveries` (100 newest), `DELETE /webhooks/:id`.
- Outbound dispatcher with HMAC-SHA-256 signing, exponential-backoff retries, and a delivery log (status, response, error).

#### Agents & audit
- `GET /agents`, `GET /agents/:id` — config-driven descriptors (the `enabled` flag is stripped before serialization).
- `GET /audit` — cursor pagination (50 default / 200 max), `action` + `actorId` filters, base64(`createdAt`) cursor.
- `GET /audit/verify` — hash-chain verifier (10 000-row cap) returning `{ ok, checked, hashChainEnabled, breakAt?, expected?, actual? }`.

#### Cross-cutting
- **Request-id propagation** — every response carries `X-Request-Id` / `X-Parrot-Request-Id`, and the id is threaded into logs, error envelopes, and `sendError()`.
- **Standard rate-limit headers** — `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` on every limited route (legacy headers preserved for one release).
- **Idempotency middleware** — `Idempotency-Key` cached per-key for 24 h on `POST /messages` and `POST /webhooks`.
- **Per-key + per-tenant token-bucket rate limiter** with configurable burst / refill.

#### Spec & SDK
- **`@gateforge/parrot-sdk`** workspace package — typed REST client + WebCrypto helpers; methods cover all 29 operations.
- **`openapi.yaml` 3.1** — single source of truth, 29 operations, 8 schemas added in Phase 2 closeout (`SessionExport`, `WebhookDelivery`, `AgentDescriptor`, `AuditEntry`, `AuditPage`, `AuditVerifyResult`, `PatchApiKeyInput`, …).
- **`WIRE_FORMAT.md`** — headers (`X-Request-Id`, `X-RateLimit-*`, `Idempotency-Key`), error envelope (with `requestId`), SSE framing, multi-tenancy notes.
- **Drift CI** — `scripts/check-openapi-drift.mjs` enforces `router.ts` ↔ `openapi.yaml` parity (currently 29 / 29 in sync).

#### Naming refresh
- Public surface fully renamed `parrot` → `gateforge-parrot` (URL paths, DB tables, env vars, log tags, code identifiers). Clean-slate, since the project was pre-1.0 with no production deployments.

---

## [0.1.0] — 2026-05-16

### Added — Phase 1 (Plugin Skeleton + Bundled UI)
- **`@gateforge/parrot-openclaw`** npm package with compiled `dist/`, migrations, and bundled UI
- **`@gateforge/parrot-ui`** React 18 + Vite frontend, served at `/gateforge-parrot/ui`
- `openclaw.plugin.json` manifest with full JSON Schema for configuration
- Drizzle ORM schema and raw-SQL migrations for both PostgreSQL and SQLite
- Auto-detect database driver from OpenClaw's runtime config
- Auth: signup, login, refresh, logout, whoami — with Argon2id password hashing
- JWT issuance via `jose` (HS256), refresh-token rotation, revocation tracking
- Multi-tenant from day 1: tenant table + JWT tenant scoping
- Conversations + messages REST API (server stores only ciphertext)
- Browser-side crypto: Argon2id KDF (`hash-wasm`), AES-256-GCM, AES-KW key wrapping
- Tamper-evident hash-chained audit log
- WebSocket scaffold at `/gateforge-parrot/ws` (frame echo + auth verification)
- Static-file SPA server with fallback stub when UI bundle is absent
- `INSTALL.md` step-by-step guide for OpenClaw operators

---

## [0.0.1] — 2026-05-16

### Added — Design Phase
- `ARCHITECTURE.md` — system architecture with workflow, state, sequence, DFD, and ER diagrams
- `SECURITY.md` — zero-knowledge E2EE design with threat model and compliance mapping
- `USER_JOURNEYS.md` — user, admin, and auditor personas with end-to-end flows
- `PLUGIN_DESIGN.md` — OpenClaw channel plugin architecture (`openclaw/plugin-sdk`)
- `poc/crypto.ts` — working TypeScript proof-of-concept for AES-256-GCM + AES-KW + Argon2id
- Initial README and project metadata

### Design Decisions
- **Channel plugin** (not standalone service) — runs in-process with OpenClaw
- **Zero-knowledge E2EE** — even admins cannot read messages
- **Web Crypto API** for browser-side encryption (non-extractable keys)
- **Argon2id** KDF (m=64MB, t=3, p=4) for password-based key derivation
- **Hash-chained audit log** for tamper-evidence
- **Mermaid** for all diagrams (renders natively on GitHub)
