/**
 * App-wide state container. Persists the auth tokens (in localStorage) but
 * NEVER persists the in-memory master key — it must be re-derived from the
 * user's password on every page load.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface UserInfo {
  id: string;
  email: string;
  tenantId: string;
}

interface PersistedState {
  accessToken: string | null;
  refreshToken: string | null;
  accessTokenExp: number | null;
  user: UserInfo | null;
  /** Wrapped master key returned by the server at login. */
  wrappedMasterKey: string | null;
  /** KDF params (salt + cost) needed to re-derive the KEK. */
  kdf: { salt: string; memoryCostKiB: number; timeCost: number; parallelism: number } | null;
}

interface EphemeralState {
  /** In-memory KEK derived in the current session. Null while locked. */
  kek: CryptoKey | null;
  /** In-memory master key (AES-GCM CryptoKey) after unwrap. */
  masterKey: CryptoKey | null;
}

interface Actions {
  setSession: (
    s: Pick<PersistedState, "accessToken" | "refreshToken" | "accessTokenExp" | "user" | "wrappedMasterKey" | "kdf">,
  ) => void;
  setUnlocked: (kek: CryptoKey, masterKey: CryptoKey) => void;
  lock: () => void;
  logout: () => void;
  isUnlocked: () => boolean;
}

type Store = PersistedState & EphemeralState & Actions;

export const useStore = create<Store>()(
  persist(
    (set, get) => ({
      // persisted
      accessToken: null,
      refreshToken: null,
      accessTokenExp: null,
      user: null,
      wrappedMasterKey: null,
      kdf: null,
      // ephemeral
      kek: null,
      masterKey: null,
      // actions
      setSession: (s) =>
        set({
          accessToken: s.accessToken,
          refreshToken: s.refreshToken,
          accessTokenExp: s.accessTokenExp,
          user: s.user,
          wrappedMasterKey: s.wrappedMasterKey,
          kdf: s.kdf,
        }),
      setUnlocked: (kek, masterKey) => set({ kek, masterKey }),
      lock: () => set({ kek: null, masterKey: null }),
      logout: () =>
        set({
          accessToken: null,
          refreshToken: null,
          accessTokenExp: null,
          user: null,
          wrappedMasterKey: null,
          kdf: null,
          kek: null,
          masterKey: null,
        }),
      isUnlocked: () => Boolean(get().masterKey),
    }),
    {
      name: "gateforge-parrot.session",
      partialize: (s) => ({
        accessToken: s.accessToken,
        refreshToken: s.refreshToken,
        accessTokenExp: s.accessTokenExp,
        user: s.user,
        wrappedMasterKey: s.wrappedMasterKey,
        kdf: s.kdf,
      }),
    },
  ),
);
