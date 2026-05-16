# GateForge Parrot — User Journeys

User journey maps for the three primary personas. Each journey shows screens, actions, system responses, security boundaries, and pain points.

---

## Personas

| Persona | Role | Primary Goals | Key Concerns |
|---------|------|---------------|--------------|
| **Maya** — End User | Knowledge worker using chat for daily tasks | Fast, reliable, private conversations | Privacy, message loss, search |
| **Daniel** — Admin | Platform operator managing tenants, users, integrations | Operability, tenant onboarding, capacity, integration setup | Cannot read content (by design); needs strong metadata + audit |
| **Priya** — Auditor / Compliance Officer | Internal/external auditor verifying security & compliance | Evidence of controls, audit trails, incident review | Tamper-proof logs, scope of access, regulatory mapping |

---

## Persona 1 — Normal User (Maya)

### Journey Map: First-Time Setup → Daily Use

```mermaid
journey
    title Maya's first week with OpenClaw Chat
    section Day 0 — Onboarding
      Receive invite email: 4: Maya
      Set password + recovery phrase: 3: Maya
      See zero-knowledge warning: 2: Maya
      First successful login: 5: Maya
    section Day 1 — First chat
      Create new conversation: 5: Maya
      Send first message: 5: Maya
      See assistant streaming reply: 5: Maya
      Notice "encrypted" indicator: 4: Maya
    section Day 3 — Multi-turn task
      Continue old conversation: 5: Maya
      Reference earlier context: 5: Maya
      AI remembers correctly: 5: Maya
    section Day 5 — Search
      Search across conversations: 3: Maya
      Find old message (client-side): 4: Maya
    section Day 7 — Recovery test
      Test recovery passphrase: 2: Maya
      Confirm access restored: 5: Maya
```

### 1.1 Onboarding Flow

```mermaid
sequenceDiagram
    autonumber
    actor Maya
    participant FE as Browser
    participant API as BFF
    participant DB as Database
    participant Email as Email

    Admin->>API: POST /invite (maya@co.com)
    API->>Email: Send invite link with one-time token
    Email-->>Maya: Invite email
    Maya->>FE: Click invite link
    FE->>API: GET /invite/verify?token=...
    API-->>FE: Show signup form

    Maya->>FE: Enter password
    FE->>FE: Argon2id derive Master Key (MK)
    FE->>FE: Generate auth_hash (separate KDF)
    FE->>FE: Generate recovery passphrase (24 words)
    FE-->>Maya: Display recovery phrase<br/>"Write this down — we cannot recover it"
    Maya->>FE: Confirm phrase saved

    FE->>FE: Wrap MK with login password
    FE->>FE: Wrap MK with recovery passphrase
    FE->>API: POST /signup (auth_hash, wrapped_mk × 2, salts)
    API->>DB: Store user record (no plaintext password, no MK)
    API-->>FE: Issue JWT
    FE-->>Maya: Welcome screen
```

### 1.2 Daily Login

```mermaid
flowchart LR
    A[Enter email + password] --> B[Browser derives auth_hash]
    B --> C[POST /login]
    C --> D{Server verifies auth_hash}
    D -- ok --> E[Receive JWT + wrapped MK]
    E --> F[Browser derives MK via Argon2id]
    F --> G[Unwrap MK locally]
    G --> H[Ready to chat]
    D -- fail --> I[Reject + rate limit]
```

### 1.3 Sending a Message

**Happy path:**

1. Maya opens "Q3 planning" conversation
2. Browser unwraps Conversation Key (CK) with MK
3. Maya types "Summarize last week's notes"
4. Browser encrypts with CK → ciphertext + IV + tag
5. POST `/api/messages` — server stores ciphertext
6. Server requests plaintext over WebSocket (transient)
7. Browser sends plaintext + decrypted recent history
8. Server forwards to OpenClaw, streams response chunks
9. Browser displays streamed tokens
10. On completion, browser encrypts full assistant reply, POSTs ciphertext

**Visible to Maya:**
- Green "🔒 Encrypted" indicator in conversation header
- Streaming response (< 200ms first token)
- Connection status dot (green when WS healthy)

