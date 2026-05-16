# Installing GateForge Parrot 🦜

This guide walks you through installing the plugin on a running OpenClaw instance via `npm`.

## Prerequisites

- OpenClaw `>=2026.3.24-beta.2` running on Node.js 20+ (Node 22+ recommended).
- Either:
  - **Native install**: filesystem access to OpenClaw's working directory, OR
  - **User-installed plugin**: write access to `~/.openclaw/extensions/`.

## Step 1 — Install the package

From OpenClaw's extensions directory:

```bash
cd ~/.openclaw/extensions
npm init -y    # only if this directory is empty
npm install @gateforge/parrot-openclaw
```

The package is published as ESM and includes its compiled `dist/`, migrations, and the bundled web UI under `ui-dist/`.

## Step 2 — Generate a JWT secret

```bash
openssl rand -base64 48 > ~/.openclaw/parrot.secret
chmod 600 ~/.openclaw/parrot.secret
export PARROT_JWT_SECRET="$(cat ~/.openclaw/parrot.secret)"
```

You'll want to add the `export` line to your shell's startup file (e.g. `~/.zshrc`) or to OpenClaw's systemd unit if you've set one up.

## Step 3 — Configure OpenClaw

Edit `~/.openclaw/openclaw.json` and add a `plugins.entries["gateforge-parrot"]` block:

```jsonc
{
  // ... your existing config ...
  "plugins": {
    "entries": {
      "gateforge-parrot": {
        "enabled": true,
        "publicBaseUrl": "https://your-parrot-url.example.com",
        "auth": {
          "jwtSecret": "${PARROT_JWT_SECRET}",
          "registration": "open"
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
    },
    "allow": ["gateforge-parrot"]
  }
}
```

### Configuration choices

- **`publicBaseUrl`**: the URL users open in their browser. For Tailscale users, this is typically `https://<machine>.<tailnet>.ts.net:<port>`.
- **`auth.registration`**:
  - `open` — anyone can sign up.
  - `invite-only` — sign-up requires a valid invite token (Phase 2).
  - `closed` — no new accounts; admins must provision users via CLI.
- **`database.driver = "auto"`** inherits OpenClaw's database driver. To override, set `database.driver` to `postgres` or `sqlite` and provide `database.url`.

## Step 4 — Restart OpenClaw

```bash
openclaw restart
# or, if you use systemd:
sudo systemctl restart openclaw
```

You should see in the logs:

```
[parrot] Database ready (driver=sqlite, prefix=parrot_)
[parrot] HTTP routes registered under /parrot/api/v1
[parrot] GateForge Parrot 🦜 loaded — channel='parrot', tenancy=multi
[parrot] Parrot ready on channel 'parrot'
```

## Step 5 — Open the UI

Visit `https://your-parrot-url.example.com/parrot/ui` in your browser.

- Click **Sign up** to create the first account.
- Pick a strong password — it's used to derive your encryption key locally. **If you forget it, your chats cannot be recovered.**

## Health check

```bash
curl https://your-parrot-url.example.com/parrot/api/v1/health
# → {"status":"ok","plugin":"gateforge-parrot","version":"0.1.0"}
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `Configuration invalid: auth.jwtSecret must be set` | `PARROT_JWT_SECRET` not exported when OpenClaw started | Export and restart. |
| `/parrot/ui` shows the stub page | UI bundle missing | Reinstall the package; check `node_modules/@gateforge/parrot-openclaw/ui-dist/index.html` exists. |
| `database.url must start with 'postgres://'` | Wrong driver string | Match `driver` to your URL scheme. |
| Sign-in succeeds but messages show `[decryption failed]` | Master key wasn't re-derived (wrong password, or salt changed) | Sign out, sign in again with the original password. |

## Upgrading

```bash
cd ~/.openclaw/extensions
npm install @gateforge/parrot-openclaw@latest
# Migrations run automatically on next restart.
openclaw restart
```

## Uninstalling

```bash
cd ~/.openclaw/extensions
npm uninstall @gateforge/parrot-openclaw
```

Then remove the `gateforge-parrot` entry from `openclaw.json`. The `parrot_*` tables will remain in your database — drop them manually if you want a full wipe.
