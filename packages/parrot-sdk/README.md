# @gateforge/parrot-sdk

Client SDK for [GateForge Parrot](https://github.com/tonylnng/gateforge-parrot-openclaw) — a zero-knowledge end-to-end encrypted chat plugin for OpenClaw.

The SDK is **ciphertext-only**. Your application is responsible for deriving the master key from the user's password using Argon2id with parameters served by the API, then unwrapping per-conversation keys before encrypting outgoing messages or decrypting incoming ones. The SDK provides the AES-KW + AES-256-GCM primitives via `@gateforge/parrot-sdk/crypto`.

## Install

```bash
npm install @gateforge/parrot-sdk
```

## Quickstart

```ts
import { ParrotClient, encryptMessage, decryptMessage, unwrapContentKey, importKekForWrap } from "@gateforge/parrot-sdk";

const client = new ParrotClient({
  baseUrl: "https://gw.example.com/gateforge-parrot/api/v1",
  apiKey: "pk_live_xxxx.yyyy", // or accessToken: "<jwt>"
});

// List sessions
const sessions = await client.listSessions("active");

// Unwrap a conversation key (browser-derived KEK)
const kek = await importKekForWrap(rawMasterKeyBytes); // bytes you derived from Argon2id
const convKey = await unwrapContentKey(kek, sessions[0].wrappedConversationKey);

// Send a ciphertext message
const ct = await encryptMessage(convKey, "Hello, world!");
await client.sendMessage(sessions[0].id, { ciphertext: ct, idempotencyKey: crypto.randomUUID() });

// Stream an assistant response
for await (const frame of client.streamMessage(sessions[0].id, { ciphertext: ct })) {
  if (frame.event === "chunk") {
    const plaintext = await decryptMessage(convKey, frame.data.delta);
    process.stdout.write(plaintext);
  }
}
```

## API surface

| Method | Description |
| --- | --- |
| `listSessions(filter?)` | active \| pinned \| archived \| all |
| `createSession(input)` | requires `wrappedConversationKey` (base64 AES-KW) |
| `patchSession(id, patch)` | rename, pin, archive |
| `deleteSession(id)` | crypto-shred — irreversible |
| `listMessages(sessionId)` | returns ciphertext rows |
| `sendMessage(sessionId, input)` | append ciphertext message |
| `streamMessage(sessionId, input)` | async iterator over SSE frames |
| `listApiKeys()` / `issueApiKey()` / `revokeApiKey(id)` | manage API keys |
| `listWebhooks()` / `createWebhook()` / `patchWebhook()` / `deleteWebhook()` / `testWebhook()` | manage webhooks |

## Webhook signing

Verify incoming webhook deliveries with the per-row signing secret:

```ts
import { verifyWebhookSignature } from "@gateforge/parrot-sdk/crypto";

const ok = await verifyWebhookSignature(
  webhookSecret,
  req.headers["x-parrot-signature"],
  rawRequestBody,
);
if (!ok) return res.status(401).end();
```

Webhook payloads are **metadata-only** — they never contain plaintext content.

## License

MIT
