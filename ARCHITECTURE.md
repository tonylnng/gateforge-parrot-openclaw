# GateForge Parrot — Architecture

A secure, embeddable chat platform that proxies OpenClaw Gateway, manages conversations, and exposes a standardized API for third-party integrations.

---

## Table of Contents

1. [High-Level Architecture](#high-level-architecture)
2. [Workflow Diagram](#workflow-diagram)
3. [State Diagram](#state-diagram)
4. [Sequence Diagram](#sequence-diagram)
5. [Data Flow Diagram](#data-flow-diagram)
6. [ER Diagram](#er-diagram)
7. [Tech Stack](#tech-stack)
8. [Project Structure](#project-structure)
9. [Implementation Phases](#implementation-phases)

---

## High-Level Architecture

```mermaid
flowchart TB
    subgraph Clients["Client Layer"]
        WebUI["Web Chat UI<br/>(React)"]
        ThirdParty["3rd Party System<br/>(CRM / ERP)"]
        Mobile["Mobile App"]
        Embed["Embedded Widget<br/>(iframe / JS SDK)"]
    end

    subgraph BFF["Chat BFF API Gateway (Node.js + Fastify)"]
        Auth["Auth Service<br/>JWT + API Key"]
        Session["Session Manager"]
        Context["Context Manager<br/>+ Summarizer"]
        RateLimit["Rate Limiter"]
        Audit["Audit Logger"]
        Proxy["OpenClaw Proxy<br/>(holds server token)"]
    end

    subgraph Data["Data Layer"]
        Postgres[("PostgreSQL<br/>conversations<br/>messages<br/>users")]
        Redis[("Redis<br/>cache + rate limit")]
        Vault["Secrets Vault<br/>(encrypted tokens)"]
    end

    subgraph External["External"]
        OpenClaw["OpenClaw Gateway<br/>(via Tailscale)"]
    end

    WebUI -->|JWT| Auth
    ThirdParty -->|API Key| Auth
    Mobile -->|JWT| Auth
    Embed -->|JWT| Auth

    Auth --> Session
    Session --> RateLimit
    RateLimit --> Context
    Context --> Proxy
    Proxy --> OpenClaw

    Context <--> Postgres
    Context <--> Redis
    Session <--> Redis
    Proxy <--> Vault
    Auth --> Audit
    Audit --> Postgres

    style BFF fill:#1e293b,stroke:#06b6d4,color:#fff
    style Data fill:#0f172a,stroke:#06b6d4,color:#fff
    style External fill:#451a03,stroke:#f59e0b,color:#fff
```

---

## Workflow Diagram

End-to-end user journey from registration to multi-turn conversation.

```mermaid
flowchart TD
    Start([User opens app]) --> HasAccount{Has account?}
    HasAccount -- No --> Register[Register]
    HasAccount -- Yes --> Login[Login]
    Register --> IssueToken[Issue JWT 15min<br/>+ Refresh Token 7d]
    Login --> IssueToken
    IssueToken --> OpenWS[Open WebSocket<br/>with JWT]
    OpenWS --> WSConnected{WS connected?}
    WSConnected -- No --> Retry[Exponential backoff retry]
    Retry --> OpenWS
    WSConnected -- Yes --> SelectConv[Select / Create<br/>Conversation]
    SelectConv --> SendMsg[User sends message]

    SendMsg --> VerifyJWT[Verify JWT]
    VerifyJWT --> CheckRate{Rate limit OK?}
    CheckRate -- No --> Reject[Return 429]
    CheckRate -- Yes --> BuildCtx[Build context:<br/>summary + recent N msgs]
    BuildCtx --> Forward[Forward to OpenClaw<br/>with server token]
    Forward --> Stream[Stream response<br/>to client]
    Stream --> Persist[(Save user_msg<br/>+ assistant_msg)]
    Persist --> CheckCount{Msg count<br/>> threshold?}
    CheckCount -- Yes --> Summarize[Background<br/>summarization job]
    CheckCount -- No --> Wait[Wait for next msg]
    Summarize --> Wait
    Wait --> SendMsg

    style Start fill:#06b6d4,color:#000
    style Persist fill:#1e293b,color:#fff
    style Summarize fill:#f59e0b,color:#000
    style Reject fill:#dc2626,color:#fff
```

---

## State Diagram

Connection and session lifecycle for the chat client.

```mermaid
stateDiagram-v2
    [*] --> Unauthenticated

    Unauthenticated --> Authenticating: login()
    Authenticating --> Authenticated: success
    Authenticating --> Unauthenticated: failure

    Authenticated --> Connecting: openWebSocket()
    Connecting --> Connected: onOpen + auth ack
    Connecting --> Error: timeout / unauthorized

    Connected --> Streaming: sendMessage()
    Streaming --> Connected: response complete
    Streaming --> Error: stream error

    Connected --> TokenExpired: 401 received
    TokenExpired --> Connecting: refreshToken() success
    TokenExpired --> Unauthenticated: refresh failed

    Error --> Connecting: retry (backoff)
    Error --> Unauthenticated: max retries

    Connected --> Closed: logout() / close()
    Streaming --> Closed: logout()
    Closed --> [*]

    note right of Streaming
        Receives chunks via SSE/WS
        Updates UI incrementally
    end note

    note right of TokenExpired
        Refresh token used to
        obtain new JWT
    end note
```

---

## Sequence Diagram

Message send flow with context management and persistence.

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant FE as Frontend
    participant BFF as BFF API
    participant Redis
    participant PG as PostgreSQL
    participant OC as OpenClaw Gateway

    User->>FE: Type message + Enter
    FE->>BFF: POST /api/messages<br/>(JWT + content)
    BFF->>BFF: Verify JWT
    BFF->>Redis: Check rate limit
    Redis-->>BFF: allowed

    BFF->>Redis: GET context cache
    alt Cache hit
        Redis-->>BFF: cached context
    else Cache miss
        BFF->>PG: SELECT messages + summary
        PG-->>BFF: history rows
        BFF->>Redis: SET context (TTL 5min)
    end

    BFF->>BFF: Build prompt:<br/>system + summary + recent N

    BFF->>OC: WebSocket chat.send<br/>(server token)
    activate OC

    loop streaming chunks
        OC-->>BFF: chunk
        BFF-->>FE: SSE / WS chunk
        FE-->>User: Render token
    end

    OC-->>BFF: stream end
    deactivate OC

    BFF->>PG: INSERT user_msg + assistant_msg
    BFF->>Redis: Update context cache

    opt msg_count > threshold
        BFF->>BFF: Enqueue summarization job
        Note over BFF,PG: Background worker<br/>summarizes old messages<br/>and stores in summaries table
    end

    BFF->>PG: INSERT audit_log
```

---

## Data Flow Diagram

DFD Level 1 — how data moves through the system.

```mermaid
flowchart LR
    User([User / External System]) -->|raw message| P1

    subgraph Processes
        P1["1.0 Authenticate<br/>verify JWT / API key"]
        P2["2.0 Rate Limit Check<br/>sliding window"]
        P3["3.0 Context Builder<br/>summary + recent msgs"]
        P4["4.0 Gateway Proxy<br/>inject server token"]
        P5["5.0 Persist & Stream<br/>save + forward to client"]
        P6["6.0 Async Summarizer<br/>compress old context"]
    end

    subgraph Stores
        D1[("D1: users<br/>api_keys")]
        D2[("D2: rate_limit<br/>(Redis)")]
        D3[("D3: messages<br/>summaries")]
        D4[("D4: secrets vault<br/>(encrypted)")]
        D5[("D5: audit_log")]
    end

    OC([OpenClaw Gateway])

    P1 <-->|lookup user| D1
    P1 -->|action| D5

    P2 <-->|increment counter| D2

    P3 <-->|read history| D3

    P4 <-->|decrypt token| D4
    P4 <-->|stream messages| OC

    P5 -->|write msg| D3
    P5 -->|write audit| D5
    P5 -->|stream chunk| User

    P6 -->|read old msgs| D3
    P6 -->|write summary| D3

    P1 --> P2 --> P3 --> P4 --> P5
    P5 -.threshold reached.-> P6

    style P4 fill:#dc2626,color:#fff
    style D4 fill:#dc2626,color:#fff
```

---

## ER Diagram

Database schema for multi-tenant chat platform.

```mermaid
erDiagram
    TENANTS ||--o{ USERS : has
    TENANTS ||--o{ INTEGRATIONS : configures
    TENANTS {
        uuid id PK
        string name
        text openclaw_token_encrypted
        string openclaw_url
        jsonb settings
        timestamp created_at
    }

    USERS ||--o{ API_KEYS : owns
    USERS ||--o{ CONVERSATIONS : creates
    USERS ||--o{ AUDIT_LOG : generates
    USERS {
        uuid id PK
        uuid tenant_id FK
        string email UK
        string password_hash
        string name
        timestamp created_at
    }

    API_KEYS {
        uuid id PK
        uuid user_id FK
        string key_hash UK
        string name
        jsonb scopes
        timestamp last_used_at
        boolean revoked
        timestamp created_at
    }

    CONVERSATIONS ||--o{ MESSAGES : contains
    CONVERSATIONS ||--o{ SUMMARIES : has
    CONVERSATIONS {
        uuid id PK
        uuid user_id FK
        uuid tenant_id FK
        string title
        text system_prompt
        boolean archived
        timestamp created_at
        timestamp updated_at
    }

    MESSAGES {
        uuid id PK
        uuid conversation_id FK
        enum role "user|assistant|system"
        text content
        int tokens_used
        string model
        jsonb metadata
        timestamp created_at
    }

    SUMMARIES {
        uuid id PK
        uuid conversation_id FK
        text summary
        uuid from_msg_id FK
        uuid to_msg_id FK
        timestamp created_at
    }

    AUDIT_LOG {
        uuid id PK
        uuid user_id FK
        string action
        string resource_type
        string resource_id
        string ip_address
        string user_agent
        jsonb details
        timestamp created_at
    }

    INTEGRATIONS {
        uuid id PK
        uuid tenant_id FK
        enum type "webhook|api|embed"
        jsonb config
        boolean enabled
        timestamp created_at
    }
```

**Key relationships:**

- **TENANTS** — Multi-tenant support; each tenant owns encrypted OpenClaw credentials
- **USERS** — Belong to a tenant; can create multiple conversations
- **API_KEYS** — Scoped credentials for third-party system integration (`chat:send`, `chat:read`, etc.)
- **CONVERSATIONS** — Hold messages and rolling summaries
- **SUMMARIES** — Compressed history for long conversations (context window management)
- **AUDIT_LOG** — Immutable record of sensitive operations
- **INTEGRATIONS** — Webhook endpoints and embed configurations

---

## Tech Stack

### Backend (BFF)

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | Node.js 20 + TypeScript | Familiar TS, mature ecosystem |
| Framework | Fastify | 2–3× faster than Express, native schema validation |
| WebSocket | `@fastify/websocket` | First-class Fastify integration |
| Auth | JWT (jose) + bcrypt + Refresh Token | Industry standard |
| ORM | Drizzle ORM | TypeScript-first, migration-friendly |
| Validation | Zod | End-to-end type safety |
| Secret Management | `node-vault` or env vars + KMS | Encrypt OpenClaw tokens at rest |

### Data Layer

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Primary DB | PostgreSQL 16 | Familiar; jsonb, full-text search |
| Cache | Redis 7 | Session, rate limit, context cache |
| Vector Search (optional) | pgvector | Future semantic search over long conversations |

### Frontend

| Component | Choice |
|-----------|--------|
| Framework | React 18 + TypeScript + Vite |
| UI | Tailwind + shadcn/ui |
| State | TanStack Query + Zustand |
| WebSocket Client | Native WebSocket + auto-reconnect |
| Markdown | react-markdown + highlight.js |

### DevOps

| Component | Choice |
|-----------|--------|
| Containerization | Docker + docker-compose |
| Reverse Proxy | Nginx or Caddy (auto HTTPS) |
| Process Mgmt | systemd or Docker `restart: always` |
| Logging | Pino → file + optional Grafana Loki |
| Monitoring | Prometheus + Grafana (optional) |

### Security

- **Token encryption** — OpenClaw token stored AES-256-GCM encrypted, key from env/KMS
- **Rate limiting** — Redis sliding window, per-user quota
- **CORS** — Strict allowlist
- **CSP headers** — XSS mitigation
- **API key scopes** — Fine-grained (`chat:send`, `chat:read`, `conversations:create`)
- **Audit log** — All write operations recorded

### Third-Party Integration Methods

| Method | Use Case |
|--------|----------|
| REST API + API Key | Backend-to-backend (CRM, ERP) |
| JS SDK + Embed Widget | One-line web embed |
| Webhook | Outbound event push |
| iframe Embed | Simplest embed |

---

## Project Structure

```
gateforge-parrot-openclaw/
├── packages/
│   ├── backend/              # Fastify BFF
│   │   ├── src/
│   │   │   ├── routes/       # REST + WS endpoints
│   │   │   ├── services/     # auth, chat, context, summarizer
│   │   │   ├── db/           # Drizzle schema + migrations
│   │   │   └── lib/          # OpenClaw client, crypto, redis
│   │   └── package.json
│   ├── frontend/             # React Web Chat UI
│   ├── sdk/                  # JS SDK for embedding
│   └── shared/               # Shared TypeScript types
├── docker-compose.yml        # PG + Redis + backend + frontend
├── nginx.conf
├── ARCHITECTURE.md           # This file
└── README.md
```

---

## Implementation Phases — Current State

| Phase | Scope | Status |
|-------|-------|--------|
| **Phase 0 — Design** | Architecture + SECURITY + USER_JOURNEYS + crypto PoC | ✅ Shipped |
| **Phase 1 — MVP** | Plugin skeleton, manifest, DB migration, JWT auth, bundled React UI | ✅ Shipped |
| **Phase 2 — Integration API** | Sessions + scoped API keys + webhooks + SSE streaming + rate limiting + idempotency + OpenAPI 3.1 + SDK + 29 endpoints, drift-checked | ✅ Shipped |
| **Phase 3 — Admin UI** | Three-tab admin panel (`?admin=1`) + assistant SSE streaming in the chat UI + audit chain verifier | ✅ Shipped |
| **Phase 4 — Embed** | `<script>` drop-in widget + iframe host SDK + postMessage bridge | ⏳ Next |
| **Phase 5 — Tooling** | Audit log verification CLI + password recovery via Shamir shards | ⏳ Planned |
| **Phase 6 — Distribution** | Publish to ClawHub registry + npm release of `@gateforge/parrot-sdk` | ⏳ Planned |

### Phase 3 — Admin panel state machine

The admin panel lives at `/gateforge-parrot/ui?admin=1` and shares the chat UI's JWT session. Tab state is local; one-time secrets (API key plaintext, webhook HMAC seed) are revealed exactly once in a banner and never persisted.

```mermaid
stateDiagram-v2
    [*] --> Chat
    Chat --> Admin: ?admin=1
    Admin --> Chat: ?admin=0 / back

    state Admin {
        [*] --> ApiKeys
        ApiKeys --> ApiKeys_Issue: New key
        ApiKeys_Issue --> ApiKeys_Reveal: 201 (plaintext token)
        ApiKeys_Reveal --> ApiKeys: dismiss banner
        ApiKeys --> ApiKeys_Edit: Edit row
        ApiKeys_Edit --> ApiKeys: save / cancel
        ApiKeys --> Webhooks: tab
        Webhooks --> Webhooks_Create: New webhook
        Webhooks_Create --> Webhooks_Reveal: 201 (HMAC secret)
        Webhooks_Reveal --> Webhooks: dismiss banner
        Webhooks --> Webhooks_Deliveries: expand row
        Webhooks_Deliveries --> Webhooks: collapse
        Webhooks --> Audit: tab
        Audit --> Audit_Verify: Verify chain
        Audit_Verify --> Audit: ok | break (banner)
    }
```

### Phase 3 — SSE streaming sequence

The bundled chat UI now streams assistant tokens through `POST /conversations/:id/messages/stream`. Plaintext exists only in OpenClaw's process for the lifetime of the request — every frame is re-encrypted with the conversation key before it hits the wire.

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant UI as Chat UI<br/>(Browser)
    participant API as Parrot REST<br/>(POST /messages/stream)
    participant Hook as llm_input / llm_output<br/>(Plugin hooks)
    participant Agent as OpenClaw Agent

    User->>UI: type message
    UI->>UI: AES-256-GCM encrypt w/ Conv Key
    UI->>API: POST /messages/stream<br/>(ciphertext + Idempotency-Key)
    API->>Hook: llm_input(plaintext, in-memory)
    Hook->>Agent: prompt + history
    loop per token
        Agent-->>Hook: token (plaintext)
        Hook-->>API: emit chunk
        API-->>UI: event: chunk<br/>data: { ciphertext }
        UI->>UI: decrypt + append to bubble
    end
    Agent-->>Hook: end of stream
    Hook-->>API: persist final ciphertext
    API-->>UI: event: done<br/>data: { messageId }
    UI->>UI: rename placeholder bubble<br/>id = messageId
```

---

## How to Render These Diagrams

All diagrams in this document use **Mermaid** syntax.

- **GitHub / GitLab** — render natively in Markdown previews
- **Notion** — paste as `/code` block with language `mermaid`
- **VS Code** — install `Markdown Preview Mermaid Support` extension
- **Live editor** — [mermaid.live](https://mermaid.live) for interactive editing
- **CLI export** — `npm install -g @mermaid-js/mermaid-cli` then `mmdc -i ARCHITECTURE.md -o out.pdf`

---

*Architecture document for the GateForge Parrot — secure proxy + persistence layer over OpenClaw Gateway.*
