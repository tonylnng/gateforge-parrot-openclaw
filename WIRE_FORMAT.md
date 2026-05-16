# GateForge Parrot — Wire Format

Byte-level contract for clients that **cannot** use the official
`@gateforge/parrot-sdk` (e.g. native mobile, Go, Rust, Python). The
JavaScript SDK is the reference implementation — when in doubt, read its
source under `packages/parrot-sdk/src/crypto.ts`.

This document is **normative**. The server enforces ciphertext-only
storage, so any non-conforming client will either fail to decrypt or
have its requests rejected with `validation_error`.

---

## 1. Threat model recap

The Parrot server is **zero-knowledge**:

- The server stores ciphertext only. It never sees a plaintext message,
  session title, attachment, or any derived metadata that would leak
  plaintext content.
- All keys live on the client. The server holds **wrapped** copies of
  conversation keys (wrapped with the user's master key), which the
  server itself cannot unwrap.
- The KDF (Argon2id) runs in the browser/native client; the password
  never leaves the device.

Anything that contradicts the rules below breaks the threat model. Do
not invent shortcuts.

---

## 2. Key hierarchy

```
passphrase
   │
   ▼ Argon2id (m=64 MiB, t=3, p=4, salt=<32 bytes random per user>)
   │
master key (256-bit AES-KW)
   │
   ▼ AES-KW wrap
   │
conversation key (256-bit AES-GCM)
   │
   ▼ AES-256-GCM (random 96-bit IV per message)
   │
message ciphertext / title ciphertext
```

| Layer              | Algorithm             | Size      | Notes                                                |
|--------------------|-----------------------|-----------|------------------------------------------------------|
| KDF                | Argon2id              | 32 bytes  | `m=65536` KiB, `t=3`, `p=4`. Salt stored server-side, never reused. |
| Master key wrap    | AES Key Wrap (RFC 3394) | 32 bytes (wrapped 40) | One per user. Stored under `users.wrappedMasterKey`. |
| Conversation key   | AES-256-GCM           | 32 bytes  | Generated client-side per conversation.              |
| Conversation wrap  | AES Key Wrap          | 40 bytes  | Stored under `conversations.wrappedConversationKey`. |
| Message body       | AES-256-GCM           | n         | `iv ‖ ct ‖ tag` then base64.                         |
| Title              | AES-256-GCM           | n         | Same envelope as message body.                       |

### 2.1 Argon2id parameters

```
type    = Argon2id
memory  = 65536  (KiB, = 64 MiB)
iters   = 3
paral   = 4
keyLen  = 32     (bytes)
salt    = 32 bytes, CSPRNG, unique per user
```

The server returns the salt during `/auth/me` (or your auth bootstrap
flow) so the same key can be re-derived on any device.

### 2.2 AES Key Wrap

Standard RFC 3394 with a 256-bit KEK. Output is 8 bytes longer than the
plaintext key (40 bytes for a 32-byte key). Stored as **base64**
(unpadded standard, not URL-safe) in the JSON envelopes.

### 2.3 AES-256-GCM message envelope

```
plaintext   = UTF-8(<message-json>)
iv          = 12 bytes CSPRNG, unique per encryption
aad         = (none)
ciphertext  = AES-256-GCM(K_conv, iv, plaintext, aad)
tag         = 16 bytes (appended to ciphertext by WebCrypto)

wire bytes  = iv ‖ ciphertext ‖ tag
wire string = base64(wire bytes)   // RFC 4648, padded, NOT url-safe
```

> WebCrypto returns `ciphertext + tag` concatenated. When porting to
> libraries that split them (libsodium, Go `crypto/cipher`), make sure
> the final wire layout is **iv (12) ‖ ct (n) ‖ tag (16)**.

Decryption is the inverse: base64-decode → slice `iv = bytes[0..12]`,
`tag = bytes[len-16..]`, `ct = bytes[12..len-16]`.

### 2.4 Message plaintext shape

The plaintext inside the envelope is JSON:

```json
{
  "v": 1,
  "role": "user" | "assistant" | "system",
  "content": "string",
  "ts": 1715000000000,
  "meta": { "...optional client-defined..." }
}
```

`v` is the schema version. Bump it if you change shape.

Titles use the same envelope but the plaintext is a bare JSON string:

```json
"My research session"
```

---

## 3. REST envelopes

Base URL: `{publicBaseUrl}/gateforge-parrot/api/v1`

### 3.1 Auth

Bearer tokens, two flavours:

- **User JWT** — issued by the host (OpenClaw / your IdP). Used by the
  first-party UI.
- **API key** — issued via `POST /apikeys`. Token returned **once**, in
  the form `pk_<env>_<random>.<secret>`. Server stores
  `sha256(secret)` only.

```
Authorization: Bearer <jwt-or-api-key>
```

### 3.2 Required headers

| Header                | When                       | Notes                                                                 |
|-----------------------|----------------------------|-----------------------------------------------------------------------|
| `Authorization`       | Always                     | See above.                                                            |
| `Content-Type`        | On bodies                  | `application/json; charset=utf-8`.                                    |
| `Idempotency-Key`     | On non-idempotent writes   | Any opaque ≤ 128 chars. Server caches the response for 24 h.          |
| `X-Tenant`            | Multi-tenant deployments   | Optional, scoped by API key already.                                  |
| `X-Request-Id`        | Optional, any request      | Echoed back as `X-Parrot-Request-Id`. Server generates one otherwise. |

Every response includes:

| Header                  | Notes                                                                |
|-------------------------|----------------------------------------------------------------------|
| `X-Parrot-Request-Id`   | Opaque trace ID. Quote when filing support tickets.                  |
| `X-RateLimit-Limit`     | Current per-key window cap.                                          |
| `X-RateLimit-Remaining` | Tokens left in the per-key bucket.                                   |
| `X-RateLimit-Reset`     | Unix seconds at which the bucket fully refills.                      |

### 3.3 Conversation create

```
POST /conversations
{
  "wrappedConversationKey": "<base64 RFC 3394>",
  "encryptedTitle":         "<base64 iv‖ct‖tag>",
  "model":                  "claude-sonnet-4",
  "metadata":               { "any": "json" }
}
```

Response:

```json
{
  "id": "conv_01HX...",
  "createdAt": "2026-05-16T14:00:00Z",
  "pinned": false,
  "archived": false,
  "messageCount": 0
}
```

### 3.4 Send message

```
POST /conversations/{id}/messages
Idempotency-Key: <opaque>
{
  "encryptedContent": "<base64 iv‖ct‖tag>",
  "role":             "user",
  "clientTs":         1715000000000
}
```

### 3.5 Streaming

```
POST /conversations/{id}/messages/stream
Accept: text/event-stream
Idempotency-Key: <opaque>
{ "encryptedContent": "<base64>", "role": "user" }
```

Server replies `200 text/event-stream` with frames described in §5.

### 3.6 Patch / delete

```
PATCH  /conversations/{id}    { "title?": "<base64>", "pinned?": bool, "archived?": bool }
DELETE /conversations/{id}                                # crypto-shred
```

DELETE wipes the message rows **and** nulls
`wrappedConversationKey`. The conversation row stays for audit but
becomes permanently unreadable.

### 3.7 Errors

All errors return:

```json
{
  "error": {
    "code":      "validation_error" | "unauthorized" | "forbidden"
               | "rate_limited"    | "not_found"   | "conflict"
               | "internal_error",
    "message":   "human-readable",
    "details":   { "...optional..." },
    "requestId": "<same value as X-Parrot-Request-Id>"
  }
}
```

HTTP status mirrors the code (`400`, `401`, `403`, `404`, `409`, `429`,
`500`).

---

## 4. Pagination

List endpoints (`GET /conversations`, `GET /conversations/{id}/messages`,
`GET /apikeys`, `GET /webhooks`) accept:

```
?limit=<1..200>   default 50
?cursor=<opaque>  pass `nextCursor` from previous response
?filter=pinned|archived|all   (conversations only)
?q=<encrypted-title-prefix>   (conversations only, server can only
                               match exact ciphertext, so this is rarely useful;
                               client-side search is recommended)
```

Response:

```json
{
  "items":      [ ... ],
  "nextCursor": "opaque or null"
}
```

Cursors are opaque. Do not parse them.

---

## 5. Server-Sent Events (SSE)

Stream endpoint: `POST /conversations/{id}/messages/stream`

The body contains the *user* message ciphertext. The response is the
assistant message streamed token-by-token (still ciphertext).

### 5.1 Frame format

```
event: <event-name>
data:  <json>

```

(blank line terminates each frame, exactly one `\n\n`).

Heartbeats are sent as SSE comments (lines starting with `:`) every
~15 s:

```
: heartbeat 1715000000000

```

### 5.2 Event sequence

| Event            | Payload                                                                  |
|------------------|--------------------------------------------------------------------------|
| `stream.start`   | `{ "messageId": "msg_…", "model": "claude-…" }`                          |
| `stream.delta`   | `{ "encryptedDelta": "<base64 iv‖ct‖tag>", "seq": 0 }`                   |
| `stream.usage`   | `{ "promptTokens": 123, "completionTokens": 45 }` (optional, may repeat) |
| `stream.end`     | `{ "messageId": "msg_…", "encryptedContent": "<base64 final body>" }`    |
| `stream.error`   | `{ "code": "...", "message": "..." }` (terminates the stream)            |

Notes:

- `seq` increases monotonically per stream. Gaps mean the channel
  dropped — reconnect via `Last-Event-Id` (server keeps the last 256
  deltas in memory, 5 min).
- Each `encryptedDelta` is an **independent** AES-256-GCM envelope
  using the same conversation key but a **fresh IV**. Concatenate
  the decrypted plaintexts in `seq` order.
- The final `stream.end` contains the **whole** assistant message as a
  single envelope, suitable for storage. Either accumulate deltas or
  use `stream.end` — both must agree.

### 5.3 Passthrough fallback

If the upstream model adapter does not stream, the server emits one
`stream.delta` every ~250 ms with whatever bytes have arrived, then
the usual `stream.end`. Clients should not distinguish the two cases.

---

## 6. Webhooks

### 6.1 Subscription

```
POST /webhooks
{
  "url":     "https://your-host/parrot-hook",
  "events":  ["session.created", "message.completed", ...],
  "secret":  "<32+ random bytes, base64>"   // optional, server generates if absent
}
```

Server blocks RFC 1918 / loopback / link-local URLs unless
`config.allowPrivateWebhooks=true`.

### 6.2 Delivery

```
POST <subscribed-url>
Content-Type: application/json
User-Agent:   gateforge-parrot/0.1.0
X-Parrot-Event:     message.completed
X-Parrot-Delivery:  <ulid>
X-Parrot-Timestamp: <unix-seconds>
X-Parrot-Signature: t=<unix-seconds>,v1=<hex-hmac>

{ "event": "...", "id": "...", "occurredAt": "...", "data": { ...metadata only... } }
```

**No ciphertext or plaintext is ever in the payload.** Only IDs,
counts, timestamps, and event-specific metadata.

### 6.3 Signature verification

```
mac    = HMAC_SHA256(secret, f"{t}.{rawBody}")
expect = "v1=" + hex(mac)
```

The header is `X-Parrot-Signature: t=<t>,v1=<hex>`. Compare with
constant time. Reject if `|now − t| > 300 s` to limit replay.

Pseudocode:

```python
import hmac, hashlib, time

def verify(secret, raw_body, header, now=None):
    parts = dict(p.split('=', 1) for p in header.split(','))
    t = int(parts['t'])
    if abs((now or time.time()) - t) > 300:
        return False
    mac = hmac.new(secret, f"{t}.{raw_body}".encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(mac, parts['v1'])
```

### 6.4 Retry schedule

The dispatcher retries on any non-2xx (or transport error) with
exponential backoff:

```
0s, 30s, 2m, 10m, 30m, 1h, 4h, 12h
```

After 12 consecutive failures the subscription is auto-disabled and
an `audit.alert` is fired. Each delivery has a 10 s socket timeout.

### 6.5 Event catalogue

```
session.created       session.renamed     session.archived     session.deleted
message.received      message.completed   message.failed
apikey.used           apikey.revoked
audit.alert           webhook.ping
```

`webhook.ping` is sent by `POST /webhooks/{id}/test`. Use it during
provisioning to confirm both transport and signature checks.

---

## 7. API key format

```
pk_<env>_<random>.<secret>

env       = "live" | "test"
random    = 16 bytes base32-no-pad (public identifier — safe to log)
secret    = 32 bytes base32-no-pad (kept by the caller, server stores sha256)
```

Examples:

```
pk_live_2N7QF…JX.4HSE…ZP
pk_test_AAAA…AA.BBBB…BB
```

Auth check: take the prefix up to the dot, look up the key by
`prefix`, sha256 the secret, compare with stored hash (constant time),
then enforce scope.

Scope catalogue (deny-by-default):

```
conversations:read     conversations:write    conversations:delete
messages:read          messages:send          messages:stream
apikeys:manage         webhooks:manage
audit:read             agents:read
```

---

## 8. Rate limiting

Two token-buckets per request:

- Per API key (or per user JWT): default **60 req / minute**, burst 30.
- Per tenant: default **600 req / minute**, burst 300.

Excess responses are `429 rate_limited` with:

```
Retry-After: <seconds>
X-RateLimit-Remaining: 0
X-RateLimit-Reset:     <unix-seconds>
```

Streaming connections count once at start, not per delta.

---

## 9. Idempotency

`POST /conversations`, `POST /conversations/{id}/messages`, and the
stream endpoint honour `Idempotency-Key`. The server caches the
**status code + body** for 24 h keyed by
`sha256(tenant ‖ principal ‖ key ‖ path)`. Replays return the original
response byte-for-byte; conflicting bodies under the same key return
`409 conflict`.

Idempotency-Key has no required format beyond being printable ASCII,
≤ 128 chars. A UUIDv7 or ULID is recommended.

---

## 10. Versioning

- **Wire version:** the URL contains `/v1`. Breaking changes get a new
  major (`/v2`).
- **Crypto version:** the in-envelope `v` field. Bump when changing
  plaintext shape, algorithms, or KDF parameters. The server is
  opaque to this number — it just stores ciphertext.
- **Schema version:** see `CHANGELOG.md`.

Until version 1.0.0 of this package, **breaking changes can land
without notice** (no production users yet). After 1.0.0, the standard
deprecation rules apply: ≥ 90 days notice via response headers
(`Deprecation`, `Sunset`).

---

## 11. Reference implementation

The canonical implementation lives at:

```
packages/parrot-sdk/src/crypto.ts
packages/parrot-sdk/src/index.ts
```

Anything ambiguous in this document should be cross-checked against
that code. Bug reports welcome at
<https://github.com/tonylnng/gateforge-parrot-openclaw/issues>.
