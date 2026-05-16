/**
 * Root component. Routes between:
 *  - <Auth>     when there is no session OR the master key is not unlocked
 *  - <Chat>     when the user is fully signed-in and unlocked
 */
import { useEffect } from "react";
import { useStore } from "./lib/store";
import { Auth } from "./pages/Auth";
import { Chat } from "./pages/Chat";

export function App() {
  const accessToken = useStore((s) => s.accessToken);
  const masterKey = useStore((s) => s.masterKey);
  const accessTokenExp = useStore((s) => s.accessTokenExp);
  const lock = useStore((s) => s.lock);

  // Lock crypto state if the access token has expired (forces re-derive).
  useEffect(() => {
    if (!accessTokenExp) return;
    const now = Math.floor(Date.now() / 1000);
    if (accessTokenExp < now) lock();
  }, [accessTokenExp, lock]);

  if (!accessToken || !masterKey) return <Auth />;
  return <Chat />;
}