**Invisible but happening:**
- Plaintext lives in server RAM ~ duration of request
- DB receives ciphertext only
- Audit log records: "user X sent message in conv Y at T" (no content)

### 1.4 Edge Cases

| Scenario | UX | Technical |
|----------|-----|----------|
| **Lost password** | "Use recovery phrase" link → enter 24 words → set new password | Browser unwraps MK with recovery KDF, re-wraps with new password |
| **Network drops mid-stream** | "Reconnecting..." badge, response resumes or shows error | WS auto-reconnect with exp backoff; assistant message stored only if complete |
| **Idle 15 min** | App locks, shows "Re-enter password" overlay | MK wiped from memory; need password to derive again |
| **Multiple devices** | Each device requires login + MK derivation | Same MK derived independently from same password |
| **Tab closed mid-message** | Draft lost (intentional — never persisted unencrypted) | No localStorage; only React state |
| **Long conversation (> 50 msgs)** | Older messages hidden behind "Show more"; AI still remembers via summary | Server returns wrapped summary; browser decrypts and prepends to context |

### 1.5 Sharing a Conversation (Optional Feature)

```mermaid
sequenceDiagram
    actor Maya
    actor Bob
    participant FE as Maya's Browser
    participant API as BFF
    participant BFE as Bob's Browser

    Maya->>FE: Share conversation with Bob
    FE->>API: GET /users/bob/public_key
    API-->>FE: Bob's X25519 public key
    FE->>FE: Re-wrap CK with Bob's public key<br/>(ECDH + AES-GCM)
    FE->>API: POST /shares {conv_id, bob_id, wrapped_ck_for_bob}
    API->>API: Store share record

    Bob->>BFE: Open shared conv
    BFE->>API: GET /conversations/:id (as Bob)
    API-->>BFE: ciphertexts + wrapped_ck_for_bob
    BFE->>BFE: Unwrap CK with Bob's private key
    BFE->>BFE: Decrypt messages
    BFE-->>Bob: Read shared conversation
```

---

## Persona 2 — Admin (Daniel)

Daniel manages the platform: tenant onboarding, user provisioning, OpenClaw configuration, monitoring, billing. **He cannot read message content** — that's enforced by cryptography, not policy.

### Journey Map

```mermaid
journey
    title Daniel's admin tasks across a typical week
    section Tenant Onboarding
      Provision new tenant: 4: Daniel
      Configure OpenClaw token: 3: Daniel
      Invite first admin user: 5: Daniel
    section User Management
      Bulk invite users: 4: Daniel
      Reset locked account: 3: Daniel
      Disable departing employee: 5: Daniel
    section Operations
      Check system health: 5: Daniel
      Review rate-limit anomalies: 4: Daniel
      Approve API key request: 5: Daniel
    section Incident
      Investigate failed messages: 2: Daniel
      Coordinate with auditor: 3: Daniel
      Verify metadata only access: 4: Daniel
```

### 2.1 Admin Dashboard — What Daniel Sees

```mermaid
flowchart TB
    subgraph Visible["Admin Can See"]
        Users["User list<br/>email, status, last_login"]
        Convs["Conversation list<br/>id, owner, msg_count, sizes"]
        Metrics["Usage metrics<br/>tokens, requests, latency"]
        Audit["Audit log<br/>actions, IPs, timestamps"]
        Integ["Integrations<br/>API keys (hashed), webhooks"]
        Health["System health<br/>OpenClaw status, DB, Redis"]
    end

    subgraph Hidden["Admin CANNOT See"]
        Content["Message content"]
        Titles["Conversation titles"]
        Summary["Summaries"]
        UserKey["User's Master Key"]
        ConvKey["Unwrapped Conversation Keys"]
        Passwords["Passwords"]
    end

    style Visible fill:#064e3b,color:#fff
    style Hidden fill:#7f1d1d,color:#fff
```

### 2.2 Tenant Onboarding Flow

