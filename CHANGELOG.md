# Changelog

All notable changes to GateForge Parrot will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Design — Phase 2 (Integration API + Session Management)
- `INTEGRATION_API.md` — full Phase 2 design spec with 7 Mermaid diagrams (architecture, workflow, state, sequence, ER, data-flow, user journey)
- Chat session management: list / create / rename / pin / archive / delete / export / search (titles are encrypted client-side, hard delete uses crypto-shred)
- Scoped API key system with Bearer auth, idempotency, per-key + per-tenant rate limiting
- `@gateforge/parrot-sdk` JS SDK + reference WebCrypto wire format spec
- Outbound webhooks (HMAC-signed, metadata only, retry with backoff)
- Static `openapi.yaml` 3.1 spec with drift CI check
- Public surface fully renamed from `parrot` → `gateforge-parrot` (URL paths, DB tables, env vars, log tags, code identifiers) — clean-slate since pre-1.0 with no production deployments

### Next: v0.2.0 (Phase 2 — Implementation)
- Wire `llm_input` / `llm_output` hooks to stream assistant responses through SSE
- Build session management UI + REST endpoints
- Ship `@gateforge/parrot-sdk` to npm
- Outbound webhook dispatcher + delivery log

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
