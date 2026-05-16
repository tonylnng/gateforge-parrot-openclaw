# E2EE Crypto PoC

Standalone proof-of-concept for the E2EE design described in `../SECURITY.md`.

## Files

- `crypto.ts` — Web Crypto + Argon2id implementation. Browser-only.

## Setup

```bash
mkdir openclaw-poc && cd openclaw-poc
npm init -y
npm install hash-wasm
npm install -D typescript vite
npx tsc --init
# Copy crypto.ts into src/
```

## Run the demo

Create `src/main.ts`:

```ts
import { demo, demoTamper } from "./crypto";

(async () => {
  const result = await demo();
  console.log("Round-trip match:", result.match);

  const tamper = await demoTamper();
  console.log("Tampering caught:", tamper.caught, tamper.error);
})();
```

Then `npx vite` and open the dev URL. Check browser console.

## What this proves

- Argon2id KDF derives a Master Key entirely in the browser
- A Conversation Key wrapped with the Master Key is unreadable without the password
- Messages encrypted with AES-256-GCM round-trip correctly
- AES-GCM auth tag rejects tampered ciphertext
- All keys are **non-extractable** CryptoKey objects (cannot be serialized out)

## What this does NOT yet include

- Server-side persistence
- Recovery passphrase wrap
- X25519 conversation sharing
- Idle lock / key zeroization on tab hide
- Replay-protection (server-side nonce tracking)

These are added during Phase 2.5+ implementation per `SECURITY.md`.
