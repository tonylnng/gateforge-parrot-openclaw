/**
 * Sign-up and login flow.
 *
 * On sign-up:
 *   1. Generate a random 16-byte KDF salt.
 *   2. Derive KEK = Argon2id(password, salt, params) in the browser.
 *   3. Generate a fresh AES-256 master key.
 *   4. Wrap(masterKey, KEK) via AES-KW.
 *   5. POST {email, password, kdfSalt, kdfParams, wrappedMasterKey} to server.
 *      The server stores a SEPARATE Argon2 hash of the password (for auth)
 *      plus the kdfSalt / wrappedMasterKey for later re-derivation.
 *
 * On login:
 *   1. POST {email, password} → server verifies password and returns
 *      kdfSalt, kdfParams, and wrappedMasterKey.
 *   2. Browser derives KEK and unwraps the master key.
 *
 * The server NEVER sees the master key plaintext.
 */
import { useState } from "react";
import { api, ApiError } from "../lib/api";
import {
  DEFAULT_KDF,
  deriveKek,
  generateMessageKey,
  generateSalt,
  unwrapKey,
  wrapKey,
} from "../lib/crypto";
import { useStore } from "../lib/store";

type Mode = "login" | "signup";

export function Auth() {
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [tenantId, setTenantId] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setSession = useStore((s) => s.setSession);
  const setUnlocked = useStore((s) => s.setUnlocked);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "signup") await doSignup();
      else await doLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setStatus(null);
    }
  }

  async function doSignup() {
    if (password.length < 12) throw new Error("Password must be at least 12 characters.");

    setStatus("Deriving encryption key (Argon2id)...");
    const salt = generateSalt(16);
    const kek = await deriveKek(password, { salt, ...DEFAULT_KDF });

    setStatus("Generating master key...");
    const masterKey = await generateMessageKey();
    const wrappedMasterKey = await wrapKey(masterKey, kek);

    setStatus("Creating account...");
    const resp = await api.signup({
      email,
      password,
      kdfSalt: salt,
      kdfMemoryCostKiB: DEFAULT_KDF.memoryCostKiB,
      kdfTimeCost: DEFAULT_KDF.timeCost,
      kdfParallelism: DEFAULT_KDF.parallelism,
      wrappedMasterKey,
      tenantId: tenantId || undefined,
    });

    setSession({
      accessToken: resp.accessToken,
      refreshToken: resp.refreshToken,
      accessTokenExp: resp.accessTokenExp,
      user: resp.user,
      wrappedMasterKey,
      kdf: { salt, ...DEFAULT_KDF },
    });
    setUnlocked(kek, masterKey);
  }

  async function doLogin() {
    setStatus("Verifying credentials...");
    let resp;
    try {
      resp = await api.login({ email, password, tenantId: tenantId || undefined });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) throw new Error("Invalid email or password.");
      throw e;
    }

    setStatus("Deriving encryption key (Argon2id)...");
    const kek = await deriveKek(password, {
      salt: resp.kdf.salt,
      memoryCostKiB: resp.kdf.memoryCostKiB,
      timeCost: resp.kdf.timeCost,
      parallelism: resp.kdf.parallelism,
    });

    setStatus("Unwrapping master key...");
    const masterKey = await unwrapKey(resp.wrappedMasterKey, kek);

    setSession({
      accessToken: resp.accessToken,
      refreshToken: resp.refreshToken,
      accessTokenExp: resp.accessTokenExp,
      user: resp.user,
      wrappedMasterKey: resp.wrappedMasterKey,
      kdf: resp.kdf,
    });
    setUnlocked(kek, masterKey);
  }

  return (
    <div className="auth-shell">
      <form className="auth-card" onSubmit={submit}>
        <h2>
          <span className="parrot-logo" aria-hidden>🦜</span> GateForge Parrot
        </h2>

        {error ? <div className="auth-error">{error}</div> : null}

        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password {mode === "signup" ? <span style={{ opacity: 0.7 }}>(min 12 chars)</span> : null}</label>
          <input
            id="password"
            type="password"
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            minLength={mode === "signup" ? 12 : 1}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
        </div>
        <div className="field">
          <label htmlFor="tenant">Workspace (optional)</label>
          <input
            id="tenant"
            type="text"
            placeholder="default"
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value)}
            disabled={busy}
          />
        </div>

        <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
          {busy ? (
            <span className="deriving">
              <span className="spinner" aria-hidden />
              {status ?? "Working..."}
            </span>
          ) : mode === "signup" ? (
            "Create account"
          ) : (
            "Sign in"
          )}
        </button>

        <p className="auth-hint">
          {mode === "signup" ? "Already have an account?" : "Need an account?"}{" "}
          <button
            type="button"
            className="auth-toggle"
            onClick={() => {
              setMode(mode === "signup" ? "login" : "signup");
              setError(null);
            }}
            disabled={busy}
          >
            {mode === "signup" ? "Sign in" : "Sign up"}
          </button>
        </p>

        <p className="auth-hint">
          🔐 Your password derives an encryption key in this browser. The server
          stores only the wrapped key and never sees your plaintext or master
          key. If you forget your password, your chats cannot be recovered.
        </p>
      </form>
    </div>
  );
}