```mermaid
sequenceDiagram
    autonumber
    actor Daniel
    participant Admin as Admin Console
    participant API as BFF API
    participant Vault as Secrets Vault
    participant DB as Database
    participant Email as Email

    Daniel->>Admin: Create tenant "Acme Corp"
    Admin->>API: POST /tenants {name, openclaw_url, token}
    API->>API: Validate OpenClaw URL reachable
    API->>Vault: Encrypt OpenClaw token (AES-256-GCM)
    Vault-->>API: Encrypted blob
    API->>DB: INSERT tenant (encrypted token)
    API-->>Admin: Tenant ID + initial admin invite token

    Daniel->>Admin: Invite Acme admin (alice@acme.com)
    Admin->>API: POST /invites
    API->>Email: Send invite link
    API->>DB: INSERT audit_log (action: tenant.create + invite.create)
    Admin-->>Daniel: Confirmation: "Acme Corp ready, invite sent"
```

### 2.3 User Management

| Task | UI | What Happens | Audit Entry |
|------|-----|-------------|-------------|
| **Invite user** | Enter email, role | Server generates one-time signup token | `user.invite_sent` |
| **Reset password** | Click "Send reset link" | User receives email; their MK re-derived from new password — **server does NOT regain access to old content** | `user.password_reset_requested` |
| **Disable user** | Toggle "Active" | JWT issuance blocked; existing tokens revoked via Redis blacklist | `user.disabled` |
| **Delete user** | "Delete account" with confirmation | Wipes ciphertext + wrapped keys; **history cryptographically destroyed** | `user.deleted` |
| **Transfer ownership** | Select new owner | Requires user to re-share keys to new owner (cryptographic operation, server cannot do unilaterally) | `conv.share_initiated` |

**Important UX note:** When Daniel "resets" a user's password, the user **loses access to their history** unless they have a recovery passphrase. This must be made painfully clear in the admin UI:

```
⚠️  Resetting Maya's password will lock her out of all existing 
    conversation history. She must use her recovery passphrase 
    to regain access. The platform CANNOT recover encrypted data 
    on her behalf.
    
    [ Cancel ]  [ Send reset link anyway ]
```

### 2.4 Integration Management

```mermaid
sequenceDiagram
    actor Daniel
    actor User as Integration Owner
    participant Admin as Admin Console
    participant API as BFF
    participant DB

    User->>Admin: Request API key for CRM integration
    Admin-->>Daniel: Notification: pending approval
    Daniel->>Admin: Review scope (chat:send, chat:read)
    Daniel->>Admin: Approve with rate limit 100/hr
    Admin->>API: POST /api_keys
    API->>API: Generate key (256-bit), hash with bcrypt
    API->>DB: INSERT api_key (hash only, never plaintext)
    API-->>Admin: Plaintext key (one-time display)
    Admin-->>Daniel: Show key to copy
    Daniel->>User: Securely deliver key (Vault, 1Password, etc.)
    Daniel->>Admin: Mark key as delivered
    DB->>DB: audit_log: api_key.created
```

### 2.5 Operational Monitoring

Daniel has dashboards showing:

- **Throughput** — requests/sec, p50/p95/p99 latency
- **Error rates** — by endpoint, by tenant
- **OpenClaw health** — circuit breaker status, queue depth
- **Storage** — ciphertext volume per tenant, growth rate
- **Rate-limit anomalies** — users hitting limits (signal of abuse or runaway clients)
- **Audit log volume** — sudden spikes = investigation needed

He **cannot** see:
- What users are talking about
- Message keywords or themes
- Sentiment, length distributions of content

### 2.6 Incident Response (Admin Side)

```mermaid
flowchart TD
    A[Alert: 500 errors spiking] --> B{Source?}
    B -- OpenClaw down --> C[Check Tailscale + Gateway]
    B -- DB slow --> D[Check pg_stat + Redis]
    B -- App bug --> E[Check recent deploys]
    
    C --> F[Restart Gateway / reroute]
    D --> G[Add index / scale Redis]
    E --> H[Rollback]
    
    F --> I[Verify recovery in metrics]
    G --> I
    H --> I
    I --> J[Post-mortem with audit timeline]
    J --> K[File incident report]
    
    K --> L{Data breach?}
    L -- No --> M[Internal only]
    L -- Yes --> N[Notify auditor + tenants]
    N --> O[Note: ciphertext only,<br/>plaintext never exposed]
```

