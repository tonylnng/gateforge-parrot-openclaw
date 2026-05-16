/**
 * Root component. Routes between:
 *  - <Auth>     when there is no session OR the master key is not unlocked
 *  - <Chat>     when the user is fully signed-in and unlocked
 */
import { useEffect, useState } from "react";
import { useStore } from "./lib/store";
import { Auth } from "./pages/Auth";
import { Chat } from "./pages/Chat";
import { Admin } from "./pages/Admin";

function useRoute(): { route: "chat" | "admin"; navigate: (r: "chat" | "admin") => void } {
  const read = () =>
    new URLSearchParams(window.location.search).get("admin") ? "admin" : "chat";
  const [route, setRoute] = useState<"chat" | "admin">(read());
  useEffect(() => {
    const onPop = () => setRoute(read());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = (r: "chat" | "admin") => {
    const url = new URL(window.location.href);
    if (r === "admin") url.searchParams.set("admin", "1");
    else url.searchParams.delete("admin");
    window.history.pushState({}, "", url.toString());
    setRoute(r);
  };
  return { route, navigate };
}

export function App() {
  const accessToken = useStore((s) => s.accessToken);
  const masterKey = useStore((s) => s.masterKey);
  const accessTokenExp = useStore((s) => s.accessTokenExp);
  const lock = useStore((s) => s.lock);
  const { route, navigate } = useRoute();

  // Lock crypto state if the access token has expired (forces re-derive).
  useEffect(() => {
    if (!accessTokenExp) return;
    const now = Math.floor(Date.now() / 1000);
    if (accessTokenExp < now) lock();
  }, [accessTokenExp, lock]);

  if (!accessToken || !masterKey) return <Auth />;
  if (route === "admin") return <Admin onBack={() => navigate("chat")} />;
  return <Chat onOpenAdmin={() => navigate("admin")} />;
}
