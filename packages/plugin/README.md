# @gateforge/parrot-openclaw 🦜

Zero-knowledge end-to-end encrypted chat channel for [OpenClaw](https://openclaw.ai).

The server stores only **ciphertext** and **wrapped keys**. Even an admin with full database access cannot read your conversations.

## Install

```bash
# In your OpenClaw extensions directory (or anywhere npm-reachable)
npm install @gateforge/parrot-openclaw
```

Then register it in `~/.openclaw/openclaw.json`:

```jsonc
{
  "plugins": {
    "entries": {
      "gateforge-parrot": {
        "enabled": true,
        "publicBaseUrl": "https://parrot.example.com",
        "auth": {
          "jwtSecret": "${GATEFORGE_PARROT_JWT_SECRET}",
          "registration": "open"
        },
        "database": {
          "driver": "auto"
        },
        "tenancy": {
          "mode": "multi"
        }
      }
    },
    "allow": ["gateforge-parrot"]
  }
}
```

Generate a JWT secret:

```bash
export GATEFORGE_PARROT_JWT_SECRET="$(openssl rand -base64 48)"
```

Restart OpenClaw. The plugin will:
1. Auto-detect your database driver (PostgreSQL or SQLite) from OpenClaw's own config.
2. Run schema migrations under the `gateforge_parrot_*` table namespace.
3. Mount the API at `/gateforge-parrot/api/v1/*` and the web UI at `/gateforge-parrot/ui`.

## What you get

- **Web UI** at `/gateforge-parrot/ui` — sign up, sign in, chat (all encryption happens in the browser).
- **REST API** at `/gateforge-parrot/api/v1/*` — auth, conversations, messages.
- **WebSocket** at `/gateforge-parrot/ws` — low-latency message streaming (Phase 2).

## Security model

- **Argon2id** key derivation in the browser (m=64MiB, t=3, p=4).
- **AES-256-GCM** for message encryption (one fresh key per conversation).
- **AES-KW** for wrapping conversation keys with the master key.
- **Hash-chained audit log** for tamper evidence.

See [`SECURITY.md`](https://github.com/tonylnng/gateforge-parrot-openclaw/blob/main/SECURITY.md) for the full threat model.

## Configuration reference

| Path | Default | Description |
|------|---------|-------------|
| `enabled` | `true` | Master switch. |
| `publicBaseUrl` | — | Public URL for CORS / invite links. |
| `ui.enabled` | `true` | Serve bundled UI at `/gateforge-parrot/ui`. |
| `ui.basePath` | `/gateforge-parrot/ui` | Mount path. |
| `api.basePath` | `/gateforge-parrot/api/v1` | REST mount path. |
| `api.wsPath` | `/gateforge-parrot/ws` | WebSocket mount path. |
| `auth.jwtSecret` | — (required) | HMAC secret. Min 32 chars. |
| `auth.registration` | `invite-only` | `open` \| `invite-only` \| `closed`. |
| `database.driver` | `auto` | `auto` \| `postgres` \| `sqlite`. |
| `database.url` | inherit | Override DB connection string. |
| `database.schemaPrefix` | `gateforge_parrot_` | Table-name prefix. |
| `tenancy.mode` | `multi` | `multi` \| `single`. |
| `audit.enabled` | `true` | Write audit log entries. |
| `audit.hashChain` | `true` | Tamper-evident hash chain. |

## License

MIT © Tony Lung / GateForge 2026.