---

## Persona 3 — Auditor / Compliance Officer (Priya)

Priya does scheduled compliance reviews and incident investigations. She needs **evidence of controls** — not the ability to break them.

### Journey Map

```mermaid
journey
    title Priya's quarterly audit cycle
    section Preparation
      Receive audit scope: 5: Priya
      Review prior findings: 4: Priya
    section Evidence Collection
      Pull audit logs (read-only): 5: Priya
      Verify encryption controls: 5: Priya
      Sample key wrap operations: 4: Priya
      Review access reviews: 5: Priya
    section Incident Review
      Investigate flagged event: 3: Priya
      Confirm scope of access: 4: Priya
    section Reporting
      Map findings to SOC 2 / GDPR: 5: Priya
      Issue audit report: 5: Priya
```

### 3.1 Audit Role & Access Model

```mermaid
flowchart TB
    Priya([Auditor])
    
    subgraph AccessLayer["Audit Access Layer (read-only, tamper-evident)"]
        AuditAPI["/audit API<br/>(separate JWT scope)"]
        AuditView["Audit dashboard<br/>(filtered views)"]
    end

    subgraph DataSources["Data Sources (immutable)"]
        AuditLog[(audit_log table<br/>append-only)]
        Metrics[(metrics<br/>Prometheus)]
        Backups[(backup manifests)]
        Configs[(IaC + config history<br/>Git)]
    end

    subgraph NoAccess["Out of Scope"]
        Content["Message ciphertext"]
        Plain["Plaintext anywhere"]
        Keys["Master Keys / CKs"]
    end

    Priya --> AuditAPI
    AuditAPI --> AuditView
    AuditView --> AuditLog
    AuditView --> Metrics
    AuditView --> Backups
    AuditView --> Configs
    
    Priya -.cannot access.-> NoAccess

    style NoAccess fill:#7f1d1d,color:#fff
    style AccessLayer fill:#1e3a8a,color:#fff
```

### 3.2 What's in the Audit Log

Every entry is **append-only** (PostgreSQL with `INSERT`-only role) and **hash-chained** (each entry includes hash of previous, like a Merkle log) to prove non-tampering.

| Field | Example |
|-------|---------|
| `id` | UUID |
| `timestamp` | 2026-05-16T10:23:45Z |
| `actor_id` | user UUID or "system" |
| `actor_type` | user / admin / api_key / system |
| `action` | `user.login`, `conv.create`, `key.unwrap`, `api_key.created`, `admin.tenant_create` |
| `resource_type` | user / conversation / message / api_key / tenant |
| `resource_id` | UUID (no content) |
| `ip_address` | hashed if regulatory requires |
| `user_agent` | string |
| `result` | success / failure / partial |
| `details` | jsonb metadata (no plaintext) |
| `prev_hash` | sha256(previous entry) |
| `entry_hash` | sha256(this entry) |

### 3.3 Quarterly Compliance Review Flow

```mermaid
sequenceDiagram
    autonumber
    actor Priya
    participant Audit as Audit Console
    participant API as BFF API
    participant Log as audit_log

    Priya->>Audit: Log in with auditor role
    Audit->>API: Verify scope: audit:read
    API-->>Audit: JWT with audit-only claims

    Priya->>Audit: Export Q1 audit log (CSV)
    Audit->>API: GET /audit?from=2026-01-01&to=2026-03-31
    API->>Log: SELECT with pagination
    Log-->>API: Rows + hash chain
    API->>API: Verify hash chain integrity
    API-->>Audit: Signed CSV + integrity report

    Priya->>Audit: Verify "no admin read content" claim
    Audit->>API: GET /audit?action=message.read
    API-->>Audit: Zero rows for admin actors

    Priya->>Audit: Review key operations sample
    Audit->>API: GET /audit?action=key.unwrap LIMIT 100
    API-->>Audit: Sample with actor + resource (no key material)

    Priya->>Audit: Generate compliance report
    Audit-->>Priya: PDF: controls evidence + findings
```

### 3.4 Incident Investigation Flow

