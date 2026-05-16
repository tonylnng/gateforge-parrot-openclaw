# Changelog

All notable changes to GateForge Parrot will be documented in this file.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Planned for v0.1.0 (Phase 1 — Plugin Skeleton)
- Plugin manifest (`openclaw.plugin.json`)
- Drizzle schema + migrations for `parrot_*` tables
- JWT-based authentication
- Basic encrypted message storage
- HTTP route registration via OpenClaw plugin SDK

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
