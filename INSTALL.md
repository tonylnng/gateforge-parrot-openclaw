# Installing GateForge Parrot 🦜

This guide walks you through installing the plugin on a running OpenClaw instance.

## Architecture at a Glance

Parrot is **not a standalone server** — it's a channel plugin that piggybacks on your existing OpenClaw gateway:

```
OpenClaw Gateway (e.g. https://your-host:18789)
│
├─ /gateforge-parrot/ui       ← React UI (bundled)
├─ /gateforge-parrot/api/v1   ← REST API
└─ /gateforge-parrot/ws       ← WebSocket endpoint
```

So your **Parrot URL = OpenClaw gateway URL + `/gateforge-parrot/ui`**. You do not run a separate web server.

## Prerequisites

- OpenClaw `>=2026.3.24-beta.2` (use `openclaw --version` to check)
- Node.js 20+ (Node 22+ recommended)
- The OpenClaw gateway must already be reachable at a URL you know (LAN, Tailscale, or public)

## Install paths

You can choose any of the following — all four are supported by `openclaw plugins install`.

| Method | When to use | Command |
|---|---|---|
| **Local directory** | Recommended for self-hosting today | `openclaw plugins install ./packages/plugin` |
| **Local symlink (dev)** | Active development, hot edits | `openclaw plugins install -l ./packages/plugin` |
| **Git URL** (OpenClaw v2026.5.2+) | Install straight from GitHub | `openclaw plugins install git+https://github.com/tonylnng/gateforge-parrot-openclaw.git` |
| **npm registry** | Once `@gateforge/parrot-openclaw` is published | `openclaw plugins install @gateforge/parrot-openclaw` |

The walkthrough below uses the **local directory** path, which works today without publishing.

---

## Step 1 — Clone and build

```bash
git clone https://github.com/tonylnng/gateforge-parrot-openclaw.git
cd gateforge-parrot-openclaw
npm install
npm run build:all
```

`build:all` compiles the React UI (`packages/ui`) and the plugin (`packages/plugin`), copying the UI bundle into `packages/plugin/ui-dist/`.

## Step 2 — Install the plugin into OpenClaw

```bash
openclaw plugins install ./packages/plugin
```

OpenClaw copies the package to `~/.openclaw/plugins/gateforge-parrot/` and registers it. Verify with:

```bash
openclaw plugins list
# Should show: gateforge-parrot  0.1.0  channel
```

## Step 3 — Generate a JWT secret

```bash
openssl rand -base64 48
```

Copy the output — you'll paste it into the config in Step 4.

## Step 4 — Configure OpenClaw

Edit `~/.openclaw/openclaw.json` and add a `plugins.entries["gateforge-parrot"]` block. Replace `publicBaseUrl` with **your own gateway URL** and `jwtSecret` with the value from Step 3:

```jsonc
{
  // ... your existing config ...
  "plugins": {
    "allow": ["gateforge-parrot"],
    "entries": {
      "gateforge-parrot": {
        "enabled": true,
        "publicBaseUrl": "https://your-openclaw-gateway:18789",
        "auth": {
          "jwtSecret": "PASTE_OPENSSL_OUTPUT_HERE",
          "registration": "invite-only"
        },
        "database": {
          "driver": "auto"
        },
        "tenancy": {
          "mode": "multi"
        },
        "audit": {
          "enabled": true,
          "hashChain": true
        }
      }
    }
  }
}
```

### `publicBaseUrl` examples

| Setup | Example value |
|---|---|
| Tailscale (no public IP) | `https://your-host.your-tailnet.ts.net:18789` |
| LAN only | `http://192.168.1.50:18789` |
| Public domain with reverse proxy | `https://parrot.example.com` |

### Configuration choices

- **`auth.registration`**:
  - `open` — anyone can sign up.
  - `invite-only` — sign-up requires a valid invite token (recommended; Phase 2 feature).
  - `closed` — no new accounts; admins must provision users via CLI.
- **`database.driver = "auto"`** inherits OpenClaw's database driver (Postgres or SQLite). To override, set `database.driver` to `postgres` or `sqlite` and provide `database.url`.
- **`tenancy.mode = "multi"`** isolates users per tenant from Day 1. Use `"single"` only for single-user demos.

### Keeping the secret out of the config file (optional)

If you'd rather not paste the JWT secret into `openclaw.json`, export it as an env var instead:

```bash
export GATEFORGE_PARROT_JWT_SECRET="$(openssl rand -base64 48)"
```

Then use `"jwtSecret": "${GATEFORGE_PARROT_JWT_SECRET}"` in the config. Add the `export` line to your shell startup file or OpenClaw's systemd unit so it persists across restarts.

## Step 5 — Restart the gateway

```bash
openclaw gateway restart
```

You should see in the logs:

```
[gateforge-parrot] Database ready (driver=sqlite, prefix=parrot_)
[gateforge-parrot] HTTP routes registered under /gateforge-parrot/api/v1
[gateforge-parrot] GateForge Parrot 🦜 loaded — channel='parrot', tenancy=multi
[gateforge-parrot] Parrot ready on channel 'parrot'
```

## Step 6 — Open the UI

Visit `<publicBaseUrl>/gateforge-parrot/ui` in your browser, e.g.:

```
https://your-host.your-tailnet.ts.net:18789/gateforge-parrot/ui
```

- Click **Sign up** to create the first account.
- Pick a strong password — it's used to derive your encryption key locally. **If you forget it, your chats cannot be recovered.**

## Health check

```bash
curl <publicBaseUrl>/gateforge-parrot/api/v1/health
# → {"status":"ok","plugin":"gateforge-parrot","version":"0.1.0"}
```

---

## Quick reference — what goes where

| Setting | Location | Your value |
|---|---|---|
| `publicBaseUrl` | `openclaw.json` | Your OpenClaw gateway URL |
| `auth.jwtSecret` | `openclaw.json` or env | `openssl rand -base64 48` |
| Database | Auto-detected | Inherits from OpenClaw |
| UI mount path | Default | `/gateforge-parrot/ui` |
| API mount path | Default | `/gateforge-parrot/api/v1` |
| Multi-tenant | Default | ON |
| Registration | Configurable | `invite-only` recommended |

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `Configuration invalid: auth.jwtSecret must be set` | JWT secret missing or under 32 chars | Regenerate with `openssl rand -base64 48` and update config. |
| `/gateforge-parrot/ui` shows the stub page | UI bundle missing | Re-run `npm run build:all`, then `openclaw plugins install ./packages/plugin` again. |
| `database.url must start with 'postgres://'` | Wrong driver string | Match `driver` to your URL scheme, or use `driver: "auto"`. |
| Sign-in succeeds but messages show `[decryption failed]` | Master key wasn't re-derived (wrong password, or salt changed) | Sign out, sign in again with the original password. |
| `openclaw plugins install` reports unknown command | OpenClaw version too old | Upgrade to `>=2026.3.24-beta.2`. |

## Upgrading

### From local clone

```bash
cd gateforge-parrot-openclaw
git pull
npm install && npm run build:all
openclaw plugins install ./packages/plugin   # re-install over the top
openclaw gateway restart
```

### From npm (once published)

```bash
openclaw plugins install @gateforge/parrot-openclaw@latest
openclaw gateway restart
```

Migrations run automatically on next restart.

## Uninstalling

```bash
openclaw plugins uninstall gateforge-parrot
```

Then remove the `gateforge-parrot` entry from `openclaw.json`. The `gateforge_parrot_*` tables will remain in your database — drop them manually if you want a full wipe.