Scenario: Maya reports a suspicious login. Priya investigates.

```mermaid
flowchart TD
    A[Maya reports: unknown device login] --> B[Priya opens audit console]
    B --> C[Filter: actor=maya, action=user.login, last 30d]
    C --> D[Identify anomaly: login from new IP at 03:00]
    D --> E[Pivot: filter all actions from that session_id]
    E --> F{What did the session do?}
    F -- created messages --> G[Confirm ciphertext exists<br/>but content unknowable]
    F -- changed settings --> H[List config changes]
    F -- attempted key unwrap --> I[Verify auth_hash was correct]
    
    G --> J[Document: timeline + scope]
    H --> J
    I --> J
    
    J --> K[Issue findings + remediation]
    K --> L[Maya rotates password]
    L --> M[Force logout all sessions]
    M --> N[Verify audit shows lockout]
```

### 3.5 What Priya Can Prove (and What She Cannot)

**She can prove:**
- ✅ No admin actor performed `message.read` actions
- ✅ All key operations are logged with actor + timestamp
- ✅ Audit log is tamper-evident (hash chain valid)
- ✅ All API keys have scope + rate limits + expiry
- ✅ User access reviews happened on schedule
- ✅ Encryption is applied at message-write time (sample inspections show ciphertext only)
- ✅ Backup encryption keys are separate from app keys
- ✅ TLS 1.3 enforced (config audit)

**She cannot:**
- ❌ Read any message content (by cryptographic design)
- ❌ Compel server to decrypt (server has no decryption capability)
- ❌ Discover what users said even with subpoena, **unless escrow keys are configured** (policy decision)

### 3.6 Regulatory Mapping

| Regulation | Control | Evidence |
|------------|---------|----------|
| GDPR Art 32 | Encryption + pseudonymization | DB schema review + sample ciphertext |
| GDPR Art 17 | Right to erasure | `user.deleted` audit entries + ciphertext deletion check |
| GDPR Art 33 | Breach notification | Incident response runbook + drills |
| SOC 2 CC6.1 | Logical access controls | RBAC config + audit log of access reviews |
| SOC 2 CC6.7 | Restricted physical access | Cloud provider attestation |
| SOC 2 CC7.2 | System monitoring | Metrics + alerts evidence |
| HIPAA §164.312(a)(1) | Access control | Authentication logs |
| HIPAA §164.312(e)(1) | Transmission security | TLS config + cipher audit |
| ISO 27001 A.10 | Cryptography | This SECURITY.md + key management procedures |

---

## Cross-Persona Touchpoints

```mermaid
flowchart LR
    Maya([Maya - User])
    Daniel([Daniel - Admin])
    Priya([Priya - Auditor])
    
    Maya -- "report suspicious login" --> Daniel
    Daniel -- "investigate + escalate" --> Priya
    Priya -- "findings + recommendations" --> Daniel
    Daniel -- "policy / control updates" --> Maya
    
    Maya -- "request integration" --> Daniel
    Daniel -- "approve + provision API key" --> Maya
    Priya -- "audit api_key.created events" --> Daniel
    
    Maya -- "lost password" --> Daniel
    Daniel -- "send reset (cannot recover content)" --> Maya
    Priya -- "verify password resets don't expose content" --> Daniel

    style Maya fill:#1e3a8a,color:#fff
    style Daniel fill:#92400e,color:#fff
    style Priya fill:#5b21b6,color:#fff
```

---

## UX Principles Across All Journeys

1. **Transparency about zero-knowledge.** Every irreversible action ("delete user", "reset password", "delete conversation") shows a clear warning about cryptographic finality.
2. **Recovery is opt-in.** Users explicitly choose recovery method on signup; no silent backdoors.
3. **Audit trails are first-class UX.** Every admin action shows "this will be logged as X" before confirmation.
4. **Status indicators everywhere.** Encryption state, connection health, sync status — always visible, never alarming.
5. **No surprise data exposure.** Anything visible to admin/auditor is documented in this file. New features must update this doc.

---

*User journeys for the GateForge Parrot — covering end users, admins, and auditors with zero-knowledge encryption as a first-class constraint.*
